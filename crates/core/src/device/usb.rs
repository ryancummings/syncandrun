//! Small ownership wrapper around libmtp. Protocol handling and Garmin quirks stay in libmtp.
use super::{Discovery, Object, Storage, Target, UnavailableWatch, Watch};
use anyhow::{Context, Result, bail, ensure};
use libmtp_sys as ffi;
use sha2::{Digest, Sha256};
use std::{
    ffi::{CStr, CString, c_void},
    ptr,
    sync::{
        Mutex, MutexGuard, Once,
        atomic::{AtomicBool, Ordering},
    },
};

static USB: Mutex<()> = Mutex::new(());
static INIT: Once = Once::new();

pub(super) struct Usb {
    device: *mut ffi::LIBMTP_mtpdevice_t,
    storage: u32,
    // libmtp initialization and all sessions are serialized, including discovery.
    _lock: MutexGuard<'static, ()>,
}
impl Drop for Usb {
    fn drop(&mut self) {
        // SAFETY: open_uncached returned an owned device, released exactly once here.
        unsafe { ffi::LIBMTP_Release_Device(self.device) }
    }
}
fn lock() -> Result<MutexGuard<'static, ()>> {
    let guard = USB
        .lock()
        .map_err(|_| anyhow::anyhow!("USB worker stopped; restart the app"))?;
    INIT.call_once(|| unsafe { ffi::LIBMTP_Init() });
    Ok(guard)
}
fn raw_devices() -> Result<Vec<ffi::LIBMTP_raw_device_t>> {
    let mut raw = ptr::null_mut();
    let mut count = 0;
    // SAFETY: libmtp allocates this array; copy descriptors before freeing its allocation.
    let code = unsafe { ffi::LIBMTP_Detect_Raw_Devices(&mut raw, &mut count) };
    let result = if code == ffi::LIBMTP_error_number_t_LIBMTP_ERROR_NO_DEVICE_ATTACHED {
        Ok(Vec::new())
    } else if code != ffi::LIBMTP_error_number_t_LIBMTP_ERROR_NONE {
        Err(anyhow::anyhow!(
            "Could not scan USB devices. Check USB permissions and reconnect the watch."
        ))
    } else if count > 0 && !raw.is_null() {
        Ok((0..count as usize)
            .map(|i| unsafe { ptr::read(raw.add(i)) })
            .collect())
    } else {
        Ok(Vec::new())
    };
    unsafe { libc::free(raw.cast()) };
    result
}
// SAFETY: getters return owned, malloc-allocated NUL-terminated strings, or NULL.
unsafe fn owned_string(value: *mut libc::c_char) -> String {
    if value.is_null() {
        return String::new();
    }
    let text = unsafe { CStr::from_ptr(value) }
        .to_string_lossy()
        .into_owned();
    unsafe { libc::free(value.cast()) };
    text
}
impl Usb {
    fn from_raw(
        raw: &mut ffi::LIBMTP_raw_device_t,
        guard: MutexGuard<'static, ()>,
    ) -> Result<Self> {
        let device = unsafe { ffi::LIBMTP_Open_Raw_Device_Uncached(raw) };
        ensure!(
            !device.is_null(),
            "Garmin is connected but unavailable. Close Files or another MTP app, unmount the watch there, then retry. Check USB permissions if it remains unavailable."
        );
        Ok(Self {
            device,
            storage: 0,
            _lock: guard,
        })
    }
    fn check(&self, code: i32, action: &str) -> Result<()> {
        // Do not expose libmtp's stack: it can contain personal file names.
        let stack = unsafe { ffi::LIBMTP_Get_Errorstack(self.device) };
        let failed = code != 0 || !stack.is_null();
        unsafe { ffi::LIBMTP_Clear_Errorstack(self.device) };
        ensure!(
            !failed,
            "Could not {action} over USB. Reconnect the watch and close other MTP apps, then retry."
        );
        Ok(())
    }
    fn watches(&self, bus: u32, number: u8) -> Result<Vec<Watch>> {
        let model = unsafe { owned_string(ffi::LIBMTP_Get_Modelname(self.device)) };
        let firmware = unsafe { owned_string(ffi::LIBMTP_Get_Deviceversion(self.device)) };
        let serial = unsafe { owned_string(ffi::LIBMTP_Get_Serialnumber(self.device)) };
        unsafe { ffi::LIBMTP_Clear_Errorstack(self.device) };
        let fingerprint = format!(
            "{:x}",
            Sha256::digest(format!("{model}\0{serial}").as_bytes())
        );
        self.check(
            unsafe { ffi::LIBMTP_Get_Storage(self.device, 0) },
            "read watch storage",
        )?;
        let mut storage = unsafe { (*self.device).storage };
        let mut watches = Vec::new();
        while !storage.is_null() {
            let info = unsafe { &*storage };
            if info.AccessCapability == 0 {
                watches.push(Watch {
                    bus,
                    number,
                    storage_id: info.id,
                    fingerprint: fingerprint.clone(),
                    model: if model.is_empty() {
                        "Garmin watch".into()
                    } else {
                        model.clone()
                    },
                    firmware: firmware.clone(),
                    free_bytes: info.FreeSpaceInBytes,
                    total_bytes: info.MaxCapacity,
                });
            }
            storage = info.next;
        }
        Ok(watches)
    }
    pub(super) fn open(watch: &Watch) -> Result<Self> {
        let guard = lock()?;
        let mut raw = raw_devices()?
            .into_iter()
            .find(|r| {
                r.device_entry.vendor_id == 0x091e
                    && r.bus_location == watch.bus
                    && r.devnum == watch.number
            })
            .context("Watch disconnected. Reconnect it and scan again.")?;
        let mut usb = Self::from_raw(&mut raw, guard)?;
        ensure!(
            usb.watches(watch.bus, watch.number)?
                .iter()
                .any(|w| w.fingerprint == watch.fingerprint && w.storage_id == watch.storage_id),
            "The connected watch changed. Scan and select it again."
        );
        usb.storage = watch.storage_id;
        Ok(usb)
    }
}
fn collect_watches<T>(
    devices: impl IntoIterator<Item = (u32, u8, T)>,
    mut inspect: impl FnMut(T, u32, u8) -> Result<Vec<Watch>>,
) -> Discovery {
    let mut result = Discovery::default();
    for (bus, number, device) in devices {
        match inspect(device, bus, number) {
            Ok(watches) if !watches.is_empty() => result.watches.extend(watches),
            Ok(_) => result.unavailable.push(UnavailableWatch {
                bus,
                number,
                reason: "No writable Garmin storage available".into(),
            }),
            Err(_) => result.unavailable.push(UnavailableWatch {
                bus,
                number,
                reason: "Garmin unavailable; close other MTP apps and check USB permissions".into(),
            }),
        }
    }
    result
}
pub(super) fn discover() -> Result<Discovery> {
    let guard = lock()?;
    let raws = raw_devices()?;
    drop(guard);
    Ok(collect_watches(
        raws.into_iter()
            .filter(|r| r.device_entry.vendor_id == 0x091e)
            .map(|raw| (raw.bus_location, raw.devnum, raw)),
        |mut raw, bus, number| {
            let usb = Usb::from_raw(&mut raw, lock()?)?;
            usb.watches(bus, number)
        },
    ))
}

