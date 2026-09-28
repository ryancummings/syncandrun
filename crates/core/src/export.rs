use crate::{BITRATES, Playlist, Track};
use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::atomic::{AtomicBool, Ordering},
};
use unicode_normalization::UnicodeNormalization;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Route {
    Mtp,
    Express,
    Music,
}
impl std::str::FromStr for Route {
    type Err = anyhow::Error;
    fn from_str(v: &str) -> Result<Self> {
        match v {
            "mtp" => Ok(Self::Mtp),
            "express" => Ok(Self::Express),
            "music" => Ok(Self::Music),
            _ => anyhow::bail!("Transfer method must be mtp, express, or music"),
        }
    }
}
#[derive(Debug, Serialize)]
pub struct Estimate {
    pub tracks: usize,
    pub bytes: u64,
}
#[derive(Clone, Debug)]
pub struct Progress {
    pub completed: usize,
    pub expected: usize,
}

pub fn estimate(plan: &[Playlist], bitrate: u16, route: Route) -> Result<Estimate> {
    ensure!(
        BITRATES.contains(&bitrate),
        "Choose a supported MP3 bitrate"
    );
    let mut seen = HashSet::new();
    let mut tracks = 0;
    let mut seconds = 0u64;
    for t in plan.iter().flat_map(|p| &p.tracks) {
        if route == Route::Mtp || seen.insert(&t.id) {
            tracks += 1;
            seconds = seconds
                .checked_add(t.duration_seconds)
                .context("Export duration is too large")?;
        }
    }
    let bytes = seconds
        .checked_mul(bitrate as u64)
        .and_then(|v| v.checked_mul(1030))
        .context("Export size is too large")?
        .div_ceil(8);
    Ok(Estimate { tracks, bytes })
}
pub(crate) fn safe_name(value: &str) -> String {
    let clean: String = value
        .nfc()
        .map(|c| {
            if c.is_control() || "<>:\"/\\|?*".contains(c) {
                ' '
            } else {
                c
            }
        })
        .scan(0, |bytes, c| {
            *bytes += c.len_utf8();
            (*bytes <= 80).then_some(c)
        })
        .collect();
    let clean = clean.trim().trim_end_matches(['.', ' ']);
    let name = if clean.is_empty() { "Music" } else { clean };
    let stem = name.split('.').next().unwrap_or("").to_uppercase();
    let reserved = ["CON", "PRN", "AUX", "NUL"].contains(&stem.as_str())
        || (stem.len() == 4
            && (stem.starts_with("COM") || stem.starts_with("LPT"))
            && matches!(stem.as_bytes()[3], b'1'..=b'9'));
    if reserved || name.starts_with('#') {
        format!("_{name}")
    } else {
        name.to_owned()
    }
}
fn unique(base: String, used: &mut HashSet<String>) -> String {
    let mut name = base.clone();
    let mut i = 2;
    while !used.insert(name.to_lowercase()) {
        name = format!("{base} {i}");
        i += 1;
    }
    name
}
pub(crate) fn filename(track: &Track, used: &mut HashSet<String>) -> String {
    let hash = format!("{:x}", Sha256::digest(track.id.as_bytes()));
    format!(
        "{}.mp3",
        unique(
            format!(
                "{} - {} {}",
                safe_name(&track.artist),
                safe_name(&track.title),
                &hash[..10]
            ),
            used
        )
    )
}
fn id3(track: &Track) -> Vec<u8> {
    let mut body = Vec::new();
    for (id, value) in [
        (b"TIT2", &track.title),
        (b"TPE1", &track.artist),
        (b"TALB", &track.album),
    ] {
        let mut payload = vec![1, 0xff, 0xfe];
        for c in value.encode_utf16() {
            payload.extend(c.to_le_bytes());
        }
        body.extend(id);
        body.extend((payload.len() as u32).to_be_bytes());
        body.extend([0, 0]);
        body.extend(payload);
    }
    let n = body.len();
    let mut tag = b"ID3\x03\0\0".to_vec();
    tag.extend([
        (n >> 21 & 127) as u8,
        (n >> 14 & 127) as u8,
        (n >> 7 & 127) as u8,
        (n & 127) as u8,
    ]);
    tag.extend(body);
    tag
}
fn check_cancel(cancel: &AtomicBool) -> Result<()> {
    ensure!(!cancel.load(Ordering::Relaxed), "Export cancelled");
    Ok(())
}
fn read_audio(source: &mut impl Read, out: &mut [u8]) -> Result<()> {
    source
        .read_exact(out)
        .map_err(|_| anyhow::anyhow!("The music server returned an incomplete audio stream"))
}
fn write_track(
    path: &Path,
    track: &Track,
    mut source: impl Read,
    cancel: &AtomicBool,
) -> Result<()> {
    let temp = path.with_extension("mp3.part");
    let result = (|| {
        let mut output = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp)?;
        write_audio(track, &mut source, &mut output, cancel)?;
        output.sync_all()?;
        fs::rename(&temp, path)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result
}
/// Shared tagging and MP3 validation for disk exports and memory-to-MTP transfers.
pub(crate) fn write_audio(
    track: &Track,
    mut source: impl Read,
    mut output: impl Write,
    cancel: &AtomicBool,
) -> Result<()> {
    output.write_all(&id3(track))?;
    let mut header = [0u8; 10];
    read_audio(&mut source, &mut header)?;
    let mut first_audio = header.to_vec();
    if &header[..3] == b"ID3" {
        ensure!(
            [2, 3, 4].contains(&header[3]) && header[6..10].iter().all(|b| b & 128 == 0),
            "Invalid source ID3 tag"
        );
        let mut skip = ((header[6] as usize) << 21)
            | ((header[7] as usize) << 14)
            | ((header[8] as usize) << 7)
            | header[9] as usize;
        if header[3] == 4 && header[5] & 16 != 0 {
            skip += 10;
        }
        ensure!(skip <= 16 * 1024 * 1024, "Source ID3 tag is too large");
        let mut buffer = [0u8; 16384];
        while skip > 0 {
            check_cancel(cancel)?;
            let n = skip.min(buffer.len());
            read_audio(&mut source, &mut buffer[..n])?;
            skip -= n;
        }
        first_audio = vec![0; 4];
        read_audio(&mut source, &mut first_audio)?;
    }
    // MPEG Layer III sync, version, layer, bitrate and sampling frequency fields.
    ensure!(
        first_audio[0] == 255
            && first_audio[1] & 0xe0 == 0xe0
            && first_audio[1] & 0x18 != 0x08
            && first_audio[1] & 0x06 == 0x02
            && first_audio[2] & 0xf0 != 0
            && first_audio[2] & 0xf0 != 0xf0
            && first_audio[2] & 0x0c != 0x0c,
        "The music server returned audio that is not MP3"
    );
    output.write_all(&first_audio)?;
    let mut buffer = [0u8; 65536];
    loop {
        check_cancel(cancel)?;
        let n = source
            .read(&mut buffer)
            .map_err(|_| anyhow::anyhow!("Audio download was interrupted"))?;
        if n == 0 {
            break;
        }
        output.write_all(&buffer[..n])?;
    }
    Ok(())
}
fn write_new(path: &Path, bytes: &[u8]) -> Result<()> {
    let mut f = OpenOptions::new().write(true).create_new(true).open(path)?;
    f.write_all(bytes)?;
    f.sync_all()?;
    Ok(())
}
fn xml(value: &str) -> String {
    value
        .chars()
        .filter(|&c| matches!(c, '\t' | '\n' | '\r') || c >= ' ')
        .collect::<String>()
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}
fn music_xml(plan: &[Playlist], locations: &HashMap<String, PathBuf>) -> Result<String> {
    let mut ids = HashMap::new();
    let mut tracks = String::new();
    for t in plan.iter().flat_map(|p| &p.tracks) {
        if ids.contains_key(&t.id) {
            continue;
        }
        let id = ids.len() + 1;
        ids.insert(t.id.clone(), id);
        let location = url::Url::from_file_path(&locations[&t.id])
            .map_err(|_| anyhow::anyhow!("Invalid export location"))?;
        tracks.push_str(&format!("<key>{id}</key><dict><key>Track ID</key><integer>{id}</integer><key>Name</key><string>{}</string><key>Artist</key><string>{}</string><key>Album</key><string>{}</string><key>Location</key><string>{}</string></dict>",xml(&t.title),xml(&t.artist),xml(&t.album),xml(location.as_str())));
    }
    let mut playlists = String::new();
    for (i, p) in plan.iter().enumerate() {
        playlists.push_str(&format!("<dict><key>Name</key><string>{}</string><key>Playlist ID</key><integer>{}</integer><key>Playlist Items</key><array>",xml(&p.title),i+1));
        for t in &p.tracks {
            playlists.push_str(&format!(
                "<dict><key>Track ID</key><integer>{}</integer></dict>",
                ids[&t.id]
            ));
        }
        playlists.push_str("</array></dict>");
    }
    Ok(format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?><!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\"><plist version=\"1.0\"><dict><key>Major Version</key><integer>1</integer><key>Minor Version</key><integer>1</integer><key>Tracks</key><dict>{tracks}</dict><key>Playlists</key><array>{playlists}</array></dict></plist>\n"
    ))
}

