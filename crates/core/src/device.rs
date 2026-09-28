//! Direct USB MTP transfer. Audio is buffered one track at a time, never staged on disk.
mod usb;
use crate::{
    Playlist, Track,
    export::{self, Progress, Route},
};
use anyhow::{Context, Result, ensure};
use serde::Serialize;
use std::{
    collections::{HashMap, HashSet},
    io::{self, Read, Write},
    sync::atomic::{AtomicBool, Ordering},
};

#[derive(Clone, Serialize)]
pub struct Watch {
    pub bus: u32,
    pub number: u8,
    pub storage_id: u32,
    #[serde(skip)]
    fingerprint: String,
    pub model: String,
    pub firmware: String,
    pub free_bytes: u64,
    pub total_bytes: u64,
}
impl Watch {
    pub fn key(&self) -> String {
        format!("{}:{}:{}", self.bus, self.number, self.storage_id)
    }
}
pub fn discover() -> Result<Vec<Watch>> {
    Ok(discover_with_unavailable()?.watches)
}
#[derive(Clone, Serialize)]
pub struct UnavailableWatch {
    pub bus: u32,
    pub number: u8,
    pub reason: String,
}
#[derive(Default, Serialize)]
pub struct Discovery {
    pub watches: Vec<Watch>,
    pub unavailable: Vec<UnavailableWatch>,
}
pub fn discover_with_unavailable() -> Result<Discovery> {
    usb::discover()
}

#[derive(Clone, Debug)]
pub struct TransferProgress {
    pub tracks: Progress,
    pub phase: &'static str,
    /// Verified MP3 bytes. This excludes playlist files and unfinished tracks.
    pub bytes: u64,
    /// An estimate based on track duration and selected bitrate.
    pub estimated_bytes: u64,
}
#[derive(Debug, Serialize)]
pub struct TransferResult {
    pub tracks: usize,
    pub playlists: usize,
    pub bytes: u64,
    pub removed: usize,
}
#[derive(Clone, Serialize)]
pub struct MusicItem {
    pub id: u32,
    pub name: String,
    pub folder: bool,
    pub bytes: u64,
}
#[derive(Clone, Copy, PartialEq, Eq)]
enum TransferMode {
    Add,
    Replace,
}
#[derive(Clone, Copy, PartialEq, Eq)]
enum Layout {
    Separate,
    Shared,
}

