use anyhow::{Context, Result, ensure};
use clap::{Parser, Subcommand, ValueEnum};
use std::{
    io::{self, IsTerminal, Write},
    path::PathBuf,
    sync::{Arc, atomic::AtomicBool},
};
use syncandrun_core::{
    device,
    export::{self, Route},
    jellyfin::Jellyfin,
    plex::{self, Plex},
    profile::{self, Profile, Provider},
    provider::MusicSource,
};

#[derive(Parser)]
#[command(
    version,
    about = "Export Plex, Jellyfin, or local music for a Garmin device"
)]
struct Args {
    /// Profile folder containing secret and data/syncandrun.sqlite
    #[arg(long, global = true)]
    profile: Option<PathBuf>,
    #[command(subcommand)]
    command: Command,
}
#[derive(Subcommand)]
enum Command {
    /// Identify connected Garmin devices and writable storage over USB MTP
    Devices,
    /// Transfer playlists directly to a Garmin device, without a local export folder
    Transfer {
        #[arg(long = "playlist")]
        playlists: Vec<String>,
        #[arg(long, default_value = "192")]
        bitrate: u16,
        /// Device key from the devices command (required when several are connected)
        #[arg(long)]
        device: Option<String>,
        /// Replace recognized content in the watch Music folder after verification
        #[arg(long, requires = "yes_replace_music")]
        replace_music: bool,
        /// Confirm permanent removal of other watch music during --replace-music
        #[arg(long)]
        yes_replace_music: bool,
        /// Share one track file across playlists (tested on Forerunner 955)
        #[arg(long, conflicts_with = "replace_music")]
        shared_tracks: bool,
    },
    /// Sign in using your browser, then choose a server and music library
    Login,
    /// Sign in to Jellyfin and choose a music library (password is never an argument)
    LoginJellyfin {
        #[arg(long)]
        server: String,
        #[arg(long)]
        username: String,
        /// Read the password from one line of standard input, for automation
        #[arg(long)]
        password_stdin: bool,
        /// Choose a known music library ID instead of prompting
        #[arg(long)]
        library: Option<String>,
    },
    /// Choose a local MP3/FLAC folder and make it the active music source
    LocalFolder { folder: PathBuf },
    /// Switch to a saved connection; clears playlist selection and snapshots
    Source {
        #[arg(value_enum)]
        provider: SourceName,
    },
    /// Show connection state without revealing credentials
    Status,
    /// List available audio playlists and their IDs
    Playlists {
        #[arg(long)]
        json: bool,
    },
    /// Refresh saved snapshots (defaults to the saved playlist selection)
    Refresh {
        #[arg(long = "playlist")]
        playlists: Vec<String>,
    },
    /// Estimate an export using saved snapshots; no downloads
    Estimate {
        #[arg(long = "playlist")]
        playlists: Vec<String>,
        #[arg(long, default_value = "192")]
        bitrate: u16,
        #[arg(long, default_value = "mtp")]
        route: Route,
    },
    /// Refresh playlists and create a new export folder
    Export {
        #[arg(long = "playlist")]
        playlists: Vec<String>,
        #[arg(long)]
        destination: PathBuf,
        #[arg(long, default_value = "192")]
        bitrate: u16,
        #[arg(long, default_value = "mtp")]
        route: Route,
        /// Use previously saved snapshots instead of refreshing
        #[arg(long)]
        offline_plan: bool,
    },
    /// Back up the database and matching encryption secret into a private folder
    Backup {
        #[arg(long)]
        destination: PathBuf,
    },
}
#[derive(Clone, Copy, ValueEnum)]
enum SourceName {
    Plex,
    Jellyfin,
    Local,
}

fn read_password(from_stdin: bool) -> Result<String> {
    if from_stdin {
        let mut password = String::new();
        io::stdin().read_line(&mut password)?;
        if password.ends_with('\n') {
            password.pop();
            if password.ends_with('\r') {
                password.pop();
            }
        }
        Ok(password)
    } else {
        ensure!(
            io::stdin().is_terminal(),
            "Use an interactive terminal, or --password-stdin to read the password securely"
        );
        rpassword::prompt_password("Jellyfin password: ").context("Cannot read password")
    }
}

