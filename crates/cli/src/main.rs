use anyhow::{Context, Result, ensure};
use clap::{Parser, Subcommand};
use std::{
    io::{self, Write},
    path::PathBuf,
    sync::{Arc, atomic::AtomicBool},
};
use syncandrun_core::{
    export::{self, Route},
    plex::{self, Plex},
    profile::{self, Profile},
};

#[derive(Parser)]
#[command(version, about = "Export Plex music playlists for a Garmin watch")]
struct Args {
    /// Profile folder containing secret and data/syncandrun.sqlite
    #[arg(long, global = true)]
    profile: Option<PathBuf>,
    #[command(subcommand)]
    command: Command,
}
#[derive(Subcommand)]
enum Command {
    /// Sign in using your browser, then choose a server and music library
    Login,
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
    let path = args.profile.map(Ok).unwrap_or_else(profile::default_path)?;
    let mut profile = Profile::open(path)?;
    let plex = Plex::new(&profile)?;
    let cancel = Arc::new(AtomicBool::new(false));
    let signal = cancel.clone();
    ctrlc::set_handler(move || signal.store(true, std::sync::atomic::Ordering::Relaxed))?;
    match args.command {
        Command::Login => {
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
        Command::Status => println!(
            "{}",
            if profile.connection()?.is_some() {
                "Connected to Plex"
            } else {
                "Not connected; run syncandrun login"
            }
        ),
        Command::Playlists { json } => {
            let connection = profile
                .connection()?
                .context("Run syncandrun login first")?;
            let playlists = plex.playlists(&connection, &cancel)?;
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
            let plan = plex.refresh(&mut profile, &selected, &cancel)?;
            println!("Refreshed {} playlists.", plan.len());
        }
        Command::Estimate {
            playlists,
            bitrate,
            route,
        } => {
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
            ensure!(
                syncandrun_core::BITRATES.contains(&bitrate),
                "Unsupported MP3 bitrate"
            );
            let selected = ids(&profile, playlists)?;
            let plan = if offline_plan {
                profile.plan(&selected)?
            } else {
                plex.refresh(&mut profile, &selected, &cancel)?
            };
            let connection = profile
                .connection()?
                .context("Run syncandrun login first")?;
            let output = export::export(
                &plan,
                bitrate,
                route,
                &destination,
                &cancel,
                |t, b| plex.audio(&connection, t, b),
                |p| eprintln!("{}/{} tracks", p.completed, p.expected),
            )?;
            println!("{}", output.display());
            eprintln!(
                "Files ready. Copy the exported playlist folders to the watch's Music folder with an MTP app."
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
