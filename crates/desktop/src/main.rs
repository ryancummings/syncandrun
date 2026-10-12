mod view;
#[cfg(not(target_os = "macos"))]
mod watch_diagnostics;
#[cfg(target_os = "macos")]
#[path = "watch_diagnostics_macos.rs"]
mod watch_diagnostics;

use anyhow::{Context as _, Result, ensure};
use gpui_kit::component::{
    ActiveTheme as _, Theme, ThemeSet, WindowExt as _,
    button::ButtonVariant,
    input::{InputEvent, InputState},
};
use gpui_kit::*;
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
    jellyfin::{self, Jellyfin, JellyfinLogin},
    plex::{self, LibraryOverview, Login, PlaylistSummary, Plex, ServerChoice},
    profile::{self, Profile, Provider},
    provider::MusicSource,
};
use watch_diagnostics::WatchDiagnostics;

enum Event {
    WatchDiagnostics(WatchDiagnostics),
    SourceAvailability([bool; 3]),
    Watches(Result<Discovery, String>),
    WatchPresence {
        observed: Vec<String>,
        connected: Result<Vec<String>, String>,
    },
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
    presence_checking: bool,
    last_presence_check: Instant,
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
    jellyfin_url: Entity<InputState>,
    jellyfin_url_error: Option<String>,
    jellyfin_user: Entity<InputState>,
    jellyfin_password: Entity<InputState>,
    playlist_filter: Entity<InputState>,
    _subscriptions: Vec<Subscription>,
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
    fn new(
        profile: PathBuf,
        usb_enabled: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let jellyfin_url = cx.new(|cx| InputState::new(window, cx));
        let jellyfin_user = cx.new(|cx| InputState::new(window, cx));
        let jellyfin_password = cx.new(|cx| InputState::new(window, cx).masked(true));
        let playlist_filter =
            cx.new(|cx| InputState::new(window, cx).placeholder("Filter playlists"));
        let mut subscriptions =
            vec![cx.subscribe(&playlist_filter, |_, _, _: &InputEvent, cx| cx.notify())];
        for input in [&jellyfin_url, &jellyfin_user, &jellyfin_password] {
            subscriptions.push(cx.subscribe_in(
                input,
                window,
                |view: &mut Self, _, event: &InputEvent, window, cx| {
                    if let InputEvent::PressEnter { .. } = event {
                        view.jellyfin_sign_in(window, cx);
                        cx.notify();
                    }
                },
            ));
        }
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
            presence_checking: false,
            last_presence_check: Instant::now(),
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
            jellyfin_url,
            jellyfin_url_error: None,
            jellyfin_user,
            jellyfin_password,
            playlist_filter,
            _subscriptions: subscriptions,
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
                cx.background_executor()
                    .timer(Duration::from_millis(40))
                    .await;
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
                            && !view.busy
                            && !view.watch_diagnostic_running
                            && !view.scanning
                            && view.watches.is_empty()
                            && view.last_scan.elapsed() >= Duration::from_secs(8)
                        {
                            view.scan_watches();
                            changed = true;
                        }
                        if view.usb_enabled
                            && !view.busy
                            && !view.scanning
                            && !view.presence_checking
                            && !view.watches.is_empty()
                            && view.last_presence_check.elapsed() >= Duration::from_secs(2)
                        {
                            view.check_watch_presence();
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
    fn check_watch_presence(&mut self) {
        self.presence_checking = true;
        self.last_presence_check = Instant::now();
        let watches = self.watches.clone();
        let observed = watches.iter().map(Watch::key).collect();
        let sender = self.sender.clone();
        std::thread::spawn(move || {
            let connected = device::connected_keys(&watches).map_err(|error| error.to_string());
            let _ = sender.send(Event::WatchPresence {
                observed,
                connected,
            });
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
    fn transfer_to_watch(&mut self, window: &mut Window, cx: &mut Context<Self>) {
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
            self.open_modal(Modal::ReplaceMusic(watch), window, cx);
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
    fn switch_provider(&mut self, provider: Provider, window: &mut Window, cx: &mut Context<Self>) {
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
        self.jellyfin_url_error = None;
        self.jellyfin_password
            .update(cx, |input, cx| input.set_value("", window, cx));
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
    fn jellyfin_sign_in(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.busy {
            return;
        }
        let url = self.jellyfin_url.read(cx).value().to_string();
        if let Err(error) = jellyfin::check_server_address(&url) {
            self.jellyfin_url_error = Some(error.to_string());
            return;
        }
        self.jellyfin_url_error = None;
        let username = self.jellyfin_user.read(cx).value().to_string();
        let password = self.jellyfin_password.read(cx).value().to_string();
        self.jellyfin_password
            .update(cx, |input, cx| input.set_value("", window, cx));
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
            Event::WatchPresence {
                observed,
                connected,
            } => {
                self.presence_checking = false;
                if self.busy
                    || self.scanning
                    || self.watches.iter().map(Watch::key).collect::<Vec<_>>() != observed
                {
                    return;
                }
                if let Ok(connected) = connected
                    && connected.len() < self.watches.len()
                {
                    let connected: HashSet<_> = connected.into_iter().collect();
                    self.watches
                        .retain(|watch| connected.contains(&watch.key()));
                    if !self
                        .watches
                        .iter()
                        .any(|watch| Some(watch.key()) == self.selected_watch)
                    {
                        self.selected_watch = if self.watches.len() == 1 {
                            Some(self.watches[0].key())
                        } else {
                            None
                        };
                        self.music_items.clear();
                        self.watch_music_pending = false;
                        if self.selected_watch.is_none() && self.page == Page::WatchMusic {
                            self.page = Page::Playlists;
                        }
                    }
                    self.watch_status = if self.watches.is_empty() {
                        "Garmin device disconnected. Reconnect it or select Scan for device."
                    } else {
                        "Garmin device ready for music transfer"
                    }
                    .into();
                    self.last_scan = Instant::now();
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
    fn create_files(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.busy || self.modal.is_some() {
            return;
        }
        if self.direct {
            self.transfer_to_watch(window, cx);
            return;
        }
        if self.using_default_library && self.destination.as_ref().is_some_and(|p| !p.exists()) {
            let path = self.destination.as_ref().expect("default path").clone();
            self.open_modal(Modal::CreateDefault(path), window, cx);
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
    fn confirm_purge(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.busy || self.modal.is_some() {
            return;
        }
        let Some(library) = self.destination.clone() else {
            return;
        };
        self.open_modal(Modal::ClearLibrary(library), window, cx);
    }
    fn open_modal(&mut self, modal: Modal, window: &mut Window, cx: &mut Context<Self>) {
        if self.modal.is_some() {
            return;
        }
        let view = cx.entity().downgrade();
        if matches!(modal, Modal::WatchTroubleshooting) {
            self.modal = Some(modal);
            self.run_watch_diagnostics();
            window.open_dialog(cx, move |dialog, _, cx| {
                view::troubleshooting_dialog(dialog, &view, cx)
            });
            cx.notify();
            return;
        }
        let (title, detail, confirm, danger): (&str, String, &str, bool) = match &modal {
            Modal::WatchTroubleshooting => unreachable!(),
            Modal::CreateDefault(_) => (
                "Create music library folder?",
                "SyncAndRun will create ~/Music/SyncAndRun and export the selected playlists there.".into(),
                "Create and export",
                false,
            ),
            Modal::ClearLibrary(_) => (
                "Clear exported music?",
                "Only unchanged files generated by SyncAndRun will be removed. Modified and unrelated files stay in the folder.".into(),
                "Clear exported music",
                true,
            ),
            Modal::ReplaceMusic(watch) => (
                "Replace device music?",
                format!("SyncAndRun will first send and check the selected playlists on {}. It will then delete older music in that device’s Music folder. You cannot undo this. Activities and Garmin files outside Music stay on the device. If the device disconnects during removal, some old music can remain.", watch.model),
                "Replace device music",
                true,
            ),
            Modal::RemoveMusic(watch, _, name) => (
                "Remove this music?",
                format!("Remove ‘{name}’ from the Music folder on {}? You cannot undo this. Activities and Garmin files outside Music stay on the device. If the device disconnects, some music can remain.", watch.model),
                "Remove item",
                true,
            ),
        };
        self.modal = Some(modal);
        let detail = SharedString::from(detail);
        window.open_alert_dialog(cx, move |alert, _, _| {
            let ok = view.clone();
            let close = view.clone();
            alert
                .title(title)
                .description(detail.clone())
                .confirm()
                .ok_text(confirm)
                .ok_variant(if danger {
                    ButtonVariant::Danger
                } else {
                    ButtonVariant::Primary
                })
                .on_ok(move |_, _, cx| {
                    let _ = ok.update(cx, |view, cx| {
                        view.confirm_modal();
                        cx.notify();
                    });
                    true
                })
                .on_close(move |_, _, cx| {
                    let _ = close.update(cx, |view, cx| {
                        view.modal = None;
                        cx.notify();
                    });
                })
        });
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
    gpui_kit::application()
        .with_assets(gpui_kit::assets::Assets)
        .run(move |cx: &mut App| {
            gpui_kit::init(cx);
            if let Some(theme) = serde_json::from_str::<ThemeSet>(include_str!("theme.json"))
                .ok()
                .and_then(|set| set.themes.into_iter().next())
            {
                Theme::update(cx, |current| current.apply_config(&std::rc::Rc::new(theme)));
            }
            cx.on_window_closed(|cx, _| {
                if cx.windows().is_empty() {
                    cx.quit();
                }
            })
            .detach();
            let bounds = Bounds::centered(None, size(px(1200.), px(820.)), cx);
            if gpui_kit::open_window(
                WindowOptions {
                    window_bounds: Some(WindowBounds::Windowed(bounds)),
                    window_min_size: Some(size(px(860.), px(640.))),
                    titlebar: Some(TitlebarOptions {
                        title: Some("SyncAndRun".into()),
                        ..Default::default()
                    }),
                    ..Default::default()
                },
                cx,
                |window, cx| cx.new(|cx| Desktop::new(path, usb_enabled, window, cx)),
            )
            .is_err()
            {
                eprintln!("Could not open the SyncAndRun window.");
                cx.quit();
            }
            cx.activate(true);
        });
}