fn choose(labels: &[String], what: &str) -> Result<usize> {
    ensure!(!labels.is_empty(), "No {what} available");
    for (i, label) in labels.iter().enumerate() {
        println!("{}: {}", i + 1, label.escape_default());
    }
    print!("Choose {what} [1-{}]: ", labels.len());
    io::stdout().flush()?;
    let mut input = String::new();
    io::stdin().read_line(&mut input)?;
    let index: usize = input.trim().parse().context("Enter a list number")?;
    ensure!(index > 0 && index <= labels.len(), "Selection out of range");
    Ok(index - 1)
}
fn ids(profile: &Profile, supplied: Vec<String>) -> Result<Vec<String>> {
    if supplied.is_empty() {
        profile.selected_ids()
    } else {
        Ok(supplied)
    }
}
fn run(args: Args) -> Result<()> {
    if matches!(args.command, Command::Devices) {
        let scan = device::discover_with_unavailable()?;
        if scan.watches.is_empty() {
            println!(
                "{}",
                if scan.unavailable.is_empty() {
                    "No Garmin device connected."
                } else {
                    "No usable Garmin device found."
                }
            );
        }
        for watch in scan.watches {
            println!(
                "{}  {}  firmware {}  {:.2} GB free / {:.2} GB",
                watch.key(),
                watch.model,
                watch.firmware,
                watch.free_bytes as f64 / 1e9,
                watch.total_bytes as f64 / 1e9
            );
        }
        for unavailable in scan.unavailable {
            eprintln!(
                "{}:{}  {}",
                unavailable.bus, unavailable.number, unavailable.reason
            );
        }
        return Ok(());
    }
    let path = args.profile.map(Ok).unwrap_or_else(profile::default_path)?;
    let mut profile = Profile::open(path)?;
    let source = MusicSource::new(&profile)?;
    let cancel = Arc::new(AtomicBool::new(false));
    let signal = cancel.clone();
    ctrlc::set_handler(move || signal.store(true, std::sync::atomic::Ordering::Relaxed))?;
    match args.command {
        Command::Devices => unreachable!(),
        Command::Transfer {
            playlists,
            bitrate,
            device: key,
            replace_music,
            yes_replace_music: _,
            shared_tracks,
        } => {
            profile.active_provider()?.validate_bitrate(bitrate)?;
            let scan = device::discover_with_unavailable()?;
            for unavailable in scan.unavailable {
                eprintln!(
                    "{}:{}  {}",
                    unavailable.bus, unavailable.number, unavailable.reason
                );
            }
            let watches = scan.watches;
            let watch = match key {
                Some(key) => watches
                    .iter()
                    .find(|w| w.key() == key)
                    .context("Selected Garmin device is not connected")?,
                None => {
                    ensure!(
                        watches.len() == 1,
                        "Connect one Garmin device, or use --device bus:number:storage_id from devices"
                    );
                    &watches[0]
                }
            };
            let selected = ids(&profile, playlists)?;
            let plan = source.refresh(&mut profile, &selected, &cancel)?;
            let audio = |t: &syncandrun_core::Track, b| source.audio(&profile, t, b);
            let progress = |p: device::TransferProgress| {
                eprintln!(
                    "{}: {}/{} tracks",
                    p.phase, p.tracks.completed, p.tracks.expected
                )
            };
            let result = if replace_music {
                device::replace_music(watch, &plan, bitrate, &cancel, audio, progress)?
            } else if shared_tracks {
                device::transfer_shared(watch, &plan, bitrate, &cancel, audio, progress)?
            } else {
                device::transfer(watch, &plan, bitrate, &cancel, audio, progress)?
            };
            println!(
                "Transferred and verified {} tracks in {} playlists on {}; removed {} old music objects.",
                result.tracks, result.playlists, watch.model, result.removed
            );
        }
        Command::Login => {
            let plex = Plex::new(&profile)?;
            eprintln!(
                "Opening Plex in your browser. Complete sign-in there; this command will wait."
            );
            let login = plex.login(&profile, &cancel, plex::open_browser)?;
            let n = choose(
                &login
                    .servers
                    .iter()
                    .map(|s| s.name.clone())
                    .collect::<Vec<_>>(),
                "server",
            )?;
            let choice = plex.discover(&login.servers[n], &cancel)?;
            let n = choose(
                &choice
                    .libraries
                    .iter()
                    .map(|l| l.title.clone())
                    .collect::<Vec<_>>(),
                "music library",
            )?;
            plex.connect(&mut profile, &login, &choice, &choice.libraries[n].key)?;
            println!("Connected to Plex.");
        }
        Command::LoginJellyfin {
            server,
            username,
            password_stdin,
            library,
        } => {
            let password = read_password(password_stdin)?;
            let jellyfin = Jellyfin::new(&profile)?;
            let login = jellyfin.authenticate(&server, &username, &password, &cancel);
            drop(password);
            let login = login?;
            let library_id = match library {
                Some(id) => id,
                None if login.libraries.len() == 1 => login.libraries[0].id.clone(),
                None => {
                    let n = choose(
                        &login
                            .libraries
                            .iter()
                            .map(|l| l.title.clone())
                            .collect::<Vec<_>>(),
                        "music library",
                    )?;
                    login.libraries[n].id.clone()
                }
            };
            jellyfin.connect(&mut profile, &login, &library_id)?;
            println!("Connected to Jellyfin.");
        }
        Command::Source { provider } => {
            let provider = match provider {
                SourceName::Plex => Provider::Plex,
                SourceName::Jellyfin => Provider::Jellyfin,
                SourceName::Local => Provider::Local,
            };
            profile.set_active_provider(provider)?;
            println!(
                "Using {}. Choose playlists again before exporting.",
                provider.label()
            );
        }
        Command::LocalFolder { folder } => {
            profile.set_local_folder(&folder)?;
            println!("Local folder selected. Choose playlists again before exporting.");
        }
        Command::Status => {
            let provider = profile.active_provider()?;
            let connected = match provider {
                Provider::Plex => profile.connection()?.is_some(),
                Provider::Jellyfin => profile.jellyfin_connection()?.is_some(),
                Provider::Local => profile.local_folder()?.is_some(),
            };
            if connected {
                println!("Connected to {}", provider.label());
            } else {
                println!("Not connected; run syncandrun login or login-jellyfin");
            }
        }
        Command::Playlists { json } => {
            let playlists = source.playlists(&profile, &cancel)?;
            if json {
                println!("{}", serde_json::to_string_pretty(&playlists)?);
            } else {
                for p in playlists {
                    println!(
                        "{}\t{} tracks\t{}",
                        p.id,
                        p.track_count,
                        p.title.escape_default()
                    );
                }
            }
        }
        Command::Refresh { playlists } => {
            let selected = ids(&profile, playlists)?;
            let plan = source.refresh(&mut profile, &selected, &cancel)?;
            println!("Refreshed {} playlists.", plan.len());
        }
        Command::Estimate {
            playlists,
            bitrate,
            route,
        } => {
            profile.active_provider()?.validate_bitrate(bitrate)?;
            let plan = profile.plan(&ids(&profile, playlists)?)?;
            println!(
                "{}",
                serde_json::to_string_pretty(&export::estimate(&plan, bitrate, route)?)?
            );
        }
        Command::Export {
            playlists,
            destination,
            bitrate,
            route,
            offline_plan,
        } => {
            profile.active_provider()?.validate_bitrate(bitrate)?;
            let selected = ids(&profile, playlists)?;
            let plan = if offline_plan {
                profile.plan(&selected)?
            } else {
                source.refresh(&mut profile, &selected, &cancel)?
            };
            let output = export::export(
                &plan,
                bitrate,
                route,
                &destination,
                &cancel,
                |t, b| source.audio(&profile, t, b),
                |p| eprintln!("{}/{} tracks", p.completed, p.expected),
            )?;
            println!("{}", output.display());
            eprintln!(
                "Files ready. Copy the exported playlist folders to the device's Music folder with an MTP app."
            );
        }
        Command::Backup { destination } => {
            let path = profile.backup(&destination)?;
            println!("{}", path.display());
        }
    }
    Ok(())
}
fn main() {
    if let Err(error) = run(Args::parse()) {
        eprintln!("Error: {error:#}");
        std::process::exit(1);
    }
}