pub fn export<R: Read>(
    plan: &[Playlist],
    bitrate: u16,
    route: Route,
    destination: &Path,
    cancel: &AtomicBool,
    mut audio: impl FnMut(&Track, u16) -> Result<R>,
    mut progress: impl FnMut(Progress),
) -> Result<PathBuf> {
    ensure!(
        !plan.is_empty() && plan.len() <= 500,
        "Choose between 1 and 500 playlists"
    );
    ensure!(
        plan.iter().all(|p| p.tracks.len() <= 10000),
        "Playlist exceeds 10000 tracks"
    );
    check_cancel(cancel)?;
    let estimate = estimate(plan, bitrate, route)?;
    let destination = destination
        .canonicalize()
        .context("Choose an existing output folder")?;
    ensure!(destination.is_dir(), "Output must be a folder");
    ensure!(
        fs2::available_space(&destination)? >= estimate.bytes,
        "The output folder does not have enough free space"
    );
    let name = format!(
        "SyncAndRun {} {}",
        chrono::Utc::now().format("%Y-%m-%d %H-%M-%S"),
        uuid::Uuid::new_v4()
    );
    let root = destination.join(format!("{name}.incomplete"));
    let finished = destination.join(name);
    fs::create_dir(&root)?;
    let result = (|| {
        let mut folders = HashSet::new();
        let mut shared_names = HashSet::new();
        let mut locations: HashMap<String, PathBuf> = HashMap::new();
        let mut completed = 0;
        if route != Route::Mtp {
            fs::create_dir(root.join("Tracks"))?;
        }
        progress(Progress {
            completed,
            expected: estimate.tracks,
        });
        for p in plan {
            check_cancel(cancel)?;
            let folder_name = unique(safe_name(&p.title), &mut folders);
            let folder = if route == Route::Mtp {
                root.join(&folder_name)
            } else {
                root.clone()
            };
            if route == Route::Mtp {
                fs::create_dir(&folder)?;
            }
            let mut lines = if route == Route::Mtp {
                Vec::new()
            } else {
                vec!["#EXTM3U".to_owned()]
            };
            let mut files = HashSet::new();
            for t in &p.tracks {
                check_cancel(cancel)?;
                let relative = if route == Route::Mtp {
                    PathBuf::from(filename(t, &mut files))
                } else if let Some(existing) = locations.get(&t.id) {
                    existing.clone()
                } else {
                    PathBuf::from("Tracks").join(filename(t, &mut shared_names))
                };
                if route == Route::Mtp || !locations.contains_key(&t.id) {
                    write_track(&folder.join(&relative), t, audio(t, bitrate)?, cancel)?;
                    completed += 1;
                    progress(Progress {
                        completed,
                        expected: estimate.tracks,
                    });
                    if route != Route::Mtp {
                        locations.insert(t.id.clone(), relative.clone());
                    }
                }
                lines.push(relative.to_string_lossy().into_owned());
            }
            write_new(
                &folder.join(format!("{folder_name}.m3u8")),
                (lines.join("\n") + "\n").as_bytes(),
            )?;
        }
        if route == Route::Music {
            let final_locations = locations
                .into_iter()
                .map(|(id, path)| (id, finished.join(path)))
                .collect();
            write_new(
                &root.join("Import playlists.xml"),
                music_xml(plan, &final_locations)?.as_bytes(),
            )?;
        }
        check_cancel(cancel)?;
        // UUID output names and create-new writes isolate simultaneous and failed exports.
        ensure!(!finished.exists(), "Export destination already exists");
        fs::rename(&root, &finished)?;
        File::open(&destination)?.sync_all()?;
        Ok(finished)
    })();
    result.with_context(|| format!("Export stopped; partial files remain in {}", root.display()))
}

