mod input;
#[cfg(not(target_os = "macos"))]
mod watch_diagnostics;
#[cfg(target_os = "macos")]
#[path = "watch_diagnostics_macos.rs"]
mod watch_diagnostics;

use anyhow::{Context as _, Result, ensure};
use gpui::{prelude::*, *};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashSet,
    fs,
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
    time::{Duration, Instant},
};
use syncandrun_core::{
    BITRATES,
    device::{self, Discovery, Watch},
    export::{self, Progress},
    jellyfin::{Jellyfin, JellyfinLogin},
    plex::{self, LibraryOverview, Login, PlaylistSummary, Plex, ServerChoice},
    profile::{self, Profile, Provider},
    provider::MusicSource,
};
use watch_diagnostics::WatchDiagnostics;

enum Event {
    WatchDiagnostics(WatchDiagnostics),
    SourceAvailability([bool; 3]),
    Watches(Result<Discovery, String>),
    MusicItems(Vec<device::MusicItem>),
    MusicRemoved {
        count: usize,
        items: Result<Vec<device::MusicItem>, String>,
    },
    WatchProgress(device::TransferProgress),
    Transferred(device::TransferResult),
    Loaded {
        provider: Provider,
        source_revision: String,
        connected: bool,
        playlists: Vec<PlaylistSummary>,
        selected: Vec<String>,
        server: Option<(String, String, String)>,
        overview: Option<LibraryOverview>,
    },
    ConnectionUnavailable(Provider, String, String, (String, String, String)),
    JellyfinSignedIn(JellyfinLogin),
    SetupRequired(Provider),
    SignedIn(Login),
    Discovered(ServerChoice),
    Connected,
    Progress(Progress),
    Exported(PathBuf),
    Purged(export::PurgeResult),
    PreferencesFailed(String),
    Failed(String),
}
#[derive(Default, Serialize, Deserialize)]
struct Preferences {
    #[serde(default = "direct_default")]
    direct: bool,
    selected: Vec<String>,
    #[serde(default)]
    provider: Option<Provider>,
    #[serde(default)]
    source_revision: String,
    #[serde(default)]
    library_folder: Option<PathBuf>,
    #[serde(
        default,
        rename = "destination",
        skip_serializing_if = "Option::is_none"
    )]
    legacy_destination: Option<PathBuf>,
    bitrate: Option<u16>,
}
fn direct_default() -> bool {
    true
}
fn default_library_path() -> Option<PathBuf> {
    std::env::var_os("HOME").map(|home| PathBuf::from(home).join("Music/SyncAndRun"))
}
fn preferences_path(profile: &std::path::Path) -> PathBuf {
    profile.join("desktop-preferences.json")
}
fn read_preferences(profile: &std::path::Path) -> Option<Preferences> {
    fs::read(preferences_path(profile))
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
}
fn chosen_library(prefs: &Preferences) -> Option<PathBuf> {
    prefs.library_folder.clone().or_else(|| {
        prefs.legacy_destination.as_ref().and_then(|parent| {
            let library = parent.join("SyncAndRun Music");
            library
                .join(".syncandrun-files.json")
                .exists()
                .then_some(library)
        })
    })
}
struct Desktop {
    profile: PathBuf,
    usb_enabled: bool,
    watches: Vec<Watch>,
    selected_watch: Option<String>,
    watch_status: String,
    watch_diagnostics: Option<WatchDiagnostics>,
    watch_diagnostic_running: bool,
    watch_prompt_copied: bool,
    watch_diagnostic_started: Option<Instant>,
    last_diagnostic_tick: Instant,
    page: Page,
    music_items: Vec<device::MusicItem>,
    replace_watch_music: bool,
    scanning: bool,
    last_scan: Instant,
    last_monitor_tick: Instant,
    monitor_started: Instant,
    direct: bool,
    connected: bool,
    provider: Provider,
    saved_sources: [Option<bool>; 3],
    cached_sources: [Option<CachedSource>; 3],
    source_loading: bool,
    previous_provider: Option<Provider>,
    preference_provider: Option<Provider>,
    source_revision: String,
    jellyfin_setup: bool,
    jellyfin_login: Option<Arc<JellyfinLogin>>,
    jellyfin_url: Entity<input::Input>,
    jellyfin_user: Entity<input::Input>,
    jellyfin_password: Entity<input::Input>,
    playlists: Vec<PlaylistSummary>,
    selected: HashSet<String>,
    server: Option<(String, String, String)>,
    overview: Option<LibraryOverview>,
    connection_status: String,
    login: Option<Arc<Login>>,
    choice: Option<Arc<ServerChoice>>,
    bitrate: u16,
    modal: Option<Modal>,
    destination: Option<PathBuf>,
    using_default_library: bool,
    has_saved_selection: bool,
    output: Option<PathBuf>,
    status: String,
    progress: Option<Progress>,
    watch_progress: Option<device::TransferProgress>,
    watch_done: bool,
    watch_finished_elapsed: Option<Duration>,
    last_stats_tick: Instant,
    export_started: Option<Instant>,
    exporting: bool,
    busy: bool,
    watch_music_may_have_changed: bool,
    watch_music_pending: bool,
    cancel: Arc<AtomicBool>,
    sender: mpsc::Sender<Event>,
    receiver: mpsc::Receiver<Event>,
    preference_sender: mpsc::Sender<Preferences>,
}
#[derive(Clone)]
struct CachedSource {
    playlists: Vec<PlaylistSummary>,
    server: Option<(String, String, String)>,
    overview: Option<LibraryOverview>,
}
fn source_index(provider: Provider) -> usize {
    match provider {
        Provider::Plex => 0,
        Provider::Jellyfin => 1,
        Provider::Local => 2,
    }
}
#[derive(Clone, Copy, PartialEq, Eq)]
enum Page {
    Playlists,
    WatchMusic,
    Settings,
}
enum Modal {
    WatchTroubleshooting,
    CreateDefault(PathBuf),
    ClearLibrary(PathBuf),
    ReplaceMusic(Watch),
    RemoveMusic(Watch, u32, String),
}
impl Drop for Desktop {
    fn drop(&mut self) {
        self.cancel.store(true, Ordering::Relaxed);
    }
}
impl Desktop {
    fn new(profile: PathBuf, usb_enabled: bool, cx: &mut Context<Self>) -> Self {
        let (sender, receiver) = mpsc::channel();
        let (preference_sender, preference_receiver) = mpsc::channel::<Preferences>();
        let preference_path = preferences_path(&profile);
        let preference_events = sender.clone();
        std::thread::spawn(move || {
            while let Ok(mut prefs) = preference_receiver.recv() {
                while let Ok(latest) = preference_receiver.try_recv() {
                    prefs = latest;
                }
                let temp = preference_path.with_extension("json.tmp");
                let result = serde_json::to_vec(&prefs)
                    .map_err(anyhow::Error::from)
                    .and_then(|bytes| {
                        fs::write(&temp, bytes)?;
                        fs::rename(&temp, &preference_path)?;
                        Ok(())
                    });
                if let Err(error) = result {
                    let _ = preference_events.send(Event::PreferencesFailed(error.to_string()));
                }
            }
        });
        let mut this = Self {
            profile,
            usb_enabled,
            watches: Vec::new(),
            selected_watch: None,
            watch_status:
                "Looking for a Garmin device… Detection may take about 30 seconds after connecting."
                    .into(),
            watch_diagnostics: None,
            watch_diagnostic_running: false,
            watch_prompt_copied: false,
            watch_diagnostic_started: None,
            last_diagnostic_tick: Instant::now(),
            page: Page::Playlists,
            music_items: Vec::new(),
            replace_watch_music: false,
            scanning: false,
            last_scan: Instant::now(),
            last_monitor_tick: Instant::now(),
            monitor_started: Instant::now(),
            direct: true,
            connected: false,
            provider: Provider::Plex,
            saved_sources: [None, None, None],
            cached_sources: [None, None, None],
            source_loading: false,
            previous_provider: None,
            preference_provider: None,
            source_revision: String::new(),
            jellyfin_setup: false,
            jellyfin_login: None,
            jellyfin_url: cx.new(|cx| input::Input::new(false, cx)),
            jellyfin_user: cx.new(|cx| input::Input::new(false, cx)),
            jellyfin_password: cx.new(|cx| input::Input::new(true, cx)),
            playlists: vec![],
            selected: HashSet::new(),
            server: None,
            overview: None,
            connection_status: "Checking…".into(),
            login: None,
            choice: None,
            bitrate: 192,
            modal: None,
            destination: None,
            using_default_library: true,
            has_saved_selection: false,
            output: None,
            status: "Opening profile…".into(),
            progress: None,
            watch_progress: None,
            watch_done: false,
            watch_finished_elapsed: None,
            last_stats_tick: Instant::now(),
            export_started: None,
            exporting: false,
            busy: false,
            watch_music_may_have_changed: false,
            watch_music_pending: false,
            cancel: Arc::new(AtomicBool::new(false)),
            sender,
            receiver,
            preference_sender,
        };
        let prefs = read_preferences(&this.profile);
        this.has_saved_selection = prefs.is_some();
        let prefs = prefs.unwrap_or_else(|| Preferences {
            direct: true,
            ..Default::default()
        });
        this.direct = prefs.direct;
        this.preference_provider = prefs.provider;
        this.source_revision = prefs.source_revision.clone();
        let chosen_library = chosen_library(&prefs);
        this.selected = prefs.selected.into_iter().collect();
        this.using_default_library = chosen_library.is_none();
        this.destination = chosen_library.or_else(default_library_path);
        this.bitrate = prefs
            .bitrate
            .filter(|b| BITRATES.contains(b))
            .unwrap_or(192);
        this.load();
        this.scan_watches();
        cx.spawn(async move |view, cx| {
            loop {
                Timer::after(Duration::from_millis(40)).await;
                if view
                    .update(cx, |view, cx| {
                        let mut changed = false;
                        while let Ok(event) = view.receiver.try_recv() {
                            view.apply(event);
                            changed = true;
                        }
                        if view.exporting
                            && view.last_stats_tick.elapsed() >= Duration::from_millis(40)
                        {
                            view.last_stats_tick = Instant::now();
                            changed = true;
                        }
                        if view.watch_diagnostic_running
                            && view.watch_diagnostic_started.is_some_and(|started| {
                                started.elapsed() >= Duration::from_millis(500)
                            })
                            && view.last_diagnostic_tick.elapsed() >= Duration::from_millis(100)
                        {
                            view.last_diagnostic_tick = Instant::now();
                            changed = true;
                        }
                        if view.busy
                            && view.watch_progress.is_some()
                            && view.last_stats_tick.elapsed() >= Duration::from_secs(1)
                        {
                            view.last_stats_tick = Instant::now();
                            changed = true;
                        }
                        if view.usb_enabled
                            && view.watches.is_empty()
                            && view.last_monitor_tick.elapsed() >= Duration::from_millis(40)
                        {
                            view.last_monitor_tick = Instant::now();
                            changed = true;
                        }
                        if view.usb_enabled
                            && !view.busy
                            && !view.watch_diagnostic_running
                            && !view.scanning
                            && view.watches.is_empty()
                            && view.last_scan.elapsed() >= Duration::from_secs(8)
                        {
                            view.scan_watches();
                            changed = true;
                        }
                        if changed {
                            cx.notify();
                        }
                    })
                    .is_err()
                {
                    break;
                }
            }
        })
        .detach();
        this
    }
    fn scan_watches(&mut self) {
        if !self.usb_enabled || self.scanning {
            return;
        }
        self.scanning = true;
        self.last_scan = Instant::now();
        let sender = self.sender.clone();
        std::thread::spawn(move || {
            let result = device::discover_with_unavailable().map_err(|e| e.to_string());
            let _ = sender.send(Event::Watches(result));
        });
    }
    fn run_watch_diagnostics(&mut self) {
        if self.watch_diagnostic_running {
            return;
        }
        self.watch_diagnostic_running = true;
        self.watch_prompt_copied = false;
        self.watch_diagnostics = None;
        self.watch_diagnostic_started = Some(Instant::now());
        let sender = self.sender.clone();
        std::thread::spawn(move || {
            let started = Instant::now();
            let result = WatchDiagnostics::run();
            std::thread::sleep(Duration::from_secs(4).saturating_sub(started.elapsed()));
            let _ = sender.send(Event::WatchDiagnostics(result));
        });
    }
    fn transfer_to_watch(&mut self) {
        if self.busy || self.modal.is_some() || self.scanning {
            return;
        }
        let Some(watch) = self
            .watches
            .iter()
            .find(|w| Some(w.key()) == self.selected_watch)
            .cloned()
        else {
            return;
        };
        let ids: Vec<_> = self
            .playlists
            .iter()
            .filter(|p| self.selected.contains(&p.id))
            .map(|p| p.id.clone())
            .collect();
        if ids.is_empty() {
            return;
        }
        let bitrate = self.bitrate;
        let replace = self.replace_watch_music;
        if replace {
            self.modal = Some(Modal::ReplaceMusic(watch));
            return;
        }
        self.start_watch_transfer(watch, ids, bitrate, false);
    }
    fn start_watch_transfer(
        &mut self,
        watch: Watch,
        ids: Vec<String>,
        bitrate: u16,
        replace: bool,
    ) {
        self.watch_music_may_have_changed = true;
        self.output = None;
        self.progress = None;
        self.watch_progress = None;
        self.watch_done = false;
        self.watch_finished_elapsed = None;
        self.export_started = Some(Instant::now());
        let expected_provider = self.provider;
        let expected_revision = self.source_revision.clone();
        self.job(
            "Refreshing selected playlists for the device…",
            move |path, cancel, sender| {
                let mut profile = Profile::open(path)?;
                ensure!(
                    profile.active_provider()? == expected_provider
                        && profile.source_revision()? == expected_revision,
                    "The music connection changed. Refresh playlists before exporting."
                );
                let source = MusicSource::new(&profile)?;
                let plan = source.refresh(&mut profile, &ids, &cancel)?;
                let source = |t: &syncandrun_core::Track, b| source.audio(&profile, t, b);
                let progress = |p| {
                    let _ = sender.send(Event::WatchProgress(p));
                };
                let result = if replace {
                    device::replace_music(&watch, &plan, bitrate, &cancel, source, progress)?
                } else {
                    device::transfer(&watch, &plan, bitrate, &cancel, source, progress)?
                };
                Ok(Event::Transferred(result))
            },
        );
        self.exporting = true;
    }
    fn inspect_watch_music(&mut self) {
        let Some(watch) = self
            .watches
            .iter()
            .find(|w| Some(w.key()) == self.selected_watch)
            .cloned()
        else {
            return;
        };
        self.job("Reading device Music folder…", move |_, _, _| {
            Ok(Event::MusicItems(device::music_items(&watch)?))
        });
    }
    fn job(
        &mut self,
        status: &str,
        work: impl FnOnce(PathBuf, Arc<AtomicBool>, mpsc::Sender<Event>) -> Result<Event>
        + Send
        + 'static,
    ) {
        if self.busy {
            return;
        }
        self.busy = true;
        self.status = status.to_owned();
        self.cancel = Arc::new(AtomicBool::new(false));
        let cancel = self.cancel.clone();
        let sender = self.sender.clone();
        let path = self.profile.clone();
        std::thread::spawn(move || {
            let event = match work(path, cancel, sender.clone()) {
                Ok(e) => e,
                Err(e) => Event::Failed(format!("{e:#}")),
            };
            let _ = sender.send(event);
        });
    }
    fn load(&mut self) {
        self.job("Loading music playlists…", |path, cancel, sender| {
            let profile = Profile::open(path)?;
            let provider = profile.active_provider()?;
            let source_revision = profile.source_revision()?;
            let saved_sources = [
                profile.has_saved_provider(Provider::Plex)?,
                profile.has_saved_provider(Provider::Jellyfin)?,
                profile.has_saved_provider(Provider::Local)?,
            ];
            let _ = sender.send(Event::SourceAvailability(saved_sources));
            let server = match provider {
                Provider::Plex => profile
                    .connection()?
                    .map(|c| (c.base_uri, c.server_id, c.library_id)),
                Provider::Jellyfin => profile
                    .jellyfin_connection()?
                    .map(|c| (c.base_uri, c.server_id, c.library_id)),
                Provider::Local => profile
                    .local_folder()?
                    .map(|_| ("Local folder".into(), "—".into(), "—".into())),
            };
            let (playlists, overview) = if let Some(server_info) = server.as_ref() {
                let source = MusicSource::new(&profile)?;
                let playlists = match source.playlists(&profile, &cancel) {
                    Ok(playlists) => playlists,
                    Err(error) => {
                        return Ok(Event::ConnectionUnavailable(
                            provider,
                            source_revision,
                            error.to_string(),
                            server_info.clone(),
                        ));
                    }
                };
                (playlists, source.library_overview(&profile).ok())
            } else {
                (vec![], None)
            };
            Ok(Event::Loaded {
                provider,
                source_revision,
                connected: server.is_some(),
                playlists,
                selected: profile.selected_ids()?,
                server,
                overview,
            })
        });
    }
    fn switch_provider(&mut self, provider: Provider, cx: &mut Context<Self>) {
        if self.busy || self.modal.is_some() {
            return;
        }
        if self.provider == provider
            && self.connected
            && !self.jellyfin_setup
            && self.login.is_none()
            && self.choice.is_none()
            && self.jellyfin_login.is_none()
        {
            return;
        }
        if self.connected {
            self.cached_sources[source_index(self.provider)] = Some(CachedSource {
                playlists: self.playlists.clone(),
                server: self.server.clone(),
                overview: self.overview.clone(),
            });
        }
        self.login = None;
        self.choice = None;
        self.jellyfin_login = None;
        self.jellyfin_setup = false;
        self.jellyfin_password
            .update(cx, |input, cx| input.clear(cx));
        self.selected.clear();
        self.page = Page::Playlists;
        self.watch_music_pending = false;
        self.previous_provider = Some(self.provider);
        self.provider = provider;
        self.source_loading = self.saved_sources[source_index(provider)] != Some(false);
        if !provider.bitrates().contains(&self.bitrate) {
            self.bitrate = 256;
        }
        if let Some(cached) = self.cached_sources[source_index(provider)].clone() {
            self.connected = true;
            self.playlists = cached.playlists;
            self.server = cached.server;
            self.overview = cached.overview;
        } else {
            self.connected = self.saved_sources[source_index(provider)] != Some(false);
            self.playlists.clear();
            self.server = None;
            self.overview = None;
        }
        self.connection_status = "Refreshing saved connection…".into();
        self.has_saved_selection = false;
        if !self.source_loading {
            self.previous_provider = None;
            self.jellyfin_setup = provider == Provider::Jellyfin;
            self.connection_status = "No music source selected".into();
            self.status = "Choose a music source to get started.".into();
            return;
        }
        self.job("Switching music source…", move |path, _, _| {
            let mut profile = Profile::open(path)?;
            let saved = profile.has_saved_provider(provider)?;
            if !saved {
                return Ok(Event::SetupRequired(provider));
            }
            profile.set_active_provider(provider)?;
            Ok(Event::Connected)
        });
    }
    fn jellyfin_sign_in(&mut self, cx: &mut Context<Self>) {
        if self.busy {
            return;
        }
        let url = self.jellyfin_url.read(cx).value().to_owned();
        let username = self.jellyfin_user.read(cx).value().to_owned();
        let password = self.jellyfin_password.read(cx).value().to_owned();
        self.jellyfin_password
            .update(cx, |input, cx| input.clear(cx));
        self.job("Signing in to Jellyfin…", move |path, cancel, _| {
            let profile = Profile::open(path)?;
            Ok(Event::JellyfinSignedIn(
                Jellyfin::new(&profile)?.authenticate(&url, &username, &password, &cancel)?,
            ))
        });
    }
    fn save_preferences(&mut self) {
        let selected = self
            .playlists
            .iter()
            .filter(|p| self.selected.contains(&p.id))
            .map(|p| p.id.clone())
            .collect();
        let prefs = Preferences {
            provider: Some(self.provider),
            source_revision: self.source_revision.clone(),
            direct: self.direct,
            selected,
            library_folder: if self.using_default_library {
                None
            } else {
                self.destination.clone()
            },
            legacy_destination: None,
            bitrate: Some(self.bitrate),
        };
        self.has_saved_selection = true;
        let _ = self.preference_sender.send(prefs);
    }
    fn apply(&mut self, event: Event) {
        let mut rescan_watch = false;
        match event {
            Event::WatchDiagnostics(result) => {
                self.watch_diagnostics = Some(result);
                self.watch_diagnostic_running = false;
                self.watch_diagnostic_started = None;
                return;
            }
            Event::SourceAvailability(saved) => {
                self.saved_sources = saved.map(Some);
                return;
            }
            Event::Watches(result) => {
                self.scanning = false;
                match result {
                    Ok(discovery) => {
                        let watches = discovery.watches;
                        if !watches.iter().any(|w| Some(w.key()) == self.selected_watch) {
                            self.selected_watch = if watches.len() == 1 {
                                Some(watches[0].key())
                            } else {
                                None
                            };
                            self.music_items.clear();
                            if self.selected_watch.is_none() && self.page == Page::WatchMusic {
                                self.page = Page::Playlists;
                            }
                        }
                        let mut status = if watches.is_empty() && !discovery.unavailable.is_empty()
                        {
                            "No usable Garmin device found. Detection may take about 30 seconds after connecting."
                        } else if watches.is_empty() {
                            "Plug in your Garmin device and select USB / MTP mode if asked. Detection may take about 30 seconds after connecting."
                        } else {
                            "Garmin device ready for music transfer"
                        }
                        .to_owned();
                        if !discovery.unavailable.is_empty() {
                            let count = discovery.unavailable.len();
                            status.push_str(&format!(
                                " · {count} Garmin {} unavailable. Close apps using the device, then scan again.",
                                if count == 1 { "device is" } else { "devices are" }
                            ));
                        }
                        self.watch_status = status;
                        self.watches = watches;
                    }
                    Err(error) => {
                        self.watches.clear();
                        self.selected_watch = None;
                        self.music_items.clear();
                        if self.page == Page::WatchMusic {
                            self.page = Page::Playlists;
                        }
                        self.watch_status = error;
                    }
                }
                return;
            }
            Event::MusicItems(items) => {
                self.music_items = items;
                self.watch_music_pending = false;
                self.status = "Device content list refreshed.".into();
            }
            Event::MusicRemoved { count, items } => match items {
                Ok(items) => {
                    rescan_watch = true;
                    self.music_items = items;
                    self.status =
                        format!("Removed {count} items from Music. The list is up to date.");
                }
                Err(_) => {
                    rescan_watch = true;
                    self.music_items.clear();
                    self.status = format!(
                        "Removed {count} items from Music, but the list could not reload. Select Refresh device content to try again."
                    );
                }
            },
            Event::WatchProgress(p) => {
                self.status = format!(
                    "{} · {} of {} tracks",
                    p.phase, p.tracks.completed, p.tracks.expected
                );
                self.progress = Some(p.tracks.clone());
                self.watch_progress = Some(p);
                return;
            }
            Event::Transferred(result) => {
                rescan_watch = true;
                self.progress = None;
                self.watch_done = true;
                self.watch_finished_elapsed = self.export_started.map(|started| started.elapsed());
                if let Some(progress) = &mut self.watch_progress {
                    progress.phase = "Complete";
                    progress.tracks.completed = result.tracks;
                    progress.bytes = result.bytes;
                }
                self.music_items.clear();
                self.status = format!(
                    "Sent and checked {} tracks in {} playlists.{} When you finish transferring, unplug the device so Garmin can find the music.",
                    result.tracks,
                    result.playlists,
                    if result.removed == 0 {
                        String::new()
                    } else {
                        format!(" Removed {} old music items.", result.removed)
                    }
                );
            }
            Event::Progress(p) => {
                if p.completed == 0 {
                    self.export_started = Some(Instant::now());
                }
                self.status = format!("Exporting MP3 files · {} of {}", p.completed, p.expected);
                self.progress = Some(p);
                return;
            }
            Event::PreferencesFailed(message) => {
                self.status = format!("Could not save desktop settings: {message}");
                return;
            }
            Event::Loaded {
                provider,
                source_revision,
                connected,
                playlists,
                selected,
                server,
                overview,
            } => {
                if self.preference_provider.unwrap_or(Provider::Plex) != provider
                    || self.source_revision != source_revision
                {
                    self.selected.clear();
                    self.has_saved_selection = false;
                }
                self.source_revision = source_revision;
                self.provider = provider;
                self.source_loading = false;
                self.previous_provider = None;
                if !provider.bitrates().contains(&self.bitrate) {
                    self.bitrate = 256;
                }
                self.preference_provider = Some(provider);
                self.saved_sources[source_index(provider)] = Some(connected);
                self.connected = connected;
                self.playlists = playlists;
                self.server = server;
                self.overview = overview;
                if connected {
                    self.cached_sources[source_index(provider)] = Some(CachedSource {
                        playlists: self.playlists.clone(),
                        server: self.server.clone(),
                        overview: self.overview.clone(),
                    });
                }
                self.connection_status = if connected && provider == Provider::Local {
                    "Folder scanned and playlists loaded"
                } else if connected {
                    "Connected and playlists loaded"
                } else {
                    "No music source selected"
                }
                .into();
                if !self.has_saved_selection {
                    self.selected = selected.into_iter().collect();
                }
                self.status = if connected {
                    "Ready to export."
                } else {
                    "Choose a music source to get started."
                }
                .into();
            }
            Event::SetupRequired(provider) => {
                self.provider = provider;
                self.saved_sources[source_index(provider)] = Some(false);
                self.source_loading = false;
                self.previous_provider = None;
                self.connected = false;
                self.playlists.clear();
                self.server = None;
                self.overview = None;
                self.connection_status = "No music source selected".into();
                self.jellyfin_setup = provider == Provider::Jellyfin;
                self.status = "Choose a music source to get started.".into();
                self.page = Page::Playlists;
            }
            Event::JellyfinSignedIn(login) => {
                self.jellyfin_login = Some(Arc::new(login));
                self.status = "Choose your Jellyfin music library.".into();
            }
            Event::SignedIn(login) => {
                self.login = Some(Arc::new(login));
                self.choice = None;
                self.status = "Choose your Plex server.".into();
            }
            Event::Discovered(choice) => {
                self.choice = Some(Arc::new(choice));
                self.status = "Choose your music library.".into();
            }
            Event::Connected => {
                self.selected.clear();
                self.has_saved_selection = false;
                self.jellyfin_setup = false;
                self.jellyfin_login = None;
                self.login = None;
                self.choice = None;
                self.connected = true;
                self.busy = false;
                self.load();
                return;
            }
            Event::Exported(path) => {
                self.output = Some(path);
                self.progress = None;
                self.status = "Files ready. Copy the playlist folders into your device’s Music folder using Files or another MTP app.".into();
            }
            Event::Purged(result) => {
                self.output = None;
                self.status = format!(
                    "Cleared {} generated files from the music library. {} modified files were preserved; unrelated files were untouched.",
                    result.removed, result.preserved_modified
                );
            }
            Event::ConnectionUnavailable(provider, source_revision, message, server) => {
                if self.provider != provider || self.source_revision != source_revision {
                    self.selected.clear();
                    self.playlists.clear();
                }
                self.source_revision = source_revision;
                self.provider = provider;
                self.saved_sources[source_index(provider)] = Some(true);
                self.source_loading = false;
                self.previous_provider = None;
                if !provider.bitrates().contains(&self.bitrate) {
                    self.bitrate = 256;
                }
                self.connected = true;
                self.server = Some(server);
                self.overview = None;
                self.connection_status =
                    format!("Saved connection; {} is unreachable", self.provider.label());
                self.status =
                    format!("{message}. Your saved connection is intact. Use Refresh to retry.");
            }
            Event::Failed(message) => {
                if self.source_loading
                    && let Some(previous) = self.previous_provider.take()
                {
                    self.provider = previous;
                    if let Some(cached) = self.cached_sources[source_index(previous)].clone() {
                        self.connected = true;
                        self.playlists = cached.playlists;
                        self.server = cached.server;
                        self.overview = cached.overview;
                    } else {
                        self.connected = false;
                        self.playlists.clear();
                        self.server = None;
                        self.overview = None;
                    }
                }
                self.source_loading = false;
                self.progress = None;
                if let Some(progress) = &mut self.watch_progress {
                    progress.phase = "Stopped";
                    self.watch_finished_elapsed =
                        self.export_started.map(|started| started.elapsed());
                }
                if self.watch_music_may_have_changed {
                    self.music_items.clear();
                    rescan_watch = true;
                }
                self.status = message;
            }
        }
        self.busy = false;
        self.exporting = false;
        self.watch_music_may_have_changed = false;
        if rescan_watch {
            self.scan_watches();
        }
        if self.watch_music_pending && self.page == Page::WatchMusic {
            self.watch_music_pending = false;
            self.inspect_watch_music();
        }
    }
    fn sign_in(&mut self) {
        self.job("Finish signing in in your browser…", |path, cancel, _| {
            let profile = Profile::open(path)?;
            let plex = Plex::new(&profile)?;
            Ok(Event::SignedIn(plex.login(
                &profile,
                &cancel,
                plex::open_browser,
            )?))
        });
    }
    fn choose_folder(&mut self, cx: &mut Context<Self>) {
        if self.busy || self.modal.is_some() {
            return;
        }
        let prompt = cx.prompt_for_paths(PathPromptOptions {
            files: false,
            directories: true,
            multiple: false,
            prompt: Some("Choose your SyncAndRun library folder".into()),
        });
        cx.spawn(async move |view, cx| {
            let result = prompt.await;
            let _ = view.update(cx, |view, cx| {
                match result {
                    Ok(Ok(Some(paths))) if !paths.is_empty() => {
                        let path = paths[0].clone();
                        view.destination = Some(path);
                        view.using_default_library = false;
                        view.save_preferences();
                    }
                    Ok(Ok(_)) => {}
                    _ => view.status = "Could not open the folder picker.".into(),
                }
                cx.notify();
            });
        })
        .detach();
    }
    fn choose_local_source(&mut self, cx: &mut Context<Self>) {
        if self.busy || self.modal.is_some() {
            return;
        }
        let prompt = cx.prompt_for_paths(PathPromptOptions {
            files: false,
            directories: true,
            multiple: false,
            prompt: Some("Choose a folder of MP3 or FLAC files".into()),
        });
        cx.spawn(async move |view, cx| {
            let result = prompt.await;
            let _ = view.update(cx, |view, cx| {
                match result {
                    Ok(Ok(Some(paths))) if !paths.is_empty() => {
                        let folder = paths[0].clone();
                        view.job("Opening local music…", move |path, _, _| {
                            let mut profile = Profile::open(path)?;
                            profile.set_local_folder(&folder)?;
                            Ok(Event::Connected)
                        });
                    }
                    Ok(Ok(_)) => {}
                    _ => view.status = "Could not open the folder picker.".into(),
                }
                cx.notify();
            });
        })
        .detach();
    }
    fn create_files(&mut self, _: &mut Window, cx: &mut Context<Self>) {
        if self.busy || self.modal.is_some() {
            return;
        }
        if self.direct {
            self.transfer_to_watch();
            return;
        }
        if self.using_default_library && self.destination.as_ref().is_some_and(|p| !p.exists()) {
            let path = self.destination.as_ref().expect("default path").clone();
            self.modal = Some(Modal::CreateDefault(path));
            cx.notify();
            return;
        }
        self.start_export(false);
    }
    fn start_export(&mut self, create_default: bool) {
        let Some(destination) = self.destination.clone() else {
            return;
        };
        let ids: Vec<String> = self
            .playlists
            .iter()
            .filter(|p| self.selected.contains(&p.id))
            .map(|p| p.id.clone())
            .collect();
        if ids.is_empty() {
            return;
        }
        let bitrate = self.bitrate;
        self.output = None;
        self.progress = None;
        self.export_started = Some(Instant::now());
        let expected_provider = self.provider;
        let expected_revision = self.source_revision.clone();
        self.job(
            "Refreshing the selected playlists…",
            move |path, cancel, sender| {
                let mut profile = Profile::open(path)?;
                ensure!(
                    profile.active_provider()? == expected_provider
                        && profile.source_revision()? == expected_revision,
                    "The music connection changed. Refresh playlists before exporting."
                );
                let source = MusicSource::new(&profile)?;
                let plan = source.refresh(&mut profile, &ids, &cancel)?;
                if create_default && !destination.exists() {
                    fs::create_dir_all(&destination)
                        .context("Could not create the default music library folder")?;
                }
                let path = export::export_sync(
                    &plan,
                    bitrate,
                    &destination,
                    &cancel,
                    |t, b| source.audio(&profile, t, b),
                    |p| {
                        let _ = sender.send(Event::Progress(p));
                    },
                )?;
                Ok(Event::Exported(path))
            },
        );
        self.exporting = true;
    }
    fn confirm_purge(&mut self, _: &mut Window, cx: &mut Context<Self>) {
        if self.busy || self.modal.is_some() {
            return;
        }
        let Some(library) = self.destination.clone() else {
            return;
        };
        self.modal = Some(Modal::ClearLibrary(library));
        cx.notify();
    }
    fn confirm_modal(&mut self) {
        match self.modal.take() {
            Some(Modal::ReplaceMusic(watch))
                if !self.busy && Some(watch.key()) == self.selected_watch =>
            {
                let ids: Vec<_> = self
                    .playlists
                    .iter()
                    .filter(|p| self.selected.contains(&p.id))
                    .map(|p| p.id.clone())
                    .collect();
                self.start_watch_transfer(watch, ids, self.bitrate, true);
            }
            Some(Modal::RemoveMusic(watch, id, name))
                if !self.busy && Some(watch.key()) == self.selected_watch =>
            {
                self.watch_music_may_have_changed = true;
                self.job("Removing device music…", move |_, cancel, _| {
                    let count = device::remove_music_item(&watch, id, &name, &cancel)?;
                    let items = device::music_items(&watch).map_err(|error| error.to_string());
                    Ok(Event::MusicRemoved { count, items })
                });
            }
            Some(Modal::CreateDefault(path))
                if !self.busy && self.destination.as_ref() == Some(&path) =>
            {
                self.start_export(true);
            }
            Some(Modal::ClearLibrary(library))
                if !self.busy && self.destination.as_ref() == Some(&library) =>
            {
                self.job("Clearing generated music…", move |profile, _, _| {
                    let _profile_lock = Profile::open(profile)?;
                    Ok(Event::Purged(export::purge_library(&library)?))
                });
            }
            _ => {}
        }
    }
}
struct DisabledHint(&'static str);
impl Render for DisabledHint {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        div()
            .max_w(px(300.))
            .p_2()
            .rounded_sm()
            .border_1()
            .border_color(rgb(0x705b3b))
            .bg(rgb(0x302c24))
            .text_sm()
            .text_color(rgb(0xf1ede4))
            .child(self.0)
    }
}
fn button_with_reason(
    id: impl Into<ElementId>,
    label: impl Into<SharedString>,
    enabled: bool,
    disabled_reason: &'static str,
) -> Stateful<Div> {
    div()
        .id(id)
        .px_4()
        .py_2()
        .rounded_md()
        .border_1()
        .border_color(rgb(0x48453d))
        .bg(rgb(if enabled { 0x34312a } else { 0x302e28 }))
        .text_color(rgb(if enabled { 0xf1ede4 } else { 0x918e85 }))
        .when(enabled, |d| {
            d.cursor_pointer().hover(|s| s.bg(rgb(0x484138)))
        })
        .when(!enabled, |d| {
            d.tooltip(move |_, cx| cx.new(|_| DisabledHint(disabled_reason)).into())
        })
        .child(label.into())
}
fn button(
    id: impl Into<ElementId>,
    label: impl Into<SharedString>,
    enabled: bool,
) -> Stateful<Div> {
    button_with_reason(
        id,
        label,
        enabled,
        "Finish the current operation or close the dialog first.",
    )
}
fn panel() -> Div {
    div()
        .p_5()
        .rounded_sm()
        .border_1()
        .border_color(rgb(0x3b3932))
        .bg(rgb(0x25241f))
}
fn export_status_glow(elapsed: Duration) -> impl IntoElement {
    // The status box can change width and height as the window or text changes.
    // Travel in measured pixels so every side moves at the same speed.
    canvas(
        |_, _, _| {},
        move |bounds, _, window, _| {
            let width: f32 = bounds.size.width.into();
            let height: f32 = bounds.size.height.into();
            let horizontal = (width - 4.0).max(0.0);
            let vertical = (height - 4.0).max(0.0);
            if horizontal <= 0.0 || vertical <= 0.0 {
                return;
            }
            let perimeter = 2.0 * (horizontal + vertical);
            let head = (elapsed.as_secs_f64() * 180.0).rem_euclid(perimeter as f64) as f32;
            let origin_x: f32 = bounds.origin.x.into();
            let origin_y: f32 = bounds.origin.y.into();
            let left = origin_x + 2.0;
            let top = origin_y + 2.0;
            let right = left + horizontal;
            let bottom = top + vertical;
            let sides = [horizontal, vertical, horizontal, vertical];
            let mut side_start = 0.0;
            for (side, length) in sides.into_iter().enumerate() {
                for wrap in [0.0, perimeter] {
                    let from = (head - 36.0 + wrap).max(side_start);
                    let to = (head + wrap).min(side_start + length);
                    if to <= from {
                        continue;
                    }
                    let start = from - side_start;
                    let end = to - side_start;
                    let (x, y, w, h) = match side {
                        0 => (left + start, top - 1.5, end - start, 3.0),
                        1 => (right - 1.5, top + start, 3.0, end - start),
                        2 => (right - end, bottom - 1.5, end - start, 3.0),
                        _ => (left - 1.5, bottom - end, 3.0, end - start),
                    };
                    window.paint_quad(quad(
                        Bounds::new(
                            point(px(x - 2.0), px(y - 2.0)),
                            size(px(w + 4.0), px(h + 4.0)),
                        ),
                        px(3.0),
                        rgba(0xd7a05a55),
                        px(0.0),
                        transparent_black(),
                        Default::default(),
                    ));
                    window.paint_quad(quad(
                        Bounds::new(point(px(x), px(y)), size(px(w), px(h))),
                        px(1.5),
                        rgb(0xf3bd70),
                        px(0.0),
                        transparent_black(),
                        Default::default(),
                    ));
                }
                side_start += length;
            }
        },
    )
    .absolute()
    .inset_0()
}
fn data_size(bytes: u64) -> String {
    if bytes >= 1_000_000 {
        format!("{:.1} MB", bytes as f64 / 1_000_000.)
    } else {
        format!("{:.1} KB", bytes as f64 / 1_000.)
    }
}
fn clock_time(duration: Duration) -> String {
    format!(
        "{}m {:02}s",
        duration.as_secs() / 60,
        duration.as_secs() % 60
    )
}
impl Render for Desktop {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        window.set_rem_size(px(16.));
        let active = !self.busy && self.modal.is_none();
        let width: f32 = window.bounds().size.width.into();
        let compact = width < 1020.;
        let mut watch_card = panel()
            .py_3()
            .flex()
            .flex_col()
            .gap_2()
            .child(
                div()
                    .flex()
                    .items_center()
                    .justify_between()
                    .child(div().text_lg().child("Garmin device"))
                    .child(
                        div()
                            .flex()
                            .gap_2()
                            .child(
                                button(
                                    "watch-help",
                                    "Troubleshooting",
                                    self.modal.is_none() && !self.exporting,
                                )
                                .text_sm()
                                .on_click(cx.listener(
                                    |v, _, _, cx| {
                                        if v.modal.is_none() && !v.exporting {
                                            v.modal = Some(Modal::WatchTroubleshooting);
                                            v.run_watch_diagnostics();
                                            cx.notify();
                                        }
                                    },
                                )),
                            )
                            .child(
                                button("scan-watch", "Scan for device", active)
                                    .text_sm()
                                    .on_click(cx.listener(|v, _, _, cx| {
                                        if !v.busy && !v.scanning {
                                            v.scan_watches();
                                            cx.notify();
                                        }
                                    })),
                            ),
                    ),
            )
            .child(
                div()
                    .text_sm()
                    .text_color(rgb(0xc6c0b3))
                    .child(self.watch_status.clone()),
            )
            .when(self.watches.is_empty(), |card| {
                let phase = (self.monitor_started.elapsed().as_secs_f32() / 2.4) % 2.0;
                let sweep = if phase <= 1.0 { phase } else { 2.0 - phase };
                card.child(
                    div()
                        .flex()
                        .flex_col()
                        .gap_1()
                        .child(div().text_xs().text_color(rgb(0xd7a05a)).child(
                            "Scanning for Garmin devices · detection may take about 30 seconds",
                        ))
                        .child(
                            div()
                                .relative()
                                .h(px(6.))
                                .w_full()
                                .rounded_md()
                                .overflow_hidden()
                                .bg(rgb(0x3b3932))
                                .child(
                                    div()
                                        .absolute()
                                        .left(relative(sweep - 0.14))
                                        .h_full()
                                        .w(relative(0.28))
                                        .rounded_md()
                                        .overflow_hidden()
                                        .flex()
                                        .child(div().h_full().w(relative(0.5)).bg(linear_gradient(
                                            90.0,
                                            linear_color_stop(Hsla::from(rgba(0xd7a05a00)), 0.0),
                                            linear_color_stop(Hsla::from(rgba(0xd7a05ad9)), 1.0),
                                        )))
                                        .child(div().h_full().w(relative(0.5)).bg(
                                            linear_gradient(
                                                90.0,
                                                linear_color_stop(
                                                    Hsla::from(rgba(0xd7a05ad9)),
                                                    0.0,
                                                ),
                                                linear_color_stop(
                                                    Hsla::from(rgba(0xd7a05a00)),
                                                    1.0,
                                                ),
                                            ),
                                        )),
                                ),
                        ),
                )
            })
            .when(self.selected_watch.is_none(), |card| {
                card.child(
                    div()
                        .text_sm()
                        .text_color(rgb(0xb8b3a8))
                        .child("Connect and select a Garmin device to manage its content."),
                )
            });
        for (i, watch) in self.watches.iter().enumerate() {
            let key = watch.key();
            let chosen = Some(key.clone()) == self.selected_watch;
            let label = format!(
                "{} · {:.2} GB free / {:.2} GB · firmware {}",
                watch.model,
                watch.free_bytes as f64 / 1e9,
                watch.total_bytes as f64 / 1e9,
                watch.firmware
            );
            watch_card = watch_card.child(
                button(("watch", i), label, active)
                    .bg(rgb(if chosen { 0x594529 } else { 0x34312a }))
                    .border_color(rgb(if chosen { 0xd7a05a } else { 0x48453d }))
                    .text_sm()
                    .on_click(cx.listener(move |v, _, _, cx| {
                        if !v.busy {
                            v.selected_watch = Some(key.clone());
                            v.music_items.clear();
                            if v.page == Page::WatchMusic {
                                v.inspect_watch_music();
                            }
                            cx.notify();
                        }
                    })),
            );
        }
        let mut content = div().flex().flex_col().gap_3();

