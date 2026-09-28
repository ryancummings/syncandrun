//! Read-only, bounded diagnostics for a Garmin device that is not appearing.
use std::{
    fs::File,
    path::PathBuf,
    process::{Command, Stdio},
    thread,
    time::{Duration, Instant},
};
use syncandrun_core::device;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum MtpProbe {
    #[default]
    Skipped,
    Missing,
    Passed,
    Failed,
    TimedOut,
}

#[derive(Clone, Debug, Default)]
pub struct WatchDiagnostics {
    pub lsusb_available: bool,
    pub usb_seen: bool,
    pub usb_access: Option<bool>,
    pub udev_mtp: Option<bool>,
    pub possible_holders: Vec<String>,
    pub ready: usize,
    pub unavailable: Vec<String>,
    pub scan_failed: bool,
    pub mtp_probe: MtpProbe,
}

fn garmin_usb_node() -> (bool, bool, Option<PathBuf>) {
    let Ok(output) = Command::new("lsusb").output() else {
        return (false, false, None);
    };
    if !output.status.success() {
        return (false, false, None);
    }
    for line in String::from_utf8_lossy(&output.stdout).lines() {
        let lower = line.to_ascii_lowercase();
        if !lower.contains("garmin") && !lower.contains("091e:") {
            continue;
        }
        let parts: Vec<_> = line.split_whitespace().collect();
        let node = if parts.len() >= 4 && parts[0] == "Bus" && parts[2] == "Device" {
            let bus = parts[1].parse::<u16>().ok();
            let device = parts[3].trim_end_matches(':').parse::<u16>().ok();
            bus.zip(device)
                .filter(|(bus, device)| *bus <= 999 && *device <= 999)
                .map(|(bus, device)| PathBuf::from(format!("/dev/bus/usb/{bus:03}/{device:03}")))
        } else {
            None
        };
        return (true, true, node);
    }
    (true, false, None)
}

fn possible_holders() -> Vec<String> {
    let Ok(output) = Command::new("ps").args(["-eo", "comm="]).output() else {
        return Vec::new();
    };
    if !output.status.success() {
        return Vec::new();
    }
    let mut names: Vec<String> = String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(str::trim)
        .filter(|name| {
            matches!(
                *name,
                "gvfsd-mtp" | "mtp-detect" | "OpenMTP" | "openmtp" | "garmin-express"
            )
        })
        .map(str::to_owned)
        .collect();
    names.sort();
    names.dedup();
    names
}

fn mtp_detect() -> MtpProbe {
    let Ok(mut child) = Command::new("mtp-detect")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
    else {
        return MtpProbe::Missing;
    };
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                return if status.success() {
                    MtpProbe::Passed
                } else {
                    MtpProbe::Failed
                };
            }
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(100)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return MtpProbe::TimedOut;
            }
        }
    }
}

impl WatchDiagnostics {
    pub fn run() -> Self {
        let mut result = Self::default();
        let (available, seen, node) = garmin_usb_node();
        result.lsusb_available = available;
        result.usb_seen = seen;
        if let Some(node) = node {
            result.usb_access = Some(File::open(&node).is_ok());
            if let Ok(output) = Command::new("udevadm")
                .args(["info", "--query=property", "--name"])
                .arg(&node)
                .output()
                && output.status.success()
            {
                result.udev_mtp = Some(
                    String::from_utf8_lossy(&output.stdout)
                        .lines()
                        .any(|line| line == "ID_MTP_DEVICE=1"),
                );
            }
        }
        result.possible_holders = possible_holders();
        match device::discover_with_unavailable() {
            Ok(found) => {
                result.ready = found.watches.len();
                result.unavailable = found
                    .unavailable
                    .into_iter()
                    .map(|watch| watch.reason)
                    .collect();
            }
            Err(_) => result.scan_failed = true,
        }
        if result.usb_seen && result.ready == 0 {
            result.mtp_probe = mtp_detect();
        }
        result
    }