const MANIFEST: &str = ".syncandrun-files.json";

fn managed_files(root: &Path) -> Result<BTreeMap<String, String>> {
    let manifest = root.join(MANIFEST);
    if !manifest.exists() {
        return Ok(BTreeMap::new());
    }
    let files: BTreeMap<String, String> = serde_json::from_slice(&fs::read(manifest)?)
        .context("Invalid SyncAndRun library manifest")?;
    ensure!(
        files.keys().all(|name| Path::new(name)
            .components()
            .all(|part| matches!(part, std::path::Component::Normal(_)))),
        "Invalid SyncAndRun library manifest path"
    );
    Ok(files)
}

fn save_managed_files(root: &Path, files: &BTreeMap<String, String>) -> Result<()> {
    let temporary = root.join(".syncandrun-files.json.tmp");
    fs::write(&temporary, serde_json::to_vec(files)?)?;
    fs::rename(temporary, root.join(MANIFEST))?;
    Ok(())
}

fn safe_managed_parent(root: &Path, relative: &str) -> Result<bool> {
    let mut parent = root.to_path_buf();
    for component in Path::new(relative)
        .parent()
        .context("Invalid managed file path")?
        .components()
    {
        parent.push(component);
        if parent.exists() && fs::symlink_metadata(&parent)?.file_type().is_symlink() {
            return Ok(false);
        }
    }
    Ok(true)
}

