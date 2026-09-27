//! Direct USB MTP transfer. Audio is buffered one track at a time, never staged on disk.
mod usb;
use crate::{
    Playlist, Track,
    export::{self, Progress, Route},
};
use anyhow::{Context, Result, ensure};
use serde::Serialize;
use std::{
    collections::HashSet,
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
    usb::discover()
}

#[derive(Clone, Debug)]
pub struct TransferProgress {
    pub tracks: Progress,
    pub phase: &'static str,
}
#[derive(Debug, Serialize)]
pub struct TransferResult {
    pub tracks: usize,
    pub playlists: usize,
    pub bytes: u64,
}

struct Storage {
    free: u64,
    writable: bool,
}
struct Object {
    id: u32,
    name: String,
    folder: bool,
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
    check_cancel(cancel)?;
    let mut usb = usb::Usb::open(watch)?;
    transfer_to(&mut usb, plan, bitrate, cancel, source, progress)
}
fn transfer_to<R: Read>(
    target: &mut impl Target,
    plan: &[Playlist],
    bitrate: u16,
    cancel: &AtomicBool,
    mut source: impl FnMut(&Track, u16) -> Result<R>,
    mut progress: impl FnMut(TransferProgress),
) -> Result<TransferResult> {
    let estimate = export::estimate(plan, bitrate, Route::Mtp)?;
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
    let mut names: HashSet<String> = existing.iter().map(|o| o.name.to_lowercase()).collect();
    let run = uuid::Uuid::new_v4().simple().to_string();
    let mut created = Vec::new();
    let mut result = TransferResult {
        tracks: 0,
        playlists: 0,
        bytes: 0,
    };
    let outcome = (|| {
        for playlist in plan.iter().filter(|p| !p.tracks.is_empty()) {
            check_cancel(cancel)?;
            let title = export::safe_name(&playlist.title);
            let mut folder_name = format!("{title} - SAR {}", &run[..8]);
            while !names.insert(folder_name.to_lowercase()) {
                folder_name.push('_');
            }
            let folder = target.folder(music, &folder_name)?;
            created.push(folder);
            let mut used = HashSet::new();
            let mut m3u = String::new();
            for track in &playlist.tracks {
                check_cancel(cancel)?;
                let mut notify = |phase| {
                    progress(TransferProgress {
                        tracks: Progress {
                            completed: result.tracks,
                            expected: estimate.tracks,
                        },
                        phase,
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
                let name = export::filename(track, &mut used);
                notify("Sending to watch");
                let id = target.upload(folder, &name, &audio.0, cancel)?;
                created.push(id);
                notify("Verifying on watch");
                target.verify(id, &audio.0, cancel)?;
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
                });
            }
            check_cancel(cancel)?;
            // Publish the playlist only after every track is verified.
            let id = target.upload(folder, &format!("{title}.m3u8"), m3u.as_bytes(), cancel)?;
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
    Ok(result)
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
        corrupt: bool,
        disconnected: bool,
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
                corrupt: false,
                disconnected: false,
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
            let id = self.folder(parent, name)?;
            self.entries.get_mut(&id).unwrap().data = Some(bytes.to_vec());
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
                !self.entries.values().any(|e| e.parent == id),
                "Folder not empty"
            );
            self.entries.remove(&id);
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
}