struct Upload<'a> {
    bytes: &'a [u8],
    offset: usize,
    cancel: &'a AtomicBool,
}
unsafe extern "C" fn get_bytes(
    _: *mut c_void,
    private: *mut c_void,
    wanted: u32,
    data: *mut u8,
    got: *mut u32,
) -> u16 {
    // SAFETY: libmtp invokes synchronously with the live Upload and writable buffers.
    let state = unsafe { &mut *private.cast::<Upload<'_>>() };
    unsafe { *got = 0 };
    if state.cancel.load(Ordering::Relaxed) {
        return ffi::LIBMTP_HANDLER_RETURN_CANCEL as u16;
    }
    let count = (wanted as usize).min(state.bytes.len().saturating_sub(state.offset));
    unsafe {
        ptr::copy_nonoverlapping(state.bytes.as_ptr().add(state.offset), data, count);
        *got = count as u32;
    }
    state.offset += count;
    ffi::LIBMTP_HANDLER_RETURN_OK as u16
}
struct Verify<'a> {
    hash: Sha256,
    count: u64,
    cancel: &'a AtomicBool,
    playlist: Option<Vec<u8>>,
    playlist_limit: usize,
}
unsafe extern "C" fn put_bytes(
    _: *mut c_void,
    private: *mut c_void,
    count: u32,
    data: *mut u8,
    put: *mut u32,
) -> u16 {
    let state = unsafe { &mut *private.cast::<Verify<'_>>() };
    unsafe { *put = 0 };
    if state.cancel.load(Ordering::Relaxed) {
        return ffi::LIBMTP_HANDLER_RETURN_CANCEL as u16;
    }
    let bytes = unsafe { std::slice::from_raw_parts(data, count as usize) };
    state.hash.update(bytes);
    if let Some(playlist) = &mut state.playlist {
        if playlist.len().saturating_add(bytes.len()) > state.playlist_limit {
            return ffi::LIBMTP_HANDLER_RETURN_ERROR as u16;
        }
        playlist.extend_from_slice(bytes);
    }
    state.count += count as u64;
    unsafe { *put = count };
    ffi::LIBMTP_HANDLER_RETURN_OK as u16
}
impl Target for Usb {
    fn storage(&mut self) -> Result<Storage> {
        self.check(
            unsafe { ffi::LIBMTP_Get_Storage(self.device, 0) },
            "read watch storage",
        )?;
        let mut item = unsafe { (*self.device).storage };
        while !item.is_null() {
            let info = unsafe { &*item };
            if info.id == self.storage {
                return Ok(Storage {
                    free: info.FreeSpaceInBytes,
                    writable: info.AccessCapability == 0,
                });
            }
            item = info.next;
        }
        bail!("Watch storage is no longer available")
    }
    fn list(&mut self, parent: u32) -> Result<Vec<Object>> {
        let mut item = unsafe {
            ffi::LIBMTP_Get_Files_And_Folders(
                self.device,
                self.storage,
                if parent == 0 { u32::MAX } else { parent },
            )
        };
        let mut files = Vec::new();
        while !item.is_null() {
            let info = unsafe { &*item };
            let name = if info.filename.is_null() {
                String::new()
            } else {
                unsafe { CStr::from_ptr(info.filename) }
                    .to_string_lossy()
                    .into_owned()
            };
            files.push(Object {
                id: info.item_id,
                name,
                folder: info.filetype == ffi::LIBMTP_filetype_t_LIBMTP_FILETYPE_FOLDER,
                bytes: info.filesize,
            });
            let next = info.next;
            unsafe {
                (*item).next = ptr::null_mut();
                ffi::LIBMTP_destroy_file_t(item)
            };
            item = next;
        }
        self.check(0, "list watch folders")?;
        Ok(files)
    }
    fn folder(&mut self, parent: u32, name: &str) -> Result<u32> {
        let name = CString::new(name)?;
        let id = unsafe {
            ffi::LIBMTP_Create_Folder(self.device, name.as_ptr().cast_mut(), parent, self.storage)
        };
        self.check(if id == 0 { -1 } else { 0 }, "create music folder")?;
        Ok(id)
    }
    fn upload(
        &mut self,
        parent: u32,
        name: &str,
        bytes: &[u8],
        cancel: &AtomicBool,
    ) -> Result<u32> {
        let filetype = filetype_for_name(name);
        let name = CString::new(name)?;
        let file = unsafe { ffi::LIBMTP_new_file_t() };
        ensure!(!file.is_null(), "Could not allocate MTP file metadata");
        // libmtp owns the filename in file_t; use its matching allocator.
        unsafe {
            (*file).filename = libc::strdup(name.as_ptr());
            if (*file).filename.is_null() {
                ffi::LIBMTP_destroy_file_t(file);
                bail!("Could not allocate MTP filename");
            }
            (*file).parent_id = parent;
            (*file).storage_id = self.storage;
            (*file).filesize = bytes.len() as u64;
            (*file).filetype = filetype;
        }
        let mut state = Upload {
            bytes,
            offset: 0,
            cancel,
        };
        let code = unsafe {
            ffi::LIBMTP_Send_File_From_Handler(
                self.device,
                Some(get_bytes),
                (&mut state as *mut Upload<'_>).cast(),
                file,
                None,
                ptr::null(),
            )
        };
        let id = unsafe { (*file).item_id };
        unsafe { ffi::LIBMTP_destroy_file_t(file) };
        let result = self.check(code, "send music to the watch");
        if result.is_err()
            || cancel.load(Ordering::Relaxed)
            || state.offset != bytes.len()
            || id == 0
        {
            if id != 0 && self.delete(id).is_err() {
                bail!(
                    "Part of a music file could not be removed. Reconnect the watch and check its Music folder before retrying."
                );
            }
            result?;
            bail!("Transfer cancelled or incomplete");
        }
        Ok(id)
    }
    fn verify(&mut self, id: u32, bytes: &[u8], cancel: &AtomicBool) -> Result<()> {
        let mut state = Verify {
            hash: Sha256::new(),
            count: 0,
            cancel,
            playlist: (!bytes.starts_with(b"ID3")).then(Vec::new),
            playlist_limit: bytes.len().saturating_mul(8).saturating_add(65536),
        };
        let code = unsafe {
            ffi::LIBMTP_Get_File_To_Handler(
                self.device,
                id,
                Some(put_bytes),
                (&mut state as *mut Verify<'_>).cast(),
                None,
                ptr::null(),
            )
        };
        self.check(code, "verify the transferred music")?;
        ensure!(!cancel.load(Ordering::Relaxed), "Transfer cancelled");
        if let Some(received) = state.playlist {
            super::verify_playlist(bytes, &received)?;
        } else {
            ensure!(
                state.count == bytes.len() as u64 && state.hash.finalize() == Sha256::digest(bytes),
                "Watch read-back verification failed"
            );
        }
        Ok(())
    }
    fn delete(&mut self, id: u32) -> Result<()> {
        self.check(
            unsafe { ffi::LIBMTP_Delete_Object(self.device, id) },
            "remove an incomplete transfer",
        )
    }
}

fn filetype_for_name(name: &str) -> ffi::LIBMTP_filetype_t {
    let lower = name.to_ascii_lowercase();
    if lower.ends_with(".mp3") {
        ffi::LIBMTP_filetype_t_LIBMTP_FILETYPE_MP3
    } else if lower.ends_with(".m3u8") || lower.ends_with(".m3u") {
        ffi::LIBMTP_filetype_t_LIBMTP_FILETYPE_PLAYLIST
    } else {
        ffi::LIBMTP_filetype_t_LIBMTP_FILETYPE_UNKNOWN
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn playlist_upload_uses_mtp_playlist_type() {
        assert_eq!(
            filetype_for_name("Test.M3U8"),
            ffi::LIBMTP_filetype_t_LIBMTP_FILETYPE_PLAYLIST
        );
        assert_eq!(
            filetype_for_name("Test.m3u"),
            ffi::LIBMTP_filetype_t_LIBMTP_FILETYPE_PLAYLIST
        );
        assert_eq!(
            filetype_for_name("Track.mp3"),
            ffi::LIBMTP_filetype_t_LIBMTP_FILETYPE_MP3
        );
    }
    #[test]
    fn busy_device_does_not_discard_available_watch() {
        let scan = collect_watches([(1, 2, false), (1, 3, true)], |ok, bus, number| {
            if !ok {
                bail!("private device error")
            }
            Ok(vec![Watch {
                bus,
                number,
                storage_id: 4,
                fingerprint: "fake".into(),
                model: "Synthetic Garmin".into(),
                firmware: "1".into(),
                free_bytes: 10,
                total_bytes: 20,
            }])
        });
        assert_eq!(scan.watches.len(), 1);
        assert_eq!(scan.watches[0].key(), "1:3:4");
        assert_eq!(scan.unavailable.len(), 1);
        assert!(!scan.unavailable[0].reason.contains("private"));
    }
    #[test]
    fn inaccessible_storage_is_reported_without_hiding_other_devices() {
        let scan = collect_watches([(1, 2, false), (2, 5, true)], |ok, bus, number| {
            Ok(if ok {
                vec![Watch {
                    bus,
                    number,
                    storage_id: 7,
                    fingerprint: "fake".into(),
                    model: "Synthetic Garmin".into(),
                    firmware: "1".into(),
                    free_bytes: 10,
                    total_bytes: 20,
                }]
            } else {
                vec![]
            })
        });
        assert_eq!(scan.watches[0].key(), "2:5:7");
        assert_eq!(scan.unavailable[0].number, 2);
    }
}