        if self.page == Page::WatchMusic {
            content = content.child(div().text_2xl().child("Manage device content"))
                .child(div().text_sm().child("See files and folders directly inside the device’s Music folder. Folder sizes include their contents. To add or replace music, open Playlists. Activities and Garmin files outside Music stay on the device."))
                .child(button("refresh-watch-music", "Refresh device content", active).on_click(cx.listener(|v, _, _, cx| { v.inspect_watch_music(); cx.notify(); })));
            for (i, item) in self.music_items.iter().enumerate() {
                let name = item.name.clone();
                let id = item.id;
                let size = data_size(item.bytes);
                let label = format!(
                    "{} {} · {}",
                    if item.folder { "Folder:" } else { "File:" },
                    name,
                    size
                );
                content = content.child(
                    panel()
                        .flex()
                        .items_center()
                        .justify_between()
                        .child(div().text_sm().child(label))
                        .child(
                            button(("remove-watch-item", i), "Remove…", active)
                                .text_sm()
                                .on_click(cx.listener(move |v, _, _, cx| {
                                    if let Some(watch) = v
                                        .watches
                                        .iter()
                                        .find(|w| Some(w.key()) == v.selected_watch)
                                        .cloned()
                                    {
                                        v.modal = Some(Modal::RemoveMusic(watch, id, name.clone()));
                                        cx.notify();
                                    }
                                })),
                        ),
                );
            }
        } else if let Some(login) = self.jellyfin_login.clone() {
            content = content.child(
                div()
                    .text_xl()
                    .child(format!("Choose a music library on {}", login.server_name)),
            );
            if login.libraries.is_empty() {
                content = content.child("No music libraries are available to this Jellyfin account. Check library access on your server.");
            }
            for (i, library) in login.libraries.iter().enumerate() {
                let id = library.id.clone();
                let login = login.clone();
                content = content.child(
                    button(("jellyfin-library", i), library.title.clone(), active).on_click(
                        cx.listener(move |view, _, _, cx| {
                            let login = login.clone();
                            let id = id.clone();
                            view.job("Saving Jellyfin connection…", move |path, _, _| {
                                let mut profile = Profile::open(path)?;
                                Jellyfin::new(&profile)?.connect(&mut profile, &login, &id)?;
                                Ok(Event::Connected)
                            });
                            cx.notify();
                        }),
                    ),
                );
            }
            content = content.child(button("jellyfin-back", "Back to sign in", active).on_click(
                cx.listener(|view, _, _, cx| {
                    if !view.busy {
                        view.jellyfin_login = None;
                        view.jellyfin_setup = true;
                        cx.notify();
                    }
                }),
            ));
        } else if !self.connected && self.provider == Provider::Local {
            content = content.child(panel().max_w(px(620.)).flex().flex_col().gap_3()
                .child(div().text_xl().child("Local music folder"))
                .child("Choose a folder containing MP3 or FLAC files. Each folder with tracks becomes a playlist.")
                .child(button("choose-local-source", "Choose music folder…", active).on_click(cx.listener(|view, _, _, cx| { view.choose_local_source(cx); cx.notify(); }))));
        } else if self.jellyfin_setup || (!self.connected && self.provider == Provider::Jellyfin) {
            let inputs = [
                self.jellyfin_url.clone(),
                self.jellyfin_user.clone(),
                self.jellyfin_password.clone(),
            ];
            let focus: Vec<_> = inputs.iter().map(|input| input.focus_handle(cx)).collect();
            let mut form = panel().flex().flex_col().gap_3().max_w(px(620.))
                .child(div().text_xl().child("Connect Jellyfin"))
                .child(div().text_sm().child("Enter your Jellyfin server address and account. Use the full address, including a base path if your server has one."))
                .child(div().text_sm().child("Server address (for example, http://192.168.1.20:8096)"));
            if active {
                form = form
                    .child(self.jellyfin_url.clone())
                    .child("Username")
                    .child(self.jellyfin_user.clone())
                    .child("Password")
                    .child(self.jellyfin_password.clone());
            } else {
                form = form.child("Signing in…");
            }
            form = form.child(div().text_sm().text_color(rgb(0xb8b3a8)).child("The saved access token is encrypted in your local profile. Your password is not saved."))
                .child(button("jellyfin-login", "Sign in to Jellyfin", active).on_click(cx.listener(|view, _, _, cx| { view.jellyfin_sign_in(cx); cx.notify(); })))
                .on_key_down(cx.listener(move |view, event: &KeyDownEvent, window, cx| {
                    if view.busy { return; }
                    if event.keystroke.key == "tab" {
                        let current = focus.iter().position(|f| f.is_focused(window)).unwrap_or(0);
                        let next = if event.keystroke.modifiers.shift { (current + focus.len() - 1) % focus.len() } else { (current + 1) % focus.len() };
                        window.focus(&focus[next]);
                        cx.stop_propagation();
                    } else if event.keystroke.key == "enter" {
                        view.jellyfin_sign_in(cx);
                        cx.stop_propagation();
                        cx.notify();
                    }
                }));
            content = content.child(form);
        } else if let Some(choice) = self.choice.clone() {
            content = content.child(div().text_xl().child("Choose a music library"));
            if choice.libraries.is_empty() {
                content =
                    content.child("This server has no music libraries. Choose another server.");
            }
            for (i, library) in choice.libraries.iter().enumerate() {
                let library = library.key.clone();
                let choice = choice.clone();
                let login = self.login.clone();
                content = content.child(
                    button(("library", i), choice.libraries[i].title.clone(), active).on_click(
                        cx.listener(move |view, _, _, cx| {
                            if let Some(login) = login.clone() {
                                let choice = choice.clone();
                                let library = library.clone();
                                view.job("Saving Plex connection…", move |path, _, _| {
                                    let mut profile = Profile::open(path)?;
                                    Plex::new(&profile)?.connect(
                                        &mut profile,
                                        &login,
                                        &choice,
                                        &library,
                                    )?;
                                    Ok(Event::Connected)
                                });
                                cx.notify();
                            }
                        }),
                    ),
                );
            }
            content = content.child(button("back", "Back to servers", active).on_click(
                cx.listener(|v, _, _, cx| {
                    if !v.busy {
                        v.choice = None;
                        cx.notify();
                    }
                }),
            ));
        } else if let Some(login) = self.login.clone() {
            content = content.child(div().text_xl().child("Choose a Plex server"));
            for (i, server) in login.servers.iter().enumerate() {
                let server = server.clone();
                content =
                    content.child(button(("server", i), server.name.clone(), active).on_click(
                        cx.listener(move |view, _, _, cx| {
                            let server = server.clone();
                            view.job("Finding music libraries…", move |path, cancel, _| {
                                let profile = Profile::open(path)?;
                                Ok(Event::Discovered(
                                    Plex::new(&profile)?.discover(&server, &cancel)?,
                                ))
                            });
                            cx.notify();
                        }),
                    ));
            }
        } else if self.page == Page::Settings {
            let server_name = self
                .overview
                .as_ref()
                .and_then(|o| o.server_name.as_deref())
                .unwrap_or("Saved music server");
            let server_version = self
                .overview
                .as_ref()
                .and_then(|o| o.server_version.as_deref())
                .unwrap_or("Unavailable");
            let library_name = self
                .overview
                .as_ref()
                .and_then(|o| o.library_name.as_deref())
                .unwrap_or("Saved music library");
            let server_address = self
                .server
                .as_ref()
                .map(|s| s.0.as_str())
                .unwrap_or("No server saved");
            let server_id = self.server.as_ref().map(|s| s.1.as_str()).unwrap_or("—");
            let library_id = self.server.as_ref().map(|s| s.2.as_str()).unwrap_or("—");
            let library_tracks = (if self.provider == Provider::Local {
                Some(self.playlists.iter().map(|p| p.track_count).sum())
            } else {
                self.overview.as_ref().and_then(|o| o.library_tracks)
            })
            .map(|count| count.to_string())
            .unwrap_or_else(|| "—".into());
            let selected: Vec<_> = self
                .playlists
                .iter()
                .filter(|p| self.selected.contains(&p.id))
                .collect();
            let selected_tracks: u64 = selected.iter().map(|p| p.track_count).sum();
            let server_card = if self.provider == Provider::Local {
                panel()
                    .flex()
                    .flex_col()
                    .gap_3()
                    .flex_1()
                    .min_w(px(0.))
                    .when(!compact, |card| card.h(px(410.)))
                    .child(div().text_xl().child("Local music folder"))
                    .child(div().text_lg().child(library_name.to_owned()))
                    .child(div().text_sm().child(self.connection_status.clone()))
                    .child(div().text_sm().child(format!(
                        "{} playlist groups · {} tracks",
                        self.playlists.len(),
                        self.playlists.iter().map(|p| p.track_count).sum::<u64>()
                    )))
                    .child(
                        button("change-local-folder", "Change folder…", active).on_click(
                            cx.listener(|view, _, _, cx| {
                                view.choose_local_source(cx);
                                cx.notify();
                            }),
                        ),
                    )
            } else {
                panel()
                    .flex()
                    .flex_col()
                    .gap_3()
                    .flex_1()
                    .min_w(px(0.))
                    .when(!compact, |card| card.h(px(410.)))
                    .child(
                        div()
                            .text_xl()
                            .child(format!("{} server", self.provider.label())),
                    )
                    .child(div().text_lg().child(server_name.to_owned()))
                    .child(
                        div()
                            .text_sm()
                            .text_color(rgb(if self.connected { 0xa8d6b5 } else { 0xd8b980 }))
                            .child(self.connection_status.clone()),
                    )
                    .child(div().text_sm().text_color(rgb(0xaaa79d)).child("Address"))
                    .child(div().text_sm().truncate().child(server_address.to_owned()))
                    .child(div().text_sm().text_color(rgb(0xaaa79d)).child("Server ID"))
                    .child(div().text_sm().truncate().child(server_id.to_owned()))
                    .child(div().text_sm().text_color(rgb(0xaaa79d)).child(format!(
                        "{} version · {server_version}",
                        self.provider.label()
                    )))
                    .child(
                        button("account", "Connect or change account", active).on_click(
                            cx.listener(|view, _, _, cx| {
                                if view.modal.is_none() {
                                    if view.provider == Provider::Local {
                                        view.choose_local_source(cx);
                                    } else if view.provider == Provider::Jellyfin {
                                        view.jellyfin_setup = true;
                                    } else {
                                        view.sign_in();
                                    }
                                    cx.notify();
                                }
                            }),
                        ),
                    )
            };
            let stat = |label: &'static str, value: String| {
                div()
                    .w(px(170.))
                    .p_3()
                    .rounded_md()
                    .bg(rgb(0x302c24))
                    .child(div().text_2xl().child(value))
                    .child(div().text_sm().text_color(rgb(0xc6c0b3)).child(label))
            };
            let statistics = if compact {
                div()
                    .flex()
                    .flex_wrap()
                    .gap_2()
                    .child(stat("Library tracks", library_tracks))
                    .child(stat("Audio playlists", self.playlists.len().to_string()))
                    .child(stat("Selected playlists", selected.len().to_string()))
                    .child(stat("Selected tracks", selected_tracks.to_string()))
            } else {
                div()
                    .flex()
                    .flex_col()
                    .gap_2()
                    .child(
                        div()
                            .flex()
                            .gap_2()
                            .child(stat("Library tracks", library_tracks))
                            .child(stat("Audio playlists", self.playlists.len().to_string())),
                    )
                    .child(
                        div()
                            .flex()
                            .gap_2()
                            .child(stat("Selected playlists", selected.len().to_string()))
                            .child(stat("Selected tracks", selected_tracks.to_string())),
                    )
            };
            let library_card = panel().flex().flex_col().gap_3().flex_1().min_w(px(0.))
                .when(!compact, |card| card.h(px(410.)))
                .child(div().text_xl().child(format!("{} music library", self.provider.label())))
                .child(div().text_lg().child(library_name.to_owned()))
                .child(div().text_sm().text_color(rgb(0xaaa79d)).child(format!("Library ID · {library_id}")))
                .child(div().text_sm().text_color(rgb(0xb8b3a8)).child(
                    format!("SyncAndRun reads playlists and tracks from {}. It does not change your music library.", self.provider.label())
                ))
                .child(statistics);
            let layout = if compact {
                div().flex().flex_col()
            } else {
                div().flex().flex_row()
            };
            let folder = self
                .destination
                .as_ref()
                .map(|path| {
                    format!(
                        "{}{}",
                        path.display(),
                        if self.using_default_library {
                            " (default)"
                        } else {
                            ""
                        }
                    )
                })
                .unwrap_or_else(|| "No library folder selected".into());
            let mut management = panel().flex().flex_col().gap_3()
                .child(div().text_xl().child("Export folder on this computer"))
                .child(div().text_color(rgb(0xc6c0b3)).child(folder))
                .child(button("folder", "Change export folder", active).on_click(
                    cx.listener(|view, _, _, cx| view.choose_folder(cx))
                ))
                .child(div().text_sm().text_color(rgb(0xb8b3a8)).child(
                    "Each export creates a folder and playlist file for every selected playlist. Later exports update files made by SyncAndRun. They remove old files only if you did not change them. Your other files stay."
                ))
                .child(div().text_sm().text_color(rgb(0xb8b3a8)).child(
                    "After copying music to your device, you can clear unchanged files made by SyncAndRun. Changed and unrelated files stay."
                ));
            if self
                .destination
                .as_ref()
                .is_some_and(|path| path.join(".syncandrun-files.json").exists())
            {
                management =
                    management.child(button("purge", "Clear exported music…", active).on_click(
                        cx.listener(|view, _, window, cx| view.confirm_purge(window, cx)),
                    ));
            }
            content = content
                .child(
                    div()
                        .flex()
                        .flex_col()
                        .gap_1()
                        .child(div().text_2xl().child("Settings"))
                        .child(
                            div()
                                .text_color(rgb(0xb8b3a8))
                                .child("Connection and library details."),
                        ),
                )
                .child(layout.gap_4().child(server_card).child(library_card))
                .child(management);
        } else if !self.connected {
            content = content.child(
                panel()
                    .flex()
                    .flex_col()
                    .gap_3()
                    .max_w(px(620.))
                    .child(div().text_xl().child("Connect Plex"))
                    .child(
                        button("login", "Sign in with Plex →", active)
                            .bg(rgb(0xbd8338))
                            .border_color(rgb(0xe0a454))
                            .text_color(rgb(0x171510))
                            .on_click(cx.listener(|view, _, _, cx| {
                                view.sign_in();
                                cx.notify();
                            })),
                    ),
            );
        } else {
            let selected: Vec<_> = self
                .playlists
                .iter()
                .filter(|p| self.selected.contains(&p.id))
                .collect();
            let tracks: u64 = selected.iter().map(|p| p.track_count).sum();
            let seconds: u64 = selected.iter().map(|p| p.duration_seconds).sum();
            let estimate = seconds as f64 * self.bitrate as f64 * 1000.0 / 8.0 * 1.03 / 1_000_000.0;
            let available_count = self.playlists.len() - selected.len();
            let mut available = div().id("available-playlists").flex().flex_col().gap_2();
            let mut syncing = div().id("syncing-playlists").flex().flex_col().gap_2();
            if self.playlists.is_empty() && !self.source_loading {
                available = available.child(format!(
                    "No audio playlists found. Create one in {}, then refresh.",
                    self.provider.label()
                ));
            }
            for (i, playlist) in self.playlists.iter().enumerate() {
                let id = playlist.id.clone();
                let checked = self.selected.contains(&id);
                let selectable = playlist.track_count <= 10000;
                let label = format!(
                    "{} · {} tracks{}",
                    playlist.title,
                    playlist.track_count,
                    if selectable { "" } else { " · too large" }
                );
                let item = button_with_reason(
                    ("playlist", i), label, active && selectable,
                    if !selectable { "This playlist exceeds the 10,000-track limit." }
                    else { "Finish the current operation or close the dialog before changing playlists." },
                )
                    .w_full()
                    .bg(rgb(if checked { 0x594529 } else { 0x34312a }))
                    .border_color(rgb(if checked { 0xd7a05a } else { 0x3b3932 }))
                    .on_click(cx.listener(move |view, _, _, cx| {
                        if !view.busy && selectable {
                            if !view.selected.remove(&id) {
                                view.selected.insert(id.clone());
                            }
                            view.save_preferences();
                            cx.notify();
                        }
                    }));
                if checked {
                    syncing = syncing.child(item);
                } else {
                    available = available.child(item);
                }
            }
            if selected.is_empty() {
                syncing = syncing.child("Choose a playlist below to add it here.");
            }
            if available_count == 0 && !self.playlists.is_empty() {
                available = available.child("All playlists are selected.");
            }
            let playlist_panel = panel()
                .flex()
                .flex_col()
                .gap_3()
                .flex_1()
                .min_w(px(0.))
                .child(
                    div()
                        .flex()
                        .justify_between()
                        .items_center()
                        .child(div().text_xl().child("Playlists"))
                        .child(
                            button(
                                "refresh",
                                format!("Refresh from {}", self.provider.label()),
                                active,
                            )
                            .text_sm()
                            .on_click(cx.listener(|view, _, _, cx| {
                                view.load();
                                cx.notify();
                            })),
                        ),
                )
                .child(
                    div()
                        .text_sm()
                        .text_color(rgb(0xc6c0b3))
                        .child(format!("Selected · {}", selected.len())),
                )
                .child(syncing)
                .child(
                    div()
                        .text_sm()
                        .text_color(rgb(0xc6c0b3))
                        .child(format!("Available · {}", available_count)),
                )
                .child(available);
            let qualities = div().flex().flex_wrap().gap_2().children(
                self.provider.bitrates().iter().copied().map(|bitrate| {
                    let selected = self.bitrate == bitrate;
                    button(("quality", bitrate as usize), bitrate.to_string(), active)
                        .bg(rgb(if selected { 0x594529 } else { 0x34312a }))
                        .border_color(rgb(if selected { 0xd7a05a } else { 0x3b3932 }))
                        .on_click(cx.listener(move |view, _, _, cx| {
                            if !view.busy {
                                view.bitrate = bitrate;
                                view.save_preferences();
                                cx.notify();
                            }
                        }))
                }),
            );
            let folder = self
                .destination
                .as_ref()
                .map(|path| {
                    format!(
                        "{}{}",
                        path.display(),
                        if self.using_default_library {
                            " (default)"
                        } else {
                            ""
                        }
                    )
                })
                .unwrap_or_else(|| "Choose a library folder".into());
            let can_export = active
                && !self.selected.is_empty()
                && if self.direct {
                    self.selected_watch.is_some() && !self.scanning
                } else {
                    self.destination.is_some()
                };
            let export_panel = panel().flex().flex_col().gap_4()
                .child(div().text_xl().child("Transfer settings"))
                .child(div().p_3().rounded_md().border_1().border_color(rgb(0x4f4a3f)).flex().flex_col().gap_2()
                    .child(div().text_sm().text_color(rgb(0xc6c0b3)).child("1. Choose where to send music"))
                    .children([(true, "Direct to device"), (false, "Export to folder")].into_iter().map(|(direct, label)| {
                        button(if direct { "direct-mode" } else { "folder-mode" }, label, active)
                            .bg(rgb(if self.direct == direct { 0x594529 } else { 0x302e28 }))
                            .border_color(rgb(if self.direct == direct { 0xd7a05a } else { 0x48453d }))
                            .on_click(cx.listener(move |v, _, _, cx| { if !v.busy { v.direct = direct; v.output = None; v.save_preferences(); cx.notify(); } }))
                    })))
                .when(self.direct, |panel| panel.child(div().p_3().rounded_md().border_1().border_color(rgb(0x4f4a3f)).flex().flex_col().gap_2()
                    .child(div().text_sm().text_color(rgb(0xc6c0b3)).child("2. Choose what happens to music on the device"))
                    .child(button("add-watch-music", "Add playlists. Keep old music.", active).bg(rgb(if self.replace_watch_music { 0x302e28 } else { 0x594529 })).border_color(rgb(if self.replace_watch_music { 0x48453d } else { 0xd7a05a })).on_click(cx.listener(|v, _, _, cx| { v.replace_watch_music = false; cx.notify(); })))
                    .child(button("replace-watch-music", "Replace old music with these playlists.", active).bg(rgb(if self.replace_watch_music { 0x594529 } else { 0x302e28 })).border_color(rgb(if self.replace_watch_music { 0xd7a05a } else { 0x48453d })).on_click(cx.listener(|v, _, _, cx| { v.replace_watch_music = true; cx.notify(); })))
                    .child(div().text_sm().text_color(rgb(0xc6c0b3)).child("Replace sends and checks new music first. Then it deletes old music from the device’s Music folder. The device needs space for both copies until deletion ends."))))
                .child(div().flex().flex_col().gap_2()
                    .child(div().text_sm().text_color(rgb(0xc6c0b3)).child("MP3 quality"))
                    .child(qualities)
                    .child(div().text_sm().text_color(rgb(0xaaa79d)).child("192 kbps is a good balance of sound and size.")))
                .child(div().p_4().rounded_md().bg(rgb(0x302c24))
                    .child(div().text_lg().child(format!("{} playlists  ·  {} tracks", selected.len(), tracks)))
                    .child(div().text_sm().text_color(rgb(0xc6c0b3)).child(format!("About {:.0} MB at {} kbps", estimate, self.bitrate))))
                .when(!self.direct, |panel| panel.child(div().flex().flex_col().gap_2()
                    .child(div().text_sm().text_color(rgb(0xc6c0b3)).child("Music library folder"))
                    .child(div().text_sm().child(folder))
                    .child(button("main-folder", "Change folder", active).on_click(
                        cx.listener(|view, _, _, cx| view.choose_folder(cx))
                    ))))
                .child(div().text_sm().text_color(rgb(0xaaa79d))
                    .child(if self.direct { "Keep the device connected until the transfer finishes." } else { "Copy the exported playlist folders into your device’s Music folder with an MTP app." }))
                .child(button_with_reason("export", if self.direct { "Transfer to device →" } else { "Export music →" }, can_export,
                    if !active { "Finish the current operation or close the dialog first." }
                    else if self.selected.is_empty() { "Choose at least one playlist first." }
                    else if self.direct { "Connect and select a Garmin device first." }
                    else { "Choose an export folder first." })
                    .w_full()
                    .bg(rgb(if can_export { 0xbd8338 } else { 0x302e28 }))
                    .text_color(rgb(if can_export { 0x171510 } else { 0x918e85 }))
                    .border_color(rgb(if can_export { 0xe0a454 } else { 0x48453d }))
                    .on_click(cx.listener(|v, _, window, cx| {
                        v.create_files(window, cx);
                        cx.notify();
                    })));
            let export_panel = if compact {
                export_panel.w_full()
            } else {
                export_panel.w(px(350.)).flex_none()
            };
            let layout = if compact {
                div().flex().flex_col()
            } else {
                div().flex().flex_row().items_start()
            };
            content = content
                .child(
                    div()
                        .flex()
                        .flex_col()
                        .gap_1()
                        .child(div().text_2xl().child("Your music"))
                        .child(div().text_color(rgb(0xb8b3a8)).child(if compact {
                            "Choose playlists, then scroll down for transfer settings."
                        } else {
                            "Choose playlists and MP3 quality, then send them to your device."
                        })),
                )
                .child(layout.gap_4().child(playlist_panel).child(export_panel));
            if let Some(progress) = &self.progress
                && !self.direct
            {
                let fraction = if progress.expected == 0 {
                    1.
                } else {
                    progress.completed as f32 / progress.expected as f32
                };
                let eta = self
                    .export_started
                    .and_then(|start| {
                        (progress.completed > 0 && progress.completed < progress.expected).then(
                            || {
                                let remaining = start.elapsed().as_secs_f64()
                                    * (progress.expected - progress.completed) as f64
                                    / progress.completed as f64;
                                format!(
                                    " · about {} min {} sec remaining",
                                    (remaining / 60.) as u64,
                                    (remaining as u64) % 60
                                )
                            },
                        )
                    })
                    .unwrap_or_default();
                content = content
                    .child(div().child(format!(
                        "{} of {} tracks ({:.0}%){}",
                        progress.completed,
                        progress.expected,
                        fraction * 100.,
                        eta
                    )))
                    .child(
                        div()
                            .h(px(10.))
                            .w_full()
                            .rounded_md()
                            .bg(rgb(0x3b3932))
                            .child(
                                div()
                                    .h_full()
                                    .w(relative(fraction))
                                    .rounded_md()
                                    .bg(rgb(0xd7a05a)),
                            ),
                    );
            }
        }
        let mut footer = div().flex().gap_3();
        if self.busy {
            footer = footer.child(button("cancel", "Cancel", true).on_click(cx.listener(
                |v, _, _, cx| {
                    v.cancel.store(true, Ordering::Relaxed);
                    v.status =
                        "Cancelling… Waiting for the current request and cleanup to finish.".into();
                    cx.notify();
                },
            )));
        }
        if let Some(path) = self.output.clone() {
            footer = footer.child(button("show", "Open exported folder", true).on_click(
                move |_, _, cx| {
                    cx.reveal_path(&path);
                },
            ));
        }
        let mut transfer_details = div();
        if let Some(progress) = &self.watch_progress {
            let elapsed = self
                .watch_finished_elapsed
                .or_else(|| self.export_started.map(|start| start.elapsed()))
                .unwrap_or_default();
            let fraction = if progress.tracks.expected == 0 {
                0.
            } else {
                (progress.tracks.completed as f32 / progress.tracks.expected as f32).min(1.)
            };
            let rate = if progress.bytes == 0 || elapsed.as_secs_f64() < 1. {
                "Waiting for the first track".into()
            } else {
                format!(
                    "{}/s average",
                    data_size((progress.bytes as f64 / elapsed.as_secs_f64()) as u64)
                )
            };
            let eta = if self.watch_done {
                "Complete".into()
            } else if progress.phase == "Stopped" {
                "Stopped".into()
            } else if progress.phase == "Removing old music" {
                "Unknown during removal".into()
            } else if progress.tracks.completed == 0 {
                "After the first track".into()
            } else if progress.tracks.completed >= progress.tracks.expected {
                "Finishing playlists".into()
            } else {
                clock_time(Duration::from_secs_f64(
                    elapsed.as_secs_f64()
                        * (progress
                            .tracks
                            .expected
                            .saturating_sub(progress.tracks.completed))
                            as f64
                        / progress.tracks.completed as f64,
                ))
            };
            transfer_details = panel()
                .flex()
                .flex_col()
                .gap_2()
                .child(
                    div()
                        .text_lg()
                        .child(format!("Device transfer · {}", progress.phase)),
                )
                .child(div().text_sm().child(format!(
                    "{} of {} tracks verified · {} verified · about {} estimated",
                    progress.tracks.completed,
                    progress.tracks.expected,
                    data_size(progress.bytes),
                    data_size(progress.estimated_bytes)
                )))
                .child(div().text_sm().child(format!(
                    "Rate: {rate} · Elapsed: {} · Time left: {eta}",
                    clock_time(elapsed)
                )))
                .child(
                    div()
                        .text_sm()
                        .text_color(rgb(0xaaa79d))
                        .child("Rate counts verified MP3 bytes and updates after each track."),
                )
                .child(
                    div()
                        .h(px(8.))
                        .w_full()
                        .rounded_md()
                        .bg(rgb(0x3b3932))
                        .child(
                            div()
                                .h_full()
                                .w(relative(fraction))
                                .rounded_md()
                                .bg(rgb(0xd7a05a)),
                        ),
                );
        }
        let mut sources = div().flex().items_center().gap_2().child(
            div()
                .text_sm()
                .text_color(rgb(0xc6c0b3))
                .child("Music source"),
        );
        for (i, provider) in [Provider::Plex, Provider::Jellyfin, Provider::Local]
            .into_iter()
            .enumerate()
        {
            let selected = self.provider == provider;
            sources = sources.child(
                button_with_reason(
                    ("music-source", i),
                    provider.label(),
                    !self.busy && self.modal.is_none(),
                    if self.exporting {
                        "Music source cannot change during export. Wait for completion or cancel."
                    } else {
                        "Finish the current operation or close the dialog before changing source."
                    },
                )
                .bg(rgb(if selected { 0x594529 } else { 0x302e28 }))
                .border_color(rgb(if selected { 0xd7a05a } else { 0x3b3932 }))
                .on_click(cx.listener(move |view, _, _, cx| {
                    view.switch_provider(provider, cx);
                    cx.notify();
                })),
            );
        }
        if self.exporting {
            sources = sources.child(
                div()
                    .text_xs()
                    .text_color(rgb(0xd7a05a))
                    .child("🔒 Source locked during export"),
            );
        }
        let navigation = div().flex().gap_2().children(
            [
                (Page::Playlists, "Playlists"),
                (Page::WatchMusic, "Manage device content"),
                (Page::Settings, "Settings"),
            ]
            .into_iter()
            .enumerate()
            .map(|(index, (page, label))| {
                let selected = self.page == page;
                let enabled = self.modal.is_none()
                    && (page != Page::WatchMusic || self.selected_watch.is_some());
                button_with_reason(
                    ("page", index),
                    label,
                    enabled,
                    if self.modal.is_some() {
                        "Close the dialog before changing pages."
                    } else {
                        "Connect and select a Garmin device to manage its music."
                    },
                )
                .bg(rgb(if selected { 0x594529 } else { 0x302e28 }))
                .border_color(rgb(if selected { 0xd7a05a } else { 0x3b3932 }))
                .on_click(cx.listener(move |v, _, _, cx| {
                    if v.modal.is_none() && (page != Page::WatchMusic || v.selected_watch.is_some())
                    {
                        v.page = page;
                        v.watch_music_pending = false;
                        if page == Page::WatchMusic {
                            if v.busy {
                                v.watch_music_pending = true;
                            } else {
                                v.inspect_watch_music();
                            }
                        }
                        cx.notify();
                    }
                }))
            }),
        );
        let mut shell = div()
            .size_full()
            .relative()
            .bg(rgb(0x1b1a17))
            .text_color(rgb(0xeeeae0))
            .font_family("IBM Plex Sans")
            .p_8()
            .flex()
            .flex_col()
            .gap_5()
            .child(
                div().flex().items_center().child(
                    div()
                        .flex()
                        .flex_col()
                        .gap_1()
                        .child(
                            div()
                                .text_3xl()
                                .font_weight(FontWeight::BLACK)
                                .child("SYNCANDRUN"),
                        )
                        .child(
                            div()
                                .text_sm()
                                .text_color(rgb(0xd7a05a))
                                .font_family("IBM Plex Mono")
                                .child(format!(
                                    "{} → MP3 → GARMIN",
                                    self.provider.label().to_uppercase()
                                )),
                        ),
                ),
            )
            .child(sources)
            .when(self.usb_enabled, |shell| shell.child(watch_card))
            .child(
                div()
                    .p_2()
                    .rounded_md()
                    .border_1()
                    .border_color(rgb(0x3b3932))
                    .bg(rgb(0x25241f))
                    .child(navigation),
            )
            .child(
                div()
                    .id("content")
                    .flex_1()
                    .min_h(px(0.))
                    .overflow_y_scroll()
                    .child(content),
            )
            .when(
                self.page == Page::Playlists && self.watch_progress.is_some(),
                |shell| shell.child(transfer_details),
            )
            .when(
                !self.source_loading
                    && self.status != "Ready to export."
                    && self.status != "Connect a music account to get started."
                    && self.status != "Choose a music source to get started.",
                |shell| {
                    shell.child(
                        div()
                            .relative()
                            .p_4()
                            .rounded_md()
                            .border_1()
                            .border_color(rgb(if self.exporting { 0x7a5c35 } else { 0x3b3932 }))
                            .bg(rgb(0x2b2923))
                            .child(self.status.clone())
                            .when(self.exporting, |status| {
                                status.child(export_status_glow(
                                    self.export_started
                                        .map(|start| start.elapsed())
                                        .unwrap_or_default(),
                                ))
                            }),
                    )
                },
            )
            .child(footer)
            .child(
                div()
                    .pt_3()
                    .border_t_1()
                    .border_color(rgb(0x3b3932))
                    .flex()
                    .justify_between()
                    .text_xs()
                    .text_color(rgb(0xaaa79d))
                    .font_family("IBM Plex Mono")
                    .child("SYNCANDRUN  /  PERSONAL MUSIC EXPORT")
                    .child("GPL-3.0"),
            );
        if let Some(modal) = &self.modal {
            if matches!(modal, Modal::WatchTroubleshooting) {
                let mut help = div().flex().flex_col().gap_3()
                    .child(div().text_2xl().child("Garmin device troubleshooting"))
                    .child("SyncAndRun is checking USB visibility, access, udev, competing MTP apps, and device discovery. It may run a time-limited MTP probe if needed.");
                if self.watch_diagnostic_running {
                    let elapsed = self
                        .watch_diagnostic_started
                        .map(|start| start.elapsed())
                        .unwrap_or_default();
                    let label = if elapsed >= Duration::from_millis(500) {
                        let frames = ["◐", "◓", "◑", "◒"];
                        format!(
                            "{} Checking device connection…",
                            frames[(elapsed.as_millis() / 120) as usize % frames.len()]
                        )
                    } else {
                        "Checking device connection…".into()
                    };
                    help = help.child(
                        div()
                            .p_3()
                            .rounded_sm()
                            .bg(rgb(0x302c24))
                            .text_color(rgb(0xd7a05a))
                            .child(label),
                    );
                } else if let Some(result) = &self.watch_diagnostics {
                    help = help
                        .child(div().text_lg().child("What the checks found"))
                        .child(
                            div()
                                .p_3()
                                .rounded_sm()
                                .bg(rgb(0x171713))
                                .font_family("IBM Plex Mono")
                                .text_sm()
                                .child(result.summary()),
                        )
                        .child(div().text_lg().child("What to do next"));
                    for (index, step) in result.steps().iter().enumerate() {
                        help = help.child(format!("{}. {step}", index + 1));
                    }
                    help = help.child(
                        button("rerun-watch-checks", "Run checks again", true).on_click(
                            cx.listener(|view, _, _, cx| {
                                view.run_watch_diagnostics();
                                cx.notify();
                            }),
                        ),
                    );
                    let prompt = result.agent_prompt();
                    let copy_prompt = prompt.clone();
                    help = help
                        .child(div().text_lg().child("Ask an agent to fix this:"))
                        .child(
                            div()
                                .p_3()
                                .rounded_sm()
                                .bg(rgb(0x171713))
                                .font_family("IBM Plex Mono")
                                .text_sm()
                                .child(prompt),
                        )
                        .child(
                            button(
                                "copy-watch-agent-prompt",
                                if self.watch_prompt_copied {
                                    "Copied"
                                } else {
                                    "Copy prompt"
                                },
                                true,
                            )
                            .on_click(cx.listener(
                                move |view, _, _, cx| {
                                    cx.write_to_clipboard(ClipboardItem::new_string(
                                        copy_prompt.clone(),
                                    ));
                                    view.watch_prompt_copied = true;
                                    view.status = "Troubleshooting prompt copied.".into();
                                    cx.notify();
                                },
                            )),
                        );
                }
                shell = shell.child(
                    div()
                        .absolute()
                        .top_0()
                        .right_0()
                        .bottom_0()
                        .left_0()
                        .bg(rgba(0x11100edc))
                        .flex()
                        .items_center()
                        .justify_center()
                        .on_mouse_move(|_, _, cx| cx.stop_propagation())
                        .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                        .child(
                            panel()
                                .w(px(650.))
                                .max_h(relative(0.85))
                                .flex()
                                .flex_col()
                                .gap_4()
                                .child(
                                    div()
                                        .id("watch-help-scroll")
                                        .flex_1()
                                        .min_h(px(0.))
                                        .overflow_y_scroll()
                                        .child(help),
                                )
                                .child(button("close-watch-help", "Close", true).on_click(
                                    cx.listener(|view, _, _, cx| {
                                        view.modal = None;
                                        cx.notify();
                                    }),
                                )),
                        ),
                );
            } else {
                let (title, detail, confirm): (&str, String, &str) = match modal {
                Modal::WatchTroubleshooting => unreachable!(),
                Modal::CreateDefault(_) => (
                    "Create music library folder?",
                    "SyncAndRun will create ~/Music/SyncAndRun and export the selected playlists there.".into(),
                    "Create and export",
                ),
                Modal::ClearLibrary(_) => (
                    "Clear exported music?",
                    "Only unchanged files generated by SyncAndRun will be removed. Modified and unrelated files stay in the folder.".into(),
                    "Clear exported music",
                ),
                Modal::ReplaceMusic(watch) => (
                    "Replace device music?",
                    format!("SyncAndRun will first send and check the selected playlists on {}. It will then delete older music in that device’s Music folder. You cannot undo this. Activities and Garmin files outside Music stay on the device. If the device disconnects during removal, some old music can remain.", watch.model),
                    "Replace device music",
                ),
                Modal::RemoveMusic(watch, _, name) => (
                    "Remove this music?",
                    format!("Remove ‘{name}’ from the Music folder on {}? You cannot undo this. Activities and Garmin files outside Music stay on the device. If the device disconnects, some music can remain.", watch.model),
                    "Remove item",
                ),
            };
                shell = shell.child(
                    div()
                        .absolute()
                        .top_0()
                        .right_0()
                        .bottom_0()
                        .left_0()
                        .bg(rgba(0x11100edc))
                        .flex()
                        .items_center()
                        .justify_center()
                        .on_mouse_move(|_, _, cx| cx.stop_propagation())
                        .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                        .child(
                            panel()
                                .w(px(500.))
                                .flex()
                                .flex_col()
                                .gap_4()
                                .child(div().text_2xl().child(title))
                                .child(div().text_color(rgb(0xc6c0b3)).child(detail))
                                .child(
                                    div()
                                        .flex()
                                        .gap_3()
                                        .child(
                                            button("modal-confirm", confirm, true)
                                                .bg(rgb(0xbd8338))
                                                .border_color(rgb(0xe0a454))
                                                .text_color(rgb(0x171510))
                                                .on_click(cx.listener(|view, _, _, cx| {
                                                    view.confirm_modal();
                                                    cx.notify();
                                                })),
                                        )
                                        .child(button("modal-cancel", "Cancel", true).on_click(
                                            cx.listener(|view, _, _, cx| {
                                                view.modal = None;
                                                cx.notify();
                                            }),
                                        )),
                                ),
                        ),
                );
            }
        }
        shell
    }
}
fn main() {
    let mut args = std::env::args_os().skip(1);
    let mut path = None;
    let mut usb_enabled = true;
    while let Some(arg) = args.next() {
        if arg == "--profile" {
            path = args.next().map(PathBuf::from);
            if path.is_none() {
                eprintln!("--profile needs a folder");
                std::process::exit(2);
            }
        } else if arg == "--no-usb" {
            usb_enabled = false;
        } else if arg == "--help" || arg == "-h" {
            println!("syncandrun-desktop [--profile FOLDER] [--no-usb]");
            return;
        } else {
            eprintln!("Unknown option. Use --help.");
            std::process::exit(2);
        }
    }
    let path = match path.map(Ok).unwrap_or_else(profile::default_path) {
        Ok(p) => p,
        Err(e) => {
            eprintln!("{e}");
            std::process::exit(1);
        }
    };
    Application::new().run(move |cx: &mut App| {
        cx.on_window_closed(|cx| {
            if cx.windows().is_empty() {
                cx.quit();
            }
        })
        .detach();
        let bounds = Bounds::centered(None, size(px(1080.), px(860.)), cx);
        if cx
            .open_window(
                WindowOptions {
                    window_bounds: Some(WindowBounds::Windowed(bounds)),
                    window_min_size: Some(size(px(800.), px(640.))),
                    titlebar: Some(TitlebarOptions {
                        title: Some("SyncAndRun".into()),
                        ..Default::default()
                    }),
                    ..Default::default()
                },
                |_, cx| cx.new(|cx| Desktop::new(path, usb_enabled, cx)),
            )
            .is_err()
        {
            eprintln!("Could not open the SyncAndRun window.");
            cx.quit();
        }
        cx.activate(true);
    });
}