fn file_hash(path: &Path) -> Result<String> {
    let mut file = File::open(path)?;
    let mut hash = Sha256::new();
    let mut buffer = [0u8; 65536];
    loop {
        let n = file.read(&mut buffer)?;
        if n == 0 {
            break;
        }
        hash.update(&buffer[..n]);
    }
    Ok(format!("{:x}", hash.finalize()))
}

fn generated_files(root: &Path, dir: &Path, files: &mut BTreeMap<String, String>) -> Result<()> {
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        if path.is_dir() {
            generated_files(root, &path, files)?;
        } else {
            ensure!(path.is_file(), "Unsupported export entry");
            let relative = path.strip_prefix(root)?.to_string_lossy().into_owned();
            files.insert(relative, file_hash(&path)?);
        }
    }
    Ok(())
}

/// Reconcile only files recorded as generated by this app. Other files in the
/// selected folder, including user additions inside the managed folder, survive.
pub fn export_sync<R: Read>(
    plan: &[Playlist],
    bitrate: u16,
    destination: &Path,
    cancel: &AtomicBool,
    audio: impl FnMut(&Track, u16) -> Result<R>,
    progress: impl FnMut(Progress),
) -> Result<PathBuf> {
    ensure!(
        destination.is_dir() && !fs::symlink_metadata(destination)?.file_type().is_symlink(),
        "Choose a regular music library folder"
    );
    let staged = export(
        plan,
        bitrate,
        Route::Mtp,
        destination,
        cancel,
        audio,
        progress,
    )?;
    let target = destination.canonicalize()?;
    let result = (|| {
        let mut generated = BTreeMap::new();
        generated_files(&staged, &staged, &mut generated)?;
        let previous = managed_files(&target)?;
        for (relative, hash) in &generated {
            check_cancel(cancel)?;
            let dest = target.join(relative);
            ensure!(
                safe_managed_parent(&target, relative)?,
                "A library folder is a symlink: {relative}"
            );
            if dest.exists() {
                ensure!(
                    dest.is_file() && !fs::symlink_metadata(&dest)?.file_type().is_symlink(),
                    "A library file is not regular: {relative}"
                );
                ensure!(
                    previous.contains_key(relative),
                    "An unmanaged file conflicts with the export: {relative}"
                );
                let current = file_hash(&dest)?;
                if current == *hash {
                    continue;
                }
                ensure!(
                    current == previous[relative],
                    "A generated file was changed outside SyncAndRun: {relative}"
                );
            }
            fs::create_dir_all(dest.parent().context("Invalid export path")?)?;
            let temp = dest.with_extension("syncandrun-part");
            fs::copy(staged.join(relative), &temp)?;
            fs::rename(&temp, &dest)?;
        }
        for relative in previous.keys() {
            if !generated.contains_key(relative) {
                let path = target.join(relative);
                if safe_managed_parent(&target, relative)?
                    && path.is_file()
                    && !fs::symlink_metadata(&path)?.file_type().is_symlink()
                    && file_hash(&path)? == previous[relative]
                {
                    fs::remove_file(path)?;
                }
            }
        }
        save_managed_files(&target, &generated)?;
        if staged.exists() {
            fs::remove_dir_all(&staged)?;
        }
        Ok(target)
    })();
    result.with_context(|| {
        format!(
            "Synchronization stopped; staged files remain in {}",
            staged.display()
        )
    })
}

