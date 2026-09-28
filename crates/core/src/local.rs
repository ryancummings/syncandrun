//! Bounded, symlink-free discovery of a personal music folder.
use crate::{
    Playlist, Track,
    plex::{LibraryOverview, PlaylistSummary},
};
use anyhow::{Context, Result, ensure};
use std::{
    fs,
    io::{self, Read},
    path::{Path, PathBuf},
    process::{Child, ChildStdout, Command, Stdio},
    sync::atomic::{AtomicBool, Ordering},
};

const MAX_DEPTH: usize = 8;
const MAX_FILES: usize = 10_000;
const MAX_DIRS: usize = 2_000;
const MAX_BYTES: u64 = 2 * 1024 * 1024 * 1024 * 1024;

fn audio_tool(name: &str) -> PathBuf {
    #[cfg(target_os = "macos")]
    if let Ok(executable) = std::env::current_exe()
        && let Some(directory) = executable.parent()
    {
        let bundled = directory.join(name);
        if bundled.is_file() {
            return bundled;
        }
    }
    PathBuf::from(name)
}

fn cancelled(cancel: &AtomicBool) -> Result<()> {
    ensure!(!cancel.load(Ordering::Relaxed), "Music discovery cancelled");
    Ok(())
}
fn duration(path: &Path) -> Result<u64> {
    let output = Command::new(audio_tool("ffprobe"))
        .args([
            "-v",
            "error",
            "-select_streams",
            "a:0",
            "-show_entries",
            "format=duration",
            "-of",
            "default=noprint_wrappers=1:nokey=1",
        ])
        .arg(path)
        .stdin(Stdio::null())
        .output()
        .context("Install ffprobe to inspect local music")?;
    ensure!(
        output.status.success(),
        "Could not read local audio duration"
    );
    let value = String::from_utf8(output.stdout).context("Invalid local audio duration")?;
    let seconds: f64 = value
        .trim()
        .parse()
        .context("Invalid local audio duration")?;
    ensure!(
        seconds.is_finite() && seconds > 0.0 && seconds < 24.0 * 60.0 * 60.0,
        "Invalid local audio duration"
    );
    Ok(seconds.ceil() as u64)
}

pub fn discover(root: &Path, cancel: &AtomicBool) -> Result<Vec<Playlist>> {
    let root = root
        .canonicalize()
        .context("Local music folder is unavailable")?;
    ensure!(root.is_dir(), "Local music source must be a folder");
    let mut pending = vec![(root.clone(), 0usize)];
    let mut groups = std::collections::BTreeMap::<String, Vec<Track>>::new();
    let (mut dirs, mut files, mut bytes) = (0usize, 0usize, 0u64);
    while let Some((dir, depth)) = pending.pop() {
        cancelled(cancel)?;
        dirs += 1;
        ensure!(
            dirs <= MAX_DIRS,
            "Local music folder contains too many directories"
        );
        for entry in fs::read_dir(&dir)? {
            cancelled(cancel)?;
            let entry = entry?;
            let ty = entry.file_type()?;
            if ty.is_symlink() {
                continue;
            }
            if ty.is_dir() {
                ensure!(depth < MAX_DEPTH, "Local music folder is too deep");
                pending.push((entry.path(), depth + 1));
                continue;
            }
            if !ty.is_file() {
                continue;
            }
            let path = entry.path();
            let extension = path.extension().and_then(|s| s.to_str()).unwrap_or("");
            if !extension.eq_ignore_ascii_case("mp3") && !extension.eq_ignore_ascii_case("flac") {
                continue;
            }
            let metadata = entry.metadata()?;
            files += 1;
            bytes = bytes
                .checked_add(metadata.len())
                .context("Local music size overflow")?;
            ensure!(
                files <= MAX_FILES && bytes <= MAX_BYTES,
                "Local music folder exceeds the discovery limit"
            );
            let relative = path.strip_prefix(&root)?;
            let parent = relative.parent().unwrap_or(Path::new(""));
            let group = if parent.as_os_str().is_empty() {
                ".".to_string()
            } else {
                parent.to_string_lossy().to_string()
            };
            let name = path.file_stem().unwrap().to_string_lossy().to_string();
            let relative = relative.to_string_lossy().to_string();
            let duration_seconds = duration(&path)?;
            groups.entry(group).or_default().push(Track {
                id: format!("local:track:{relative}"),
                rating_key: relative,
                title: name,
                artist: "Unknown artist".into(),
                album: "Local folder".into(),
                duration_seconds,
            });
        }
    }
    ensure!(
        !groups.is_empty(),
        "No MP3 or FLAC files found in the local music folder"
    );
    ensure!(
        groups.len() <= 500,
        "Local music folder has too many playlist groups"
    );
    Ok(groups
        .into_iter()
        .map(|(group, mut tracks)| {
            tracks.sort_by(|a, b| a.rating_key.cmp(&b.rating_key));
            let title = if group == "." {
                root.file_name()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .to_string()
            } else {
                group.clone()
            };
            Playlist {
                id: format!("local:folder:{group}"),
                title,
                tracks,
            }
        })
        .collect())
}