struct Storage {
    free: u64,
    writable: bool,
}
struct Object {
    id: u32,
    name: String,
    folder: bool,
    bytes: u64,
}
trait Target {
    fn storage(&mut self) -> Result<Storage>;
    fn list(&mut self, parent: u32) -> Result<Vec<Object>>;
    fn folder(&mut self, parent: u32, name: &str) -> Result<u32>;
    fn upload(&mut self, parent: u32, name: &str, bytes: &[u8], cancel: &AtomicBool)
    -> Result<u32>;
    fn verify(&mut self, id: u32, bytes: &[u8], cancel: &AtomicBool) -> Result<()>;
    fn delete(&mut self, id: u32) -> Result<()>;
}
fn check_cancel(cancel: &AtomicBool) -> Result<()> {
    ensure!(!cancel.load(Ordering::Relaxed), "Transfer cancelled");
    Ok(())
}
// MTP needs the exact object size before upload; Plex transcodes may be chunked.
// Cap the buffer rather than spilling personal music to a filesystem intermediary.
const MAX_TRACK_BYTES: usize = 256 * 1024 * 1024;
struct AudioBuffer(Vec<u8>);
impl Write for AudioBuffer {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        if bytes.len() > MAX_TRACK_BYTES.saturating_sub(self.0.len()) {
            return Err(io::Error::other(
                "Track exceeds the 256 MiB direct-transfer limit; choose a lower bitrate",
            ));
        }
        self.0
            .try_reserve(bytes.len())
            .map_err(|_| io::Error::other("Not enough memory for this track"))?;
        self.0.extend_from_slice(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}
pub fn transfer<R: Read>(
    watch: &Watch,
    plan: &[Playlist],
    bitrate: u16,
    cancel: &AtomicBool,
    source: impl FnMut(&Track, u16) -> Result<R>,
    progress: impl FnMut(TransferProgress),
) -> Result<TransferResult> {
    transfer_with_mode(
        watch,
        plan,
        bitrate,
        cancel,
        source,
        progress,
        TransferMode::Add,
    )
}
pub fn replace_music<R: Read>(
    watch: &Watch,
    plan: &[Playlist],
    bitrate: u16,
    cancel: &AtomicBool,
    source: impl FnMut(&Track, u16) -> Result<R>,
    progress: impl FnMut(TransferProgress),
) -> Result<TransferResult> {
    transfer_with_mode(
        watch,
        plan,
        bitrate,
        cancel,
        source,
        progress,
        TransferMode::Replace,
    )
}
pub fn transfer_shared<R: Read>(
    watch: &Watch,
    plan: &[Playlist],
    bitrate: u16,
    cancel: &AtomicBool,
    source: impl FnMut(&Track, u16) -> Result<R>,
    progress: impl FnMut(TransferProgress),
) -> Result<TransferResult> {
    transfer_with_layout(
        watch,
        plan,
        bitrate,
        cancel,
        source,
        progress,
        (TransferMode::Add, Layout::Shared),
    )
}
fn transfer_with_mode<R: Read>(
    watch: &Watch,
    plan: &[Playlist],
    bitrate: u16,
    cancel: &AtomicBool,
    source: impl FnMut(&Track, u16) -> Result<R>,
    progress: impl FnMut(TransferProgress),
    mode: TransferMode,
) -> Result<TransferResult> {
    transfer_with_layout(
        watch,
        plan,
        bitrate,
        cancel,
        source,
        progress,
        (mode, Layout::Separate),
    )
}
fn transfer_with_layout<R: Read>(
    watch: &Watch,
    plan: &[Playlist],
    bitrate: u16,
    cancel: &AtomicBool,
    source: impl FnMut(&Track, u16) -> Result<R>,
    progress: impl FnMut(TransferProgress),
    options: (TransferMode, Layout),
) -> Result<TransferResult> {
    check_cancel(cancel)?;
    let mut usb = usb::Usb::open(watch)?;
    transfer_to_with_layout(&mut usb, plan, bitrate, cancel, source, progress, options)
}
#[cfg(test)]
fn transfer_to<R: Read>(
    target: &mut impl Target,
    plan: &[Playlist],
    bitrate: u16,
    cancel: &AtomicBool,
    source: impl FnMut(&Track, u16) -> Result<R>,
    progress: impl FnMut(TransferProgress),
) -> Result<TransferResult> {
    transfer_to_with_mode(
        target,
        plan,
        bitrate,
        cancel,
        source,
        progress,
        TransferMode::Add,
    )
}
#[cfg(test)]
fn transfer_to_with_mode<R: Read>(
    target: &mut impl Target,
    plan: &[Playlist],
    bitrate: u16,
    cancel: &AtomicBool,
    source: impl FnMut(&Track, u16) -> Result<R>,
    progress: impl FnMut(TransferProgress),
    mode: TransferMode,
) -> Result<TransferResult> {
    transfer_to_with_layout(
        target,
        plan,
        bitrate,
        cancel,
        source,
        progress,
        (mode, Layout::Separate),
    )
}
fn transfer_to_with_layout<R: Read>(
    target: &mut impl Target,
    plan: &[Playlist],
    bitrate: u16,
    cancel: &AtomicBool,
    mut source: impl FnMut(&Track, u16) -> Result<R>,
    mut progress: impl FnMut(TransferProgress),
    options: (TransferMode, Layout),
) -> Result<TransferResult> {
    let (mode, layout) = options;
    let estimate = export::estimate(
        plan,
        bitrate,
        if layout == Layout::Shared {
            Route::Express
        } else {
            Route::Mtp
        },
    )?;
    ensure!(estimate.tracks > 0, "Choose at least one nonempty playlist");
    check_cancel(cancel)?;
    let storage = target.storage()?;
    ensure!(storage.writable, "Watch storage is read-only");
    ensure!(
        estimate.bytes.saturating_add(1024 * 1024) <= storage.free,
        "Not enough free space on the watch for this selection"
    );
    let root = target.list(0)?;
    let music = root.iter().find(|o| o.name.eq_ignore_ascii_case("Music"));
    ensure!(
        music.is_none_or(|o| o.folder),
        "Watch Music entry is not a folder"
    );
    let music = match music {
        Some(m) => m.id,
        None => target.folder(0, "Music")?,
    };
    let existing = target.list(music)?;
    // Validate the entire deletion scope before uploading anything. Unknown files
    // under Music remain untouched, and make replacement refuse the request.
    let old_objects = if mode == TransferMode::Replace {
        deletion_plan(target, &existing)?
    } else {
        Vec::new()
    };
    let mut names: HashSet<String> = existing.iter().map(|o| o.name.to_lowercase()).collect();
    let run = uuid::Uuid::new_v4().simple().to_string();
    let mut created = Vec::new();
    let mut result = TransferResult {
        tracks: 0,
        playlists: 0,
        bytes: 0,
        removed: 0,
    };
    let outcome = (|| {
        let mut shared_tracks: HashMap<String, String> = HashMap::new();
        let mut shared_used = HashSet::new();
        let mut playlist_names = HashSet::new();
        let shared_folder = if layout == Layout::Shared {
            let mut name = format!("Shared music - SAR {}", &run[..8]);
            while !names.insert(name.to_lowercase()) {
                name.push('_');
            }
            let id = target.folder(music, &name)?;
            created.push(id);
            Some((name, id))
        } else {
            None
        };
        for playlist in plan.iter().filter(|p| !p.tracks.is_empty()) {
            check_cancel(cancel)?;
            let title = export::safe_name(&playlist.title);
            let (folder_name, folder) = if let Some((name, id)) = &shared_folder {
                (name.clone(), *id)
            } else {
                let mut name = format!("{title} - SAR {}", &run[..8]);
                while !names.insert(name.to_lowercase()) {
                    name.push('_');
                }
                let id = target.folder(music, &name)?;
                created.push(id);
                (name, id)
            };
            let mut used = HashSet::new();
            let mut m3u = String::new();
            for track in &playlist.tracks {
                check_cancel(cancel)?;
                if let Some(name) = shared_tracks.get(&track.id) {
                    m3u.push_str(
                        &format!("0:/Music/{folder_name}/{name}\r\n").to_ascii_uppercase(),
                    );
                    continue;
                }
                let mut notify = |phase| {
                    progress(TransferProgress {
                        tracks: Progress {
                            completed: result.tracks,
                            expected: estimate.tracks,
                        },
                        phase,
                        bytes: result.bytes,
                        estimated_bytes: estimate.bytes,
                    })
                };
                notify("Downloading MP3");
                let mut audio = AudioBuffer(Vec::new());
                export::write_audio(track, source(track, bitrate)?, &mut audio, cancel)?;
                check_cancel(cancel)?;
                ensure!(
                    audio.0.len() as u64 + 65536 <= target.storage()?.free,
                    "Watch storage filled up during transfer"
                );
                let name = export::filename(
                    track,
                    if layout == Layout::Shared {
                        &mut shared_used
                    } else {
                        &mut used
                    },
                );
                notify("Sending to watch");
                let id = target.upload(folder, &name, &audio.0, cancel)?;
                created.push(id);
                notify("Verifying on watch");
                target.verify(id, &audio.0, cancel)?;
                if layout == Layout::Shared {
                    shared_tracks.insert(track.id.clone(), name.clone());
                }
                // Garmin rewrites relative paths to this volume path but can keep the
                // original MTP object length, truncating read-back. Supply its final
                // path up front (including CRLF) so the object length is correct.
                m3u.push_str(&format!("0:/Music/{folder_name}/{name}\r\n").to_ascii_uppercase());
                result.tracks += 1;
                result.bytes += audio.0.len() as u64;
                progress(TransferProgress {
                    tracks: Progress {
                        completed: result.tracks,
                        expected: estimate.tracks,
                    },
                    phase: "Transferred",
                    bytes: result.bytes,
                    estimated_bytes: estimate.bytes,
                });
            }
            check_cancel(cancel)?;
            // Publish the playlist only after every track is verified.
            let mut playlist_name = format!("{title}.m3u8");
            if layout == Layout::Shared {
                while !playlist_names.insert(playlist_name.to_lowercase()) {
                    playlist_name.insert(0, '_');
                }
            }
            let id = target.upload(folder, &playlist_name, m3u.as_bytes(), cancel)?;
            created.push(id);
            target.verify(id, m3u.as_bytes(), cancel)?;
            result.playlists += 1;
        }
        check_cancel(cancel)?;
        Ok(())
    })();
    if let Err(error) = outcome {
        let mut incomplete = false;
        for id in created.into_iter().rev() {
            incomplete |= target.delete(id).is_err();
        }
        return Err(error).context(if incomplete { "Transfer stopped. Some new files could not be removed; reconnect and remove the incomplete SAR folders with an MTP app before retrying" } else { "Transfer stopped; this attempt's files were removed" });
    }
    if mode == TransferMode::Replace {
        // Staging succeeded. From here on deletion is irreversible. A failure or
        // cancellation leaves the new verified playlists and any remaining old music.
        for id in old_objects {
            if cancel.load(Ordering::Relaxed) {
                anyhow::bail!(
                    "Replacement stopped after removing {} old music objects. New playlists remain; some old music may remain. Scan the watch before retrying.",
                    result.removed
                );
            }
            if target.delete(id).is_err() {
                anyhow::bail!(
                    "Replacement stopped after removing {} old music objects. New playlists remain; some old music may remain. Scan the watch before retrying.",
                    result.removed
                );
            }
            result.removed += 1;
            progress(TransferProgress {
                tracks: Progress {
                    completed: result.tracks,
                    expected: estimate.tracks,
                },
                phase: "Removing old music",
                bytes: result.bytes,
                estimated_bytes: estimate.bytes,
            });
        }
    }
    Ok(result)
}

fn music_root(target: &mut impl Target) -> Result<Option<u32>> {
    let entry = target
        .list(0)?
        .into_iter()
        .find(|o| o.name.eq_ignore_ascii_case("Music"));
    ensure!(
        entry.as_ref().is_none_or(|o| o.folder),
        "Watch Music entry is not a folder"
    );
    Ok(entry.map(|o| o.id))
}
fn music_file(name: &str) -> bool {
    let extension = name
        .rsplit_once('.')
        .map(|(_, ext)| ext.to_ascii_lowercase());
    matches!(
        extension.as_deref(),
        Some(
            "mp3"
                | "m4a"
                | "aac"
                | "flac"
                | "wav"
                | "wma"
                | "ogg"
                | "m3u"
                | "m3u8"
                | "pls"
                | "jpg"
                | "jpeg"
                | "png"
        )
    )
}
fn deletion_plan(target: &mut impl Target, entries: &[Object]) -> Result<Vec<u32>> {
    fn visit(
        target: &mut impl Target,
        item: &Object,
        depth: usize,
        seen: &mut HashSet<u32>,
        ids: &mut Vec<u32>,
    ) -> Result<()> {
        ensure!(
            depth <= 16 && seen.insert(item.id),
            "Music folder is too deep or contains repeated objects"
        );
        if item.folder {
            for child in target.list(item.id)? {
                visit(target, &child, depth + 1, seen, ids)?;
            }
        } else {
            ensure!(
                music_file(&item.name),
                "Music contains an unsupported file; remove it separately with an MTP app before replacing all music"
            );
        }
        ids.push(item.id);
        Ok(())
    }
    let mut ids = Vec::new();
    let mut seen = HashSet::new();
    for item in entries {
        visit(target, item, 0, &mut seen, &mut ids)?;
    }
    Ok(ids)
}
pub fn music_items(watch: &Watch) -> Result<Vec<MusicItem>> {
    let mut target = usb::Usb::open(watch)?;
    music_items_from(&mut target)
}
fn music_items_from(target: &mut impl Target) -> Result<Vec<MusicItem>> {
    let Some(root) = music_root(target)? else {
        return Ok(Vec::new());
    };
    fn size(
        target: &mut impl Target,
        item: &Object,
        depth: usize,
        seen: &mut HashSet<u32>,
    ) -> Result<u64> {
        ensure!(
            depth <= 16 && seen.insert(item.id),
            "Music folder is too deep or contains repeated objects"
        );
        if !item.folder {
            return Ok(item.bytes);
        }
        let mut total = 0u64;
        for child in target.list(item.id)? {
            total = total.saturating_add(size(target, &child, depth + 1, seen)?);
        }
        Ok(total)
    }
    let mut seen = HashSet::new();
    target
        .list(root)?
        .into_iter()
        .map(|o| {
            Ok(MusicItem {
                id: o.id,
                bytes: size(target, &o, 0, &mut seen)?,
                name: o.name,
                folder: o.folder,
            })
        })
        .collect()
}
pub fn remove_music_item(watch: &Watch, id: u32, name: &str, cancel: &AtomicBool) -> Result<usize> {
    check_cancel(cancel)?;
    let mut target = usb::Usb::open(watch)?;
    let root = music_root(&mut target)?.context("Watch Music folder is missing")?;
    let matches: Vec<_> = target
        .list(root)?
        .into_iter()
        .filter(|o| o.id == id && o.name == name)
        .collect();
    ensure!(
        matches.len() == 1,
        "Music item changed; scan the watch again"
    );
    let ids = deletion_plan(&mut target, &matches)?;
    let mut removed = 0;
    for id in ids {
        if cancel.load(Ordering::Relaxed) || target.delete(id).is_err() {
            anyhow::bail!(
                "Removal stopped after deleting {removed} music objects. This cannot be undone; scan the watch to see what remains."
            );
        }
        removed += 1;
    }
    Ok(removed)
}

// Garmin canonicalizes M3U8 paths and letter case. Compare ordered references.
fn verify_playlist(expected: &[u8], received: &[u8]) -> Result<()> {
    let expected = std::str::from_utf8(expected).context("Invalid generated playlist")?;
    let received = std::str::from_utf8(received).context("Watch returned an invalid playlist")?;
    let normalize = |text: &str| -> Vec<String> {
        text.trim_start_matches('\u{feff}')
            .lines()
            .filter(|line| !line.trim().is_empty() && !line.starts_with('#'))
            .map(|line| line.replace('\\', "/").to_lowercase())
            .collect()
    };
    let expected = normalize(expected);
    let received = normalize(received);
    ensure!(
        expected.len() == received.len()
            && expected.iter().zip(&received).all(|(a, b)| {
                if a.contains('/') && b.contains('/') {
                    a == b
                } else {
                    a.rsplit('/').next() == b.rsplit('/').next()
                }
            }),
        "Watch playlist verification failed: track paths or order differ"
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{collections::BTreeMap, io::Cursor};

    struct Entry {
        parent: u32,
        name: String,
        data: Option<Vec<u8>>,
    }
    struct Fake {
        entries: BTreeMap<u32, Entry>,
        next: u32,
        free: u64,
        fail_upload: bool,
        fail_upload_after: Option<usize>,
        uploads: usize,
        corrupt: bool,
        disconnected: bool,
        fail_delete_after: Option<usize>,
        deleted: usize,
    }
    impl Default for Fake {
        fn default() -> Self {
            Self {
                entries: BTreeMap::from([
                    (
                        1,
                        Entry {
                            parent: 0,
                            name: "Music".into(),
                            data: None,
                        },
                    ),
                    (
                        2,
                        Entry {
                            parent: 1,
                            name: "Existing.mp3".into(),
                            data: Some(vec![42]),
                        },
                    ),
                ]),
                next: 3,
                free: 1_000_000_000,
                fail_upload: false,
                fail_upload_after: None,
                uploads: 0,
                corrupt: false,
                disconnected: false,
                fail_delete_after: None,
                deleted: 0,
            }
        }
    }
    impl Target for Fake {
        fn storage(&mut self) -> Result<Storage> {
            Ok(Storage {
                free: self.free,
                writable: true,
            })
        }
        fn list(&mut self, parent: u32) -> Result<Vec<Object>> {
            Ok(self
                .entries
                .iter()
                .filter(|(_, e)| e.parent == parent)
                .map(|(&id, e)| Object {
                    id,
                    name: e.name.clone(),
                    folder: e.data.is_none(),
                    bytes: e.data.as_ref().map_or(0, |data| data.len() as u64),
                })
                .collect())
        }
        fn folder(&mut self, parent: u32, name: &str) -> Result<u32> {
            let id = self.next;
            self.next += 1;
            self.entries.insert(
                id,
                Entry {
                    parent,
                    name: name.into(),
                    data: None,
                },
            );
            Ok(id)
        }
        fn upload(&mut self, parent: u32, name: &str, bytes: &[u8], _: &AtomicBool) -> Result<u32> {
            ensure!(!self.fail_upload, "Upload failed");
            ensure!(
                self.fail_upload_after
                    .is_none_or(|limit| self.uploads < limit),
                "Upload failed"
            );
            let id = self.folder(parent, name)?;
            self.entries.get_mut(&id).unwrap().data = Some(bytes.to_vec());
            self.uploads += 1;
            Ok(id)
        }
        fn verify(&mut self, id: u32, bytes: &[u8], _: &AtomicBool) -> Result<()> {
            ensure!(!self.corrupt && !self.disconnected, "Read-back failed");
            ensure!(
                self.entries[&id].data.as_deref() == Some(bytes),
                "Content differs"
            );
            Ok(())
        }
        fn delete(&mut self, id: u32) -> Result<()> {
            ensure!(!self.disconnected, "Disconnected");
            ensure!(
                self.fail_delete_after
                    .is_none_or(|limit| self.deleted < limit),
                "Delete failed"
            );
            ensure!(
                !self.entries.values().any(|e| e.parent == id),
                "Folder not empty"
            );
            self.entries.remove(&id);
            self.deleted += 1;
            Ok(())
        }
    }
    fn plan() -> Vec<Playlist> {
        let track = Track {
            id: "fake-1".into(),
            rating_key: "1".into(),
            title: "Fake / song".into(),
            artist: "Synthetic artist".into(),
            album: "Test".into(),
            duration_seconds: 1,
        };
        vec![Playlist {
            id: "fake-playlist".into(),
            title: "#Fake / playlist".into(),
            tracks: vec![track.clone(), track],
        }]
    }
    fn audio(_: &Track, _: u16) -> Result<Cursor<Vec<u8>>> {
        Ok(Cursor::new(
            [vec![255, 251, 144, 0], vec![0; 1024]].concat(),
        ))
    }
    fn overlapping_playlists() -> Vec<Playlist> {
        let first = plan().remove(0).tracks.remove(0);
        let mut middle = first.clone();
        middle.id = "fake-2".into();
        middle.title = "Middle song".into();
        let mut last = first.clone();
        last.id = "fake-3".into();
        last.title = "Last song".into();
        vec![
            Playlist {
                id: "first".into(),
                title: "First list".into(),
                tracks: vec![first.clone(), middle.clone()],
            },
            Playlist {
                id: "second".into(),
                title: "Second list".into(),
                tracks: vec![middle, last, first],
            },
        ]
    }
    #[test]
    fn garmin_rewritten_playlists_preserve_names_order_and_repeats() {
        assert!(verify_playlist(b"One.mp3\nTwo.mp3\nOne.mp3\n", b"\xef\xbb\xbf#EXTM3U\r\n/Internal Storage/Music/Test/One.mp3\r\nMusic\\Test\\Two.mp3\r\nOne.mp3\r\n").is_ok());
        assert!(verify_playlist(b"One.mp3\nTwo.mp3\n", b"Two.mp3\nOne.mp3\n").is_err());
        assert!(verify_playlist(b"One.mp3\nOne.mp3\n", b"One.mp3\n").is_err());
        assert!(verify_playlist(b"0:/Music/A/One.mp3\n", b"0:/Music/B/One.mp3\n").is_err());
    }
    #[test]
    fn direct_transfer_preserves_music_and_playlist_order_with_repeats() {
        let mut target = Fake::default();
        let cancel = AtomicBool::new(false);
        let result = transfer_to(&mut target, &plan(), 192, &cancel, audio, |_| {}).unwrap();
        assert_eq!((result.tracks, result.playlists), (2, 1));
        assert_eq!(target.entries[&2].data, Some(vec![42]));
        let playlist = target
            .entries
            .values()
            .find(|e| e.name.ends_with(".m3u8"))
            .unwrap();
        let m3u = String::from_utf8(playlist.data.clone().unwrap()).unwrap();
        let names: Vec<_> = m3u.lines().collect();
        assert_eq!(names.len(), 2);
        assert_ne!(names[0], names[1]);
        assert!(!m3u.starts_with('#'));
        for name in names {
            let track = target
                .entries
                .values()
                .find(|e| {
                    e.parent == playlist.parent
                        && e.name
                            .eq_ignore_ascii_case(name.rsplit('/').next().unwrap())
                })
                .unwrap();
            assert!(track.data.as_ref().unwrap().starts_with(b"ID3\x03"));
        }
        let old: Vec<_> = target.entries.keys().copied().collect();
        transfer_to(&mut target, &plan(), 320, &cancel, audio, |_| {}).unwrap();
        assert!(old.iter().all(|id| target.entries.contains_key(id)));
    }
    #[test]
    fn failed_download_upload_and_verification_roll_back_only_new_files() {
        for failure in 0..3 {
            let mut target = Fake {
                fail_upload: failure == 1,
                corrupt: failure == 2,
                ..Default::default()
            };
            let error = transfer_to(
                &mut target,
                &plan(),
                192,
                &AtomicBool::new(false),
                |t, b| {
                    if failure == 0 {
                        anyhow::bail!("Synthetic network failure");
                    }
                    audio(t, b)
                },
                |_| {},
            )
            .unwrap_err();
            assert!(error.to_string().contains("files were removed"));
            assert_eq!(target.entries.len(), 2);
        }
    }
    #[test]
    fn cancel_mid_transfer_rolls_back_new_files() {
        let mut target = Fake::default();
        let cancel = AtomicBool::new(false);
        let error = transfer_to(&mut target, &plan(), 192, &cancel, audio, |p| {
            if p.tracks.completed == 1 {
                cancel.store(true, Ordering::Relaxed);
            }
        })
        .unwrap_err();
        assert!(format!("{error:#}").contains("cancelled"));
        assert_eq!(target.entries.len(), 2);
    }
    #[test]
    fn disconnected_cleanup_is_reported_as_incomplete() {
        let mut target = Fake {
            disconnected: true,
            ..Default::default()
        };
        let error = transfer_to(
            &mut target,
            &plan(),
            192,
            &AtomicBool::new(false),
            audio,
            |_| {},
        )
        .unwrap_err();
        assert!(error.to_string().contains("could not be removed"));
        assert_eq!(target.entries[&2].data, Some(vec![42]));
    }
    #[test]
    fn full_device_and_invalid_audio_are_rejected() {
        let mut target = Fake {
            free: 1,
            ..Default::default()
        };
        assert!(
            transfer_to(
                &mut target,
                &plan(),
                192,
                &AtomicBool::new(false),
                audio,
                |_| {}
            )
            .is_err()
        );
        assert_eq!(target.entries.len(), 2);
        target.free = 1_000_000_000;
        assert!(
            transfer_to(
                &mut target,
                &plan(),
                192,
                &AtomicBool::new(false),
                |_, _| Ok(Cursor::new(vec![0; 100])),
                |_| {}
            )
            .is_err()
        );
        assert_eq!(target.entries.len(), 2);
    }
    #[test]
    fn replacement_stages_then_removes_only_old_music() {
        let mut target = Fake::default();
        target.entries.insert(
            9,
            Entry {
                parent: 0,
                name: "GARMIN".into(),
                data: None,
            },
        );
        target.entries.insert(
            10,
            Entry {
                parent: 9,
                name: "activity.fit".into(),
                data: Some(vec![4]),
            },
        );
        let result = transfer_to_with_mode(
            &mut target,
            &plan(),
            192,
            &AtomicBool::new(false),
            audio,
            |_| {},
            TransferMode::Replace,
        )
        .unwrap();
        assert_eq!(result.removed, 1);
        assert!(!target.entries.contains_key(&2));
        assert_eq!(target.entries[&10].data, Some(vec![4]));
        assert!(target.entries.values().any(|e| e.name.ends_with(".m3u8")));
    }
    #[test]
    fn watch_music_sizes_sum_files_inside_folders() {
        let mut target = Fake::default();
        target.entries.insert(
            3,
            Entry {
                parent: 1,
                name: "Album".into(),
                data: None,
            },
        );
        target.entries.insert(
            4,
            Entry {
                parent: 3,
                name: "song.mp3".into(),
                data: Some(vec![0; 20]),
            },
        );
        target.entries.insert(
            5,
            Entry {
                parent: 3,
                name: "list.m3u8".into(),
                data: Some(vec![0; 7]),
            },
        );
        let items = music_items_from(&mut target).unwrap();
        assert_eq!(
            items
                .iter()
                .find(|item| item.name == "Album")
                .unwrap()
                .bytes,
            27
        );
        assert_eq!(
            items
                .iter()
                .find(|item| item.name == "Existing.mp3")
                .unwrap()
                .bytes,
            1
        );
    }
    #[test]
    fn shared_layout_uploads_each_track_once_for_multiple_playlists() {
        let mut target = Fake::default();
        let mut playlists = plan();
        let mut second = playlists[0].clone();
        second.title = "Second list".into();
        let mut unique = second.tracks[0].clone();
        unique.id = "fake-2".into();
        unique.title = "Another song".into();
        second.tracks.push(unique);
        playlists.push(second);
        let result = transfer_to_with_layout(
            &mut target,
            &playlists,
            192,
            &AtomicBool::new(false),
            audio,
            |_| {},
            (TransferMode::Add, Layout::Shared),
        )
        .unwrap();
        assert_eq!((result.tracks, result.playlists), (2, 2));
        let folders: Vec<_> = target
            .entries
            .values()
            .filter(|e| e.parent == 1 && e.data.is_none())
            .collect();
        assert_eq!(folders.len(), 1);
        let folder_id = *target
            .entries
            .iter()
            .find(|(_, e)| e.parent == 1 && e.data.is_none())
            .unwrap()
            .0;
        let files: Vec<_> = target
            .entries
            .values()
            .filter(|e| e.parent == folder_id)
            .collect();
        assert_eq!(files.iter().filter(|e| e.name.ends_with(".mp3")).count(), 2);
        assert_eq!(
            files.iter().filter(|e| e.name.ends_with(".m3u8")).count(),
            2
        );
        let playlists: Vec<_> = files
            .iter()
            .filter(|e| e.name.ends_with(".m3u8"))
            .map(|e| String::from_utf8(e.data.clone().unwrap()).unwrap())
            .collect();
        let shared_path = playlists[0].lines().next().unwrap();
        assert!(shared_path.starts_with("0:/MUSIC/"));
        assert_eq!(
            playlists
                .iter()
                .flat_map(|p| p.lines())
                .filter(|line| *line == shared_path)
                .count(),
            4
        );
    }
    #[test]
    fn shared_layout_keeps_partial_overlap_and_playlist_order() {
        let mut target = Fake::default();
        let mut downloaded = Vec::new();
        let result = transfer_to_with_layout(
            &mut target,
            &overlapping_playlists(),
            192,
            &AtomicBool::new(false),
            |track, bitrate| {
                downloaded.push((track.id.clone(), bitrate));
                audio(track, bitrate)
            },
            |_| {},
            (TransferMode::Add, Layout::Shared),
        )
        .unwrap();
        assert_eq!(result.tracks, 3);
        assert_eq!(
            downloaded,
            [
                ("fake-1".into(), 192),
                ("fake-2".into(), 192),
                ("fake-3".into(), 192)
            ]
        );
        let folder = target
            .entries
            .iter()
            .find(|(_, e)| e.parent == 1 && e.data.is_none())
            .unwrap()
            .0;
        let files: Vec<_> = target
            .entries
            .values()
            .filter(|e| e.parent == *folder)
            .collect();
        assert_eq!(files.iter().filter(|e| e.name.ends_with(".mp3")).count(), 3);
        let lines = |name: &str| -> Vec<String> {
            String::from_utf8(
                files
                    .iter()
                    .find(|e| e.name == name)
                    .unwrap()
                    .data
                    .clone()
                    .unwrap(),
            )
            .unwrap()
            .lines()
            .map(str::to_owned)
            .collect()
        };
        let first = lines("First list.m3u8");
        let second = lines("Second list.m3u8");
        assert_eq!((first.len(), second.len()), (2, 3));
        assert_eq!(first[0], second[2]);
        assert_eq!(first[1], second[0]);
        assert_ne!(second[1], first[0]);
        assert_ne!(second[1], first[1]);
    }
    #[test]
    fn shared_layout_failure_in_second_playlist_removes_only_new_objects() {
        let mut target = Fake {
            fail_upload_after: Some(4),
            ..Default::default()
        };
        let error = transfer_to_with_layout(
            &mut target,
            &overlapping_playlists(),
            192,
            &AtomicBool::new(false),
            audio,
            |_| {},
            (TransferMode::Add, Layout::Shared),
        )
        .unwrap_err();
        assert!(format!("{error:#}").contains("files were removed"));
        assert_eq!(target.uploads, 4);
        assert_eq!(target.entries.len(), 2);
        assert_eq!(target.entries[&2].data, Some(vec![42]));
    }
    #[test]
    fn replacement_rejects_unknown_content_before_transfer() {
        let mut target = Fake::default();
        target.entries.insert(
            3,
            Entry {
                parent: 1,
                name: "unknown.bin".into(),
                data: Some(vec![4]),
            },
        );
        let error = transfer_to_with_mode(
            &mut target,
            &plan(),
            192,
            &AtomicBool::new(false),
            audio,
            |_| {},
            TransferMode::Replace,
        )
        .unwrap_err();
        assert!(error.to_string().contains("unsupported"));
        assert_eq!(target.entries.len(), 3);
    }
    #[test]
    fn interrupted_removal_reports_irreversible_partial_result() {
        let mut target = Fake {
            fail_delete_after: Some(1),
            ..Default::default()
        };
        target.entries.insert(
            3,
            Entry {
                parent: 1,
                name: "Old.m3u8".into(),
                data: Some(vec![4]),
            },
        );
        target.next = 4;
        let error = transfer_to_with_mode(
            &mut target,
            &plan(),
            192,
            &AtomicBool::new(false),
            audio,
            |_| {},
            TransferMode::Replace,
        )
        .unwrap_err();
        assert!(
            error
                .to_string()
                .contains("after removing 1 old music objects")
        );
        assert!(
            target
                .entries
                .values()
                .any(|e| e.name.ends_with(".m3u8") && e.name != "Old.m3u8")
        );
        assert_eq!(
            target.entries.contains_key(&2) as u8 + target.entries.contains_key(&3) as u8,
            1
        );
    }
}