#[derive(Debug, PartialEq, Eq)]
pub struct PurgeResult {
    pub removed: usize,
    pub preserved_modified: usize,
}

/// Delete only unchanged files recorded in this library's manifest. The user
/// chooses whether to invoke this operation; callers must confirm first.
pub fn purge_library(library: &Path) -> Result<PurgeResult> {
    ensure!(library.is_dir(), "Choose an existing music library folder");
    ensure!(
        !fs::symlink_metadata(library)?.file_type().is_symlink(),
        "The music library folder cannot be a symlink"
    );
    let manifest_path = library.join(MANIFEST);
    ensure!(
        manifest_path.exists(),
        "No SyncAndRun music to clear from this folder"
    );
    let previous = managed_files(library)?;
    let mut kept = BTreeMap::new();
    let mut removed = 0;
    for (relative, hash) in previous {
        let path = library.join(&relative);
        if !path.exists() {
            continue;
        }
        if safe_managed_parent(library, &relative)?
            && path.is_file()
            && !fs::symlink_metadata(&path)?.file_type().is_symlink()
            && file_hash(&path)? == hash
        {
            fs::remove_file(&path)?;
            removed += 1;
            if let Some(parent) = path.parent() {
                let _ = fs::remove_dir(parent); // Leave folders containing other files.
            }
        } else {
            kept.insert(relative, hash);
        }
    }
    if kept.is_empty() {
        fs::remove_file(manifest_path)?;
    } else {
        save_managed_files(library, &kept)?;
    }
    Ok(PurgeResult {
        removed,
        preserved_modified: kept.len(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;
    use tempfile::tempdir;
    fn plan() -> Vec<Playlist> {
        let t = Track {
            id: "plex:track:1".into(),
            rating_key: "1".into(),
            title: "Synthetic / title".into(),
            artist: "Fake artist".into(),
            album: "Fake album".into(),
            duration_seconds: 60,
        };
        vec![
            Playlist {
                id: "1".into(),
                title: "../CON".into(),
                tracks: vec![t.clone(), t.clone()],
            },
            Playlist {
                id: "2".into(),
                title: "../con".into(),
                tracks: vec![t],
            },
        ]
    }
    fn mp3() -> Cursor<Vec<u8>> {
        let mut bytes = vec![0xff, 0xfb, 0x90, 0];
        bytes.extend(vec![0; 1024]);
        Cursor::new(bytes)
    }
    #[test]
    fn mtp_preserves_repeats_and_uses_plain_relative_playlists() {
        let dest = tempdir().unwrap();
        let mut calls = 0;
        let mut progress = Vec::new();
        let output = export(
            &plan(),
            192,
            Route::Mtp,
            dest.path(),
            &AtomicBool::new(false),
            |_, _| {
                calls += 1;
                Ok(mp3())
            },
            |p| progress.push(p.completed),
        )
        .unwrap();
        assert_eq!(calls, 3);
        assert_eq!(progress, vec![0, 1, 2, 3]);
        let folders = fs::read_dir(&output)
            .unwrap()
            .map(|e| e.unwrap().path())
            .collect::<Vec<_>>();
        assert_eq!(folders.len(), 2);
        assert_ne!(folders[0], folders[1]);
        for folder in folders {
            let m3u = fs::read_dir(&folder)
                .unwrap()
                .map(|e| e.unwrap().path())
                .find(|p| p.extension().unwrap() == "m3u8")
                .unwrap();
            let lines = fs::read_to_string(m3u).unwrap();
            assert!(!lines.starts_with('#'));
            for name in lines.lines() {
                assert!(!name.contains('/'));
                let bytes = fs::read(folder.join(name)).unwrap();
                assert_eq!(&bytes[..6], b"ID3\x03\0\0");
                assert!(!bytes.windows(10).any(|w| w == b"Plex-Token"));
            }
        }
    }
    #[test]
    fn shared_layout_and_xml_use_final_paths_and_keep_playlist_repeats() {
        let dest = tempdir().unwrap();
        let mut calls = 0;
        let output = export(
            &plan(),
            320,
            Route::Music,
            dest.path(),
            &AtomicBool::new(false),
            |_, _| {
                calls += 1;
                Ok(mp3())
            },
            |_| {},
        )
        .unwrap();
        assert_eq!(calls, 1);
        assert_eq!(fs::read_dir(output.join("Tracks")).unwrap().count(), 1);
        let xml = fs::read_to_string(output.join("Import playlists.xml")).unwrap();
        assert!(!xml.contains(".incomplete"));
        assert!(xml.contains("file://"));
        assert_eq!(xml.matches("<key>Track ID</key>").count(), 4);
        assert_eq!(estimate(&plan(), 320, Route::Music).unwrap().tracks, 1);
        assert_eq!(estimate(&plan(), 320, Route::Mtp).unwrap().tracks, 3);
    }
    #[test]
    fn source_tags_are_removed_and_bad_audio_keeps_only_incomplete_folder() {
        let dest = tempdir().unwrap();
        let output = export(
            &plan(),
            192,
            Route::Express,
            dest.path(),
            &AtomicBool::new(false),
            |_, _| {
                let mut b = b"ID3\x04\0\0\0\0\0\x03abc".to_vec();
                b.extend(mp3().into_inner());
                Ok(Cursor::new(b))
            },
            |_| {},
        )
        .unwrap();
        let file = fs::read_dir(output.join("Tracks"))
            .unwrap()
            .next()
            .unwrap()
            .unwrap()
            .path();
        let bytes = fs::read(&file).unwrap();
        assert_eq!(bytes.windows(3).filter(|w| *w == b"ID3").count(), 1);
        let old_bytes = bytes;
        assert!(
            export(
                &plan(),
                192,
                Route::Mtp,
                dest.path(),
                &AtomicBool::new(false),
                |_, _| Ok(Cursor::new(b"not audio at all".to_vec())),
                |_| {}
            )
            .is_err()
        );
        assert_eq!(fs::read(file).unwrap(), old_bytes);
        let partial = fs::read_dir(dest.path())
            .unwrap()
            .map(|e| e.unwrap().path())
            .find(|p| p.to_string_lossy().ends_with(".incomplete"))
            .unwrap();
        for folder in fs::read_dir(partial).unwrap() {
            assert_eq!(fs::read_dir(folder.unwrap().path()).unwrap().count(), 0);
        }
    }
    #[test]
    fn cancellation_and_invalid_options_do_not_publish_exports() {
        let dest = tempdir().unwrap();
        let cancel = AtomicBool::new(false);
        assert!(
            export(
                &plan(),
                192,
                Route::Mtp,
                dest.path(),
                &cancel,
                |_, _| Ok(mp3()),
                |p| {
                    if p.completed == 1 {
                        cancel.store(true, Ordering::Relaxed);
                    }
                }
            )
            .is_err()
        );
        assert!(
            fs::read_dir(dest.path()).unwrap().all(|e| e
                .unwrap()
                .path()
                .to_string_lossy()
                .ends_with(".incomplete"))
        );
        assert!(estimate(&plan(), 42, Route::Mtp).is_err());
        assert!(safe_name(&"🎵".repeat(100)).len() <= 80);
        assert_eq!(safe_name("#song"), "_#song");
        assert_eq!(safe_name("CON"), "_CON");
        assert_eq!(safe_name("../\\\n"), "Music");
    }
    #[test]
    fn repeat_sync_preserves_unrelated_files_and_reuses_unchanged_generated_files() {
        let dest = tempdir().unwrap();
        fs::write(dest.path().join("notes.txt"), "keep me").unwrap();
        let cancel = AtomicBool::new(false);
        let run = || export_sync(&plan(), 192, dest.path(), &cancel, |_, _| Ok(mp3()), |_| {});
        let output = run().unwrap();
        assert_eq!(output, dest.path());
        let playlist = fs::read_dir(&output)
            .unwrap()
            .map(|e| e.unwrap().path())
            .filter(|p| p.is_dir())
            .flat_map(|p| {
                fs::read_dir(p)
                    .unwrap()
                    .map(|e| e.unwrap().path())
                    .collect::<Vec<_>>()
            })
            .find(|p| p.extension().is_some_and(|e| e == "m3u8"))
            .unwrap();
        let first = fs::metadata(&playlist).unwrap().modified().unwrap();
        fs::write(output.join("notes.txt"), "keep me").unwrap();
        assert_eq!(run().unwrap(), output);
        assert_eq!(fs::metadata(&playlist).unwrap().modified().unwrap(), first);
        assert_eq!(
            fs::read_to_string(output.join("notes.txt")).unwrap(),
            "keep me"
        );
        let reduced = vec![plan()[0].clone()];
        export_sync(
            &reduced,
            192,
            dest.path(),
            &cancel,
            |_, _| Ok(mp3()),
            |_| {},
        )
        .unwrap();
        let manifest: BTreeMap<String, String> =
            serde_json::from_slice(&fs::read(output.join(MANIFEST)).unwrap()).unwrap();
        assert_eq!(manifest.len(), 3);
        assert_eq!(
            fs::read_to_string(output.join("notes.txt")).unwrap(),
            "keep me"
        );
        let playlist = output.join(
            manifest
                .keys()
                .find(|name| name.ends_with(".m3u8"))
                .unwrap(),
        );
        fs::write(&playlist, "personal edit").unwrap();
        assert!(run().is_err());
        assert_eq!(fs::read_to_string(playlist).unwrap(), "personal edit");
    }
    #[test]
    fn purge_clears_only_unchanged_generated_music() {
        let dest = tempdir().unwrap();
        fs::write(dest.path().join("notes.txt"), "keep me").unwrap();
        assert!(purge_library(dest.path()).is_err());
        export_sync(
            &plan(),
            192,
            dest.path(),
            &AtomicBool::new(false),
            |_, _| Ok(mp3()),
            |_| {},
        )
        .unwrap();
        let files = managed_files(dest.path()).unwrap();
        assert_eq!(files.len(), 5);
        let edited = files.keys().find(|name| name.ends_with(".m3u8")).unwrap();
        fs::write(dest.path().join(edited), "personal edit").unwrap();
        assert_eq!(
            purge_library(dest.path()).unwrap(),
            PurgeResult {
                removed: 4,
                preserved_modified: 1
            }
        );
        assert_eq!(
            fs::read_to_string(dest.path().join("notes.txt")).unwrap(),
            "keep me"
        );
        assert_eq!(
            fs::read_to_string(dest.path().join(edited)).unwrap(),
            "personal edit"
        );
        assert_eq!(managed_files(dest.path()).unwrap().len(), 1);
    }
}