pub fn summaries(root: &Path, cancel: &AtomicBool) -> Result<Vec<PlaylistSummary>> {
    Ok(discover(root, cancel)?
        .into_iter()
        .map(|p| PlaylistSummary {
            id: p.id,
            title: p.title,
            track_count: p.tracks.len() as u64,
            duration_seconds: p.tracks.iter().map(|t| t.duration_seconds).sum(),
        })
        .collect())
}

pub fn overview(root: &Path) -> LibraryOverview {
    LibraryOverview {
        server_name: None,
        server_version: None,
        library_name: root.file_name().map(|s| s.to_string_lossy().to_string()),
        library_tracks: None,
    }
}

struct Transcoded {
    child: Child,
    stdout: ChildStdout,
}
impl Read for Transcoded {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        let n = self.stdout.read(buf)?;
        if n == 0 && !self.child.wait()?.success() {
            return Err(io::Error::other("Local audio transcoding failed"));
        }
        Ok(n)
    }
}
impl Drop for Transcoded {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

pub fn audio(root: &Path, track: &Track, bitrate: u16) -> Result<Box<dyn Read>> {
    ensure!(crate::BITRATES.contains(&bitrate), "Invalid MP3 bitrate");
    ensure!(
        track.id == format!("local:track:{}", track.rating_key),
        "Track belongs to a different music source"
    );
    let relative = Path::new(&track.rating_key);
    ensure!(
        !relative.is_absolute()
            && relative
                .components()
                .all(|c| matches!(c, std::path::Component::Normal(_))),
        "Invalid local track path"
    );
    let canonical_root = root
        .canonicalize()
        .context("Local music folder is unavailable")?;
    let path: PathBuf = canonical_root
        .join(relative)
        .canonicalize()
        .context("Local track is unavailable")?;
    ensure!(
        path.starts_with(&canonical_root) && path.is_file(),
        "Local track escaped the selected folder"
    );
    let extension = path.extension().and_then(|s| s.to_str()).unwrap_or("");
    ensure!(
        extension.eq_ignore_ascii_case("mp3") || extension.eq_ignore_ascii_case("flac"),
        "Unsupported local audio format"
    );
    let mut child = Command::new(audio_tool("ffmpeg"))
        .args(["-nostdin", "-hide_banner", "-loglevel", "error", "-i"])
        .arg(&path)
        .args([
            "-map",
            "0:a:0",
            "-vn",
            "-ac",
            "2",
            "-codec:a",
            "libmp3lame",
            "-b:a",
            &format!("{bitrate}k"),
            "-f",
            "mp3",
            "pipe:1",
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .context("Install ffmpeg with libmp3lame to transfer local music")?;
    let stdout = child
        .stdout
        .take()
        .context("Could not read local audio transcoder")?;
    Ok(Box::new(Transcoded { child, stdout }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        export::{self, Route},
        profile::{Profile, Provider},
    };
    use tempfile::tempdir;

    fn tone(path: &Path, codec: &str) {
        assert!(
            Command::new(audio_tool("ffmpeg"))
                .args([
                    "-nostdin",
                    "-loglevel",
                    "error",
                    "-f",
                    "lavfi",
                    "-i",
                    "sine=frequency=440:duration=2",
                    "-c:a",
                    codec,
                    "-y"
                ])
                .arg(path)
                .status()
                .unwrap()
                .success()
        );
    }

    #[test]
    fn discovery_estimate_and_transcode_use_isolated_files() {
        let temp = tempdir().unwrap();
        let root = temp.path().join("Test Album");
        fs::create_dir(&root).unwrap();
        tone(&root.join("one.flac"), "flac");
        let nested = root.join("Disc 2");
        fs::create_dir(&nested).unwrap();
        tone(&nested.join("two.mp3"), "libmp3lame");
        #[cfg(unix)]
        std::os::unix::fs::symlink(&root, nested.join("loop")).unwrap();
        let cancel = AtomicBool::new(false);
        let groups = discover(&root, &cancel).unwrap();
        assert_eq!(groups.len(), 2);
        assert_eq!(groups[0].title, "Test Album");
        assert_eq!(groups[1].title, "Disc 2");
        assert_eq!(groups[0].id, "local:folder:.");
        assert!(
            groups
                .iter()
                .all(|p| p.tracks.iter().all(|t| t.duration_seconds >= 2))
        );
        let summaries = summaries(&root, &cancel).unwrap();
        assert!(summaries.iter().all(|s| s.duration_seconds >= 2));
        let low = export::estimate(&groups, 64, Route::Mtp).unwrap().bytes;
        let high = export::estimate(&groups, 192, Route::Mtp).unwrap().bytes;
        assert!(low > 0);
        assert_eq!(high, low * 3);
        let mut profile = Profile::open(temp.path().join("profile")).unwrap();
        profile.set_local_folder(&root).unwrap();
        assert_eq!(profile.active_provider().unwrap(), Provider::Local);
        profile.save_playlists(&groups).unwrap();
        assert_eq!(profile.plan(&[groups[0].id.clone()]).unwrap().len(), 1);
        let mut mp3 = Vec::new();
        audio(&root, &groups[0].tracks[0], 192)
            .unwrap()
            .read_to_end(&mut mp3)
            .unwrap();
        assert!(!mp3.is_empty());
        let mut original = Vec::new();
        audio(&root, &groups[1].tracks[0], 64)
            .unwrap()
            .read_to_end(&mut original)
            .unwrap();
        assert_ne!(original, fs::read(nested.join("two.mp3")).unwrap());
        let encoded = temp.path().join("encoded.mp3");
        fs::write(&encoded, &original).unwrap();
        let output = Command::new(audio_tool("ffprobe"))
            .args([
                "-v",
                "error",
                "-select_streams",
                "a:0",
                "-show_entries",
                "stream=bit_rate",
                "-of",
                "default=noprint_wrappers=1:nokey=1",
            ])
            .arg(&encoded)
            .output()
            .unwrap();
        assert!(output.status.success());
        assert_eq!(String::from_utf8(output.stdout).unwrap().trim(), "64000");
        let outside = crate::Track {
            rating_key: "../escape.mp3".into(),
            id: "local:track:../escape.mp3".into(),
            ..groups[0].tracks[0].clone()
        };
        assert!(audio(&root, &outside, 192).is_err());
        fs::write(root.join("one.flac"), b"broken synthetic audio").unwrap();
        let mut failed = Vec::new();
        let error = audio(&root, &groups[0].tracks[0], 192)
            .unwrap()
            .read_to_end(&mut failed)
            .unwrap_err();
        assert_eq!(error.to_string(), "Local audio transcoding failed");
        assert!(!error.to_string().contains("one.flac"));
    }
}