    pub fn summary(&self) -> String {
        let usb = if !self.lsusb_available {
            "lsusb unavailable"
        } else if self.usb_seen {
            "Garmin visible on USB"
        } else {
            "No Garmin visible on USB"
        };
        let access = match self.usb_access {
            Some(true) => "USB node readable",
            Some(false) => "USB node access denied",
            None => "USB access unknown",
        };
        let mtp = if self.ready > 0 {
            "SyncAndRun can open the device"
        } else if self.scan_failed {
            "SyncAndRun scan failed"
        } else if !self.unavailable.is_empty() {
            "Garmin found but unavailable to MTP"
        } else {
            "No usable Garmin MTP device found"
        };
        let probe = match self.mtp_probe {
            MtpProbe::Skipped => "mtp-detect skipped",
            MtpProbe::Missing => "mtp-detect unavailable",
            MtpProbe::Passed => "mtp-detect opened an MTP device",
            MtpProbe::Failed => "mtp-detect could not open an MTP device",
            MtpProbe::TimedOut => "mtp-detect timed out after 5 seconds",
        };
        let holders = if self.possible_holders.is_empty() {
            "No known MTP holder process found".into()
        } else {
            format!("Possible MTP holder: {}", self.possible_holders.join(", "))
        };
        let udev = match self.udev_mtp {
            Some(true) => "udev marked MTP",
            Some(false) => "udev did not mark MTP",
            None => "udev MTP state unknown",
        };
        let unavailable = if self.unavailable.is_empty() {
            String::new()
        } else {
            format!("\nReason: {}", self.unavailable[0])
        };
        format!(
            "USB: {usb}\nAccess: {access}\nudev: {udev}\nMTP: {mtp}{unavailable}\nProbe: {probe}\n{holders}"
        )
    }

    pub fn steps(&self) -> Vec<&'static str> {
        if self.ready > 0 {
            return vec![
                "The device is available. Close this dialog and select Scan for device if the card has not refreshed.",
            ];
        }
        let mut steps = Vec::new();
        if !self.lsusb_available {
            steps.push(
                "Install usbutils for the USB visibility check, then run troubleshooting again.",
            );
            if !self.unavailable.is_empty() {
                steps.push("SyncAndRun sees a Garmin but cannot open it. Close Files and other MTP applications, then reconnect the device.");
            }
            return steps;
        }
        if !self.usb_seen {
            steps.push("Reconnect with a data-capable cable directly to the computer. Unlock the device and select USB/MTP mode if asked. Try another port or cable if it still does not appear.");
            return steps;
        }
        if self.usb_access == Some(false) {
            steps.push("The current user cannot open the Garmin USB device. Check the system's udev/libmtp permissions, reconnect the device, then run troubleshooting again.");
        }
        if !self.possible_holders.is_empty() || !self.unavailable.is_empty() {
            steps.push("Close Files and other MTP applications, unmount the device there, then reconnect and use Scan for device.");
        }
        if self.udev_mtp == Some(false) {
            steps.push("The USB device was not marked as MTP by udev. Check the Garmin device's USB mode and installed libmtp/udev rules.");
        }
        match self.mtp_probe {
            MtpProbe::Missing => steps.push("Install mtp-tools for a separate MTP check, then run troubleshooting again."),
            MtpProbe::TimedOut => steps.push("The MTP probe timed out. Disconnect and reconnect the device, close other MTP tools, then try again."),
            MtpProbe::Passed => steps.push("A separate MTP tool can open the device. Close it, then rescan in SyncAndRun. If the Garmin device still stays hidden, ask an agent to inspect device recognition."),
            _ => {}
        }
        if steps.is_empty() {
            steps.push("Reconnect the device in USB/MTP mode, close other MTP applications, and run Scan for device. Use the agent prompt below if it still does not appear.");
        }
        steps
    }

    pub fn agent_prompt(&self) -> String {
        format!(
            "Help diagnose why SyncAndRun on Linux cannot connect to my Garmin music device. Use read-only checks first; do not access my music library, profile, credentials, or other private data, and do not change USB rules or install packages without asking. I already tried the in-app troubleshooting checks. Sanitized results:\n{}\nPlease identify the likely cause, give the smallest safe fix, and tell me how to verify the device appears in SyncAndRun. Do not include device serial numbers, paths, or private media in your answer.",
            self.summary()
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn guidance_follows_the_observed_failure_without_private_details() {
        let absent = WatchDiagnostics {
            lsusb_available: true,
            ..Default::default()
        };
        assert!(absent.steps()[0].contains("data-capable cable"));
        assert!(WatchDiagnostics::default().steps()[0].contains("usbutils"));
        let blocked = WatchDiagnostics {
            lsusb_available: true,
            usb_seen: true,
            usb_access: Some(false),
            unavailable: vec!["Garmin unavailable".into()],
            ..Default::default()
        };
        assert!(
            blocked
                .steps()
                .iter()
                .any(|step| step.contains("udev/libmtp"))
        );
        assert!(!blocked.agent_prompt().contains("/dev/bus"));
        let ready = WatchDiagnostics {
            ready: 1,
            ..Default::default()
        };
        assert_eq!(ready.steps().len(), 1);
    }
}
