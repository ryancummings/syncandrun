//! Read-only Garmin USB diagnostics for macOS.
use std::process::Command;
use syncandrun_core::device;

#[derive(Clone, Debug, Default)]
pub struct WatchDiagnostics {
    usb_check_available: bool,
    usb_seen: bool,
    possible_holders: Vec<String>,
    ready: usize,
    unavailable: Vec<String>,
    scan_failed: bool,
}

impl WatchDiagnostics {
    pub fn run() -> Self {
        let mut result = Self::default();
        if let Ok(output) = Command::new("ioreg")
            .args(["-p", "IOUSB", "-l", "-w0"])
            .output()
            && output.status.success()
        {
            result.usb_check_available = true;
            let listing = String::from_utf8_lossy(&output.stdout);
            result.usb_seen = listing.lines().any(|line| {
                line.contains("\"idVendor\" = 2334") || line.contains("\"idVendor\" = 0x091e")
            });
        }
        if let Ok(output) = Command::new("ps").args(["-A", "-o", "comm="]).output()
            && output.status.success()
        {
            let listing = String::from_utf8_lossy(&output.stdout).to_ascii_lowercase();
            for (needle, label) in [
                ("garmin express", "Garmin Express"),
                ("openmtp", "OpenMTP"),
                ("ptpcamerad", "macOS camera service"),
            ] {
                if listing.contains(needle) {
                    result.possible_holders.push(label.into());
                }
            }
        }
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
        result
    }

    pub fn summary(&self) -> String {
        let usb = if !self.usb_check_available {
            "USB visibility check unavailable"
        } else if self.usb_seen {
            "Garmin visible on USB"
        } else {
            "No Garmin visible on USB"
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
        let holders = if self.possible_holders.is_empty() {
            "No known MTP holder process found".into()
        } else {
            format!("Possible MTP holder: {}", self.possible_holders.join(", "))
        };
        let unavailable = self
            .unavailable
            .first()
            .map(|reason| format!("\nReason: {reason}"))
            .unwrap_or_default();
        format!("USB: {usb}\nMTP: {mtp}{unavailable}\n{holders}")
    }

    pub fn steps(&self) -> Vec<&'static str> {
        if self.ready > 0 {
            return vec![
                "The device is available. Close this dialog and select Scan for device if the card has not refreshed.",
            ];
        }
        if !self.usb_check_available {
            return vec![
                "macOS could not complete the USB check. Reconnect the watch, then run troubleshooting again.",
            ];
        }
        if !self.usb_seen {
            return vec![
                "Reconnect with a data-capable cable directly to the Mac. Unlock the watch and select USB/MTP mode if asked. Try another port or cable if it still does not appear.",
            ];
        }
        let mut steps = Vec::new();
        if !self.possible_holders.is_empty() || !self.unavailable.is_empty() {
            steps.push("Quit Garmin Express, OpenMTP, and other apps using the watch, then reconnect it and select Scan for device.");
        }
        steps.push("If the watch still cannot open, disconnect it, wait a few seconds, reconnect it in USB/MTP mode, and run Scan for device.");
        steps
    }

    pub fn agent_prompt(&self) -> String {
        format!(
            "Help diagnose why SyncAndRun on macOS cannot connect to my Garmin music device. Use read-only checks first; do not access my music library, profile, credentials, or other private data, and do not change software or device settings without asking. Sanitized results:\n{}\nPlease identify the likely cause, give the smallest safe fix, and tell me how to verify the device appears in SyncAndRun. Do not include device serial numbers, paths, or private media in your answer.",
            self.summary()
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mac_guidance_identifies_usb_contention_without_private_details() {
        let diagnostics = WatchDiagnostics {
            usb_check_available: true,
            usb_seen: true,
            possible_holders: vec!["Garmin Express".into()],
            ..Default::default()
        };
        assert!(diagnostics.steps()[0].contains("Quit Garmin Express"));
        assert!(diagnostics.agent_prompt().contains("on macOS"));
    }
}
