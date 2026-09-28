use anyhow::{Context as _, Result};
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
    plex::{self, LibraryOverview, Login, PlaylistSummary, Plex, ServerChoice},
    profile::{self, Profile},
};

enum Event {
    Watches(Result<Discovery, String>),
    MusicItems(Vec<device::MusicItem>),
    MusicRemoved {
        count: usize,
        items: Result<Vec<device::MusicItem>, String>,
    },
    WatchProgress(device::TransferProgress),
    Transferred(device::TransferResult),
    Loaded {
        connected: bool,
        playlists: Vec<PlaylistSummary>,
        selected: Vec<String>,
        server: Option<(String, String, String)>,
        overview: Option<LibraryOverview>,
    },
    ConnectionUnavailable(String, (String, String, String)),
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
    page: Page,
    music_items: Vec<device::MusicItem>,
    replace_watch_music: bool,
    scanning: bool,
    last_scan: Instant,
    direct: bool,
    connected: bool,
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
    busy: bool,
    cancel: Arc<AtomicBool>,
    sender: mpsc::Sender<Event>,
    receiver: mpsc::Receiver<Event>,
    preference_sender: mpsc::Sender<Preferences>,
}
#[derive(Clone, Copy, PartialEq, Eq)]
enum Page {
    Playlists,
    WatchMusic,
    Settings,
}
enum Modal {
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
            watch_status: "Looking for a Garmin watch…".into(),
            page: Page::Playlists,
            music_items: Vec::new(),
            replace_watch_music: false,
            scanning: false,
            last_scan: Instant::now(),
            direct: true,
            connected: false,
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
            busy: false,
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
                Timer::after(Duration::from_millis(100)).await;
                if view
                    .update(cx, |view, cx| {
                        let mut changed = false;
                        while let Ok(event) = view.receiver.try_recv() {
                            view.apply(event);
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
        self.output = None;
        self.progress = None;
        self.watch_progress = None;
        self.watch_done = false;
        self.watch_finished_elapsed = None;
        self.export_started = Some(Instant::now());
        self.job(
            "Refreshing selected playlists for the watch…",
            move |path, cancel, sender| {
                let mut profile = Profile::open(path)?;
                let plex = Plex::new(&profile)?;
                let plan = plex.refresh(&mut profile, &ids, &cancel)?;
                let connection = profile.connection()?.context("Sign in to Plex first")?;
                let source = |t: &syncandrun_core::Track, b| plex.audio(&connection, t, b);
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
        self.job("Reading watch Music folder…", move |_, _, _| {
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
        self.job("Loading Plex playlists…", |path, cancel, _| {
            let profile = Profile::open(path)?;
            let plex = Plex::new(&profile)?;
            let connection = profile.connection()?;
            let playlists = if let Some(connection) = &connection {
                match plex.playlists(connection, &cancel) {
                    Ok(playlists) => playlists,
                    Err(error) => {
                        return Ok(Event::ConnectionUnavailable(
                            error.to_string(),
                            (
                                connection.base_uri.clone(),
                                connection.server_id.clone(),
                                connection.library_id.clone(),
                            ),
                        ));
                    }
                }
            } else {
                vec![]
            };
            let overview = connection
                .as_ref()
                .and_then(|connection| plex.library_overview(connection).ok());
            Ok(Event::Loaded {
                connected: connection.is_some(),
                playlists,
                selected: profile.selected_ids()?,
                server: connection.map(|c| (c.base_uri, c.server_id, c.library_id)),
                overview,
            })
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
        match event {
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
                            "No usable Garmin watch found."
                        } else if watches.is_empty() {
                            "Plug in your Garmin music watch and select USB / MTP mode."
                        } else {
                            "Connected over USB · direct music transfer available"
                        }
                        .to_owned();
                        if !discovery.unavailable.is_empty() {
                            status.push_str(&format!(" · {} Garmin device(s) unavailable; close other MTP apps or check USB permissions", discovery.unavailable.len()));
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
                self.status = "Watch music list refreshed.".into();
            }
            Event::MusicRemoved { count, items } => match items {
                Ok(items) => {
                    self.music_items = items;
                    self.status =
                        format!("Removed {count} music objects. Watch music is up to date.");
                }
                Err(_) => {
                    self.music_items.clear();
                    self.status = format!(
                        "Removed {count} music objects, but could not reload Music. Select Refresh watch music to try again."
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
                    "Transferred and verified {} tracks in {} playlists; removed {} old music objects. Disconnect USB to let Garmin index the music.",
                    result.tracks, result.playlists, result.removed
                );
                self.last_scan = Instant::now() - Duration::from_secs(8);
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
                connected,
                playlists,
                selected,
                server,
                overview,
            } => {
                self.connected = connected;
                self.playlists = playlists;
                self.server = server;
                self.overview = overview;
                self.connection_status = if connected {
                    "Connected and playlists loaded"
                } else {
                    "No Plex account connected"
                }
                .into();
                if !self.has_saved_selection {
                    self.selected = selected.into_iter().collect();
                }
                self.status = if connected {
                    "Ready to export."
                } else {
                    "Connect your Plex account to get started."
                }
                .into();
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
                self.status = "Files ready. Copy the playlist folders into your watch’s Music folder using Files or another MTP app.".into();
            }
            Event::Purged(result) => {
                self.output = None;
                self.status = format!(
                    "Cleared {} generated files from the music library. {} modified files were preserved; unrelated files were untouched.",
                    result.removed, result.preserved_modified
                );
            }
            Event::ConnectionUnavailable(message, server) => {
                self.connected = true;
                self.server = Some(server);
                self.overview = None;
                self.connection_status = "Saved connection; Plex is unreachable".into();
                self.status =
                    format!("{message}. Your saved connection is intact. Use Refresh to retry.");
            }
            Event::Failed(message) => {
                self.progress = None;
                if let Some(progress) = &mut self.watch_progress {
                    progress.phase = "Stopped";
                    self.watch_finished_elapsed =
                        self.export_started.map(|started| started.elapsed());
                }
                self.music_items.clear();
                self.status = message;
            }
        }
        self.busy = false;
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
                    _ => view.status =
                        "Could not open the folder picker. Check that a desktop portal is running."
                            .into(),
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
        self.job(
            "Refreshing the selected playlists…",
            move |path, cancel, sender| {
                let mut profile = Profile::open(path)?;
                let plex = Plex::new(&profile)?;
                let plan = plex.refresh(&mut profile, &ids, &cancel)?;
                let connection = profile.connection()?.context("Sign in to Plex first")?;
                if create_default && !destination.exists() {
                    fs::create_dir_all(&destination)
                        .context("Could not create the default music library folder")?;
                }
                let path = export::export_sync(
                    &plan,
                    bitrate,
                    &destination,
                    &cancel,
                    |t, b| plex.audio(&connection, t, b),
                    |p| {
                        let _ = sender.send(Event::Progress(p));
                    },
                )?;
                Ok(Event::Exported(path))
            },
        );
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
                self.job("Removing watch music…", move |_, cancel, _| {
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
fn button(
    id: impl Into<ElementId>,
    label: impl Into<SharedString>,
    enabled: bool,
) -> Stateful<Div> {
    div()
        .id(id)
        .px_4()
        .py_2()
        .rounded_md()
        .border_1()
        .border_color(rgb(0x38443d))
        .bg(rgb(if enabled { 0x223c31 } else { 0x202621 }))
        .text_color(rgb(if enabled { 0xe9f5ed } else { 0x7b877f }))
        .when(enabled, |d| {
            d.cursor_pointer().hover(|s| s.bg(rgb(0x315843)))
        })
        .child(label.into())
}
fn panel() -> Div {
    div()
        .p_5()
        .rounded_lg()
        .border_1()
        .border_color(rgb(0x31443a))
        .bg(rgb(0x18251e))
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
                    .child(div().text_lg().child("Garmin watch"))
                    .child(
                        button(
                            "scan-watch",
                            if self.scanning {
                                "Scanning…"
                            } else {
                                "Scan USB"
                            },
                            active && !self.scanning,
                        )
                        .text_sm()
                        .on_click(cx.listener(|v, _, _, cx| {
                            if !v.busy {
                                v.scan_watches();
                                cx.notify();
                            }
                        })),
                    ),
            )
            .child(
                div()
                    .text_sm()
                    .text_color(rgb(0xa8cbb4))
                    .child(self.watch_status.clone()),
            );
        for (i, watch) in self.watches.iter().enumerate() {
            let key = watch.key();
            let chosen = Some(key.clone()) == self.selected_watch;
            let label = format!(
                "{}{} · {:.2} GB free / {:.2} GB · firmware {}",
                if chosen { "✓ " } else { "" },
                watch.model,
                watch.free_bytes as f64 / 1e9,
                watch.total_bytes as f64 / 1e9,
                watch.firmware
            );
            watch_card = watch_card.child(button(("watch", i), label, active).text_sm().on_click(
                cx.listener(move |v, _, _, cx| {
                    if !v.busy {
                        v.selected_watch = Some(key.clone());
                        v.music_items.clear();
                        if v.page == Page::WatchMusic {
                            v.inspect_watch_music();
                        }
                        cx.notify();
                    }
                }),
            ));
        }
        let mut content = div().flex().flex_col().gap_3();
        if self.page == Page::WatchMusic {
            content = content.child(div().text_2xl().child("Watch music"))
                .child(div().text_sm().child("This page shows the selected watch’s Music folder. Use Playlists to add or replace music. Activities and Garmin files outside Music stay on the watch."))
                .child(button("refresh-watch-music", "Refresh watch music", active).on_click(cx.listener(|v, _, _, cx| { v.inspect_watch_music(); cx.notify(); })));
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
                .unwrap_or("Saved Plex server");
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
            let library_tracks = self
                .overview
                .as_ref()
                .and_then(|o| o.library_tracks)
                .map(|count| count.to_string())
                .unwrap_or_else(|| "—".into());
            let selected: Vec<_> = self
                .playlists
                .iter()
                .filter(|p| self.selected.contains(&p.id))
                .collect();
            let selected_tracks: u64 = selected.iter().map(|p| p.track_count).sum();
            let server_card = panel()
                .flex()
                .flex_col()
                .gap_3()
                .flex_1()
                .min_w(px(0.))
                .when(!compact, |card| card.h(px(410.)))
                .child(div().text_xl().child("Plex server"))
                .child(div().text_lg().child(server_name.to_owned()))
                .child(
                    div()
                        .text_sm()
                        .text_color(rgb(if self.connected { 0xa8d6b5 } else { 0xd8b980 }))
                        .child(self.connection_status.clone()),
                )
                .child(div().text_sm().text_color(rgb(0x91a69a)).child("Address"))
                .child(div().text_sm().truncate().child(server_address.to_owned()))
                .child(div().text_sm().text_color(rgb(0x91a69a)).child("Server ID"))
                .child(div().text_sm().truncate().child(server_id.to_owned()))
                .child(
                    div()
                        .text_sm()
                        .text_color(rgb(0x91a69a))
                        .child(format!("Plex version · {server_version}")),
                )
                .child(
                    button("account", "Connect or change account", active).on_click(cx.listener(
                        |view, _, _, cx| {
                            if view.modal.is_none() {
                                view.sign_in();
                                cx.notify();
                            }
                        },
                    )),
                );
            let stat = |label: &'static str, value: String| {
                div()
                    .w(px(170.))
                    .p_3()
                    .rounded_md()
                    .bg(rgb(0x22382b))
                    .child(div().text_2xl().child(value))
                    .child(div().text_sm().text_color(rgb(0xa8cbb4)).child(label))
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
                .child(div().text_xl().child("Plex music library"))
                .child(div().text_lg().child(library_name.to_owned()))
                .child(div().text_sm().text_color(rgb(0x91a69a)).child(format!("Library ID · {library_id}")))
                .child(div().text_sm().text_color(rgb(0x9fb8a7)).child(
                    "SyncAndRun reads playlists and tracks from Plex. It does not change your Plex library."
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
                .child(div().text_xl().child("Export library"))
                .child(div().text_color(rgb(0xa8cbb4)).child(folder))
                .child(button("folder", "Change export folder", active).on_click(
                    cx.listener(|view, _, _, cx| view.choose_folder(cx))
                ))
                .child(div().text_sm().text_color(rgb(0x9fb8a7)).child(
                    "Export creates a folder and .m3u8 playlist for each selected playlist here. Later exports update app-generated music and remove obsolete generated files only when they are unchanged. Your other files stay untouched."
                ))
                .child(div().text_sm().text_color(rgb(0x9fb8a7)).child(
                    "After copying music to your watch, you can clear unchanged app-generated files. Modified files and unrelated files are preserved."
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
                                .text_color(rgb(0x9fb8a7))
                                .child("Connection and library details."),
                        ),
                )
                .child(layout.gap_4().child(server_card).child(library_card))
                .child(management);
        } else if !self.connected {
            content = content
                .child(div().text_2xl().child("Bring your music along"))
                .child(
                    panel()
                        .flex()
                        .flex_col()
                        .gap_4()
                        .w(px(540.))
                        .child(div().text_xl().child("Connect Plex"))
                        .child(div().text_color(rgb(0x9fb8a7)).child(
                            "Choose your Plex playlists and make MP3 files for your Garmin watch.",
                        ))
                        .child(
                            button("login", "Sign in with Plex →", active)
                                .bg(rgb(0x21825a))
                                .border_color(rgb(0x4caa78))
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
            if self.playlists.is_empty() {
                available =
                    available.child("No audio playlists found. Create one in Plex, then refresh.");
            }
            for (i, playlist) in self.playlists.iter().enumerate() {
                let id = playlist.id.clone();
                let checked = self.selected.contains(&id);
                let selectable = playlist.track_count <= 10000;
                let label = format!(
                    "{}  {}  ·  {} tracks{}",
                    if checked { "✓" } else { "+" },
                    playlist.title,
                    playlist.track_count,
                    if selectable { "" } else { " · too large" }
                );
                let item = button(("playlist", i), label, active && selectable)
                    .w_full()
                    .bg(rgb(if checked { 0x28543e } else { 0x20352a }))
                    .border_color(rgb(if checked { 0x69b989 } else { 0x31443a }))
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
                            button("refresh", "Refresh from Plex", active)
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
                        .text_color(rgb(0xa8cbb4))
                        .child(format!("Selected · {}", selected.len())),
                )
                .child(syncing)
                .child(
                    div()
                        .text_sm()
                        .text_color(rgb(0xa8cbb4))
                        .child(format!("Available · {}", available_count)),
                )
                .child(available);
            let qualities = div()
                .flex()
                .flex_wrap()
                .gap_2()
                .children(BITRATES.into_iter().map(|bitrate| {
                    let selected = self.bitrate == bitrate;
                    button(
                        ("quality", bitrate as usize),
                        format!("{}{}", bitrate, if selected { " ✓" } else { "" }),
                        active,
                    )
                    .bg(rgb(if selected { 0x28543e } else { 0x20352a }))
                    .border_color(rgb(if selected { 0x69b989 } else { 0x31443a }))
                    .on_click(cx.listener(move |view, _, _, cx| {
                        if !view.busy {
                            view.bitrate = bitrate;
                            view.save_preferences();
                            cx.notify();
                        }
                    }))
                }));
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
            let export_panel = panel().flex().flex_col().gap_4()
                .child(div().text_xl().child("Transfer settings"))
                .child(div().p_3().rounded_md().border_1().border_color(rgb(0x42614d)).flex().flex_col().gap_2()
                    .child(div().text_sm().text_color(rgb(0xa8cbb4)).child("1. Choose where to send music"))
                    .children([(true, "Direct to watch"), (false, "Export to folder")].into_iter().map(|(direct, label)| {
                        button(if direct { "direct-mode" } else { "folder-mode" }, format!("{}{}", if self.direct == direct { "✓ " } else { "○ " }, label), active)
                            .bg(rgb(if self.direct == direct { 0x24543b } else { 0x203027 }))
                            .on_click(cx.listener(move |v, _, _, cx| { if !v.busy { v.direct = direct; v.output = None; v.save_preferences(); cx.notify(); } }))
                    })))
                .when(self.direct, |panel| panel.child(div().p_3().rounded_md().border_1().border_color(rgb(0x42614d)).flex().flex_col().gap_2()
                    .child(div().text_sm().text_color(rgb(0xa8cbb4)).child("2. Choose what happens to music on the watch"))
                    .child(button("add-watch-music", format!("{} Add playlists. Keep old music.", if self.replace_watch_music { "○" } else { "✓" }), active).bg(rgb(if self.replace_watch_music { 0x203027 } else { 0x24543b })).on_click(cx.listener(|v, _, _, cx| { v.replace_watch_music = false; cx.notify(); })))
                    .child(button("replace-watch-music", format!("{} Replace old music with these playlists.", if self.replace_watch_music { "✓" } else { "○" }), active).bg(rgb(if self.replace_watch_music { 0x24543b } else { 0x203027 })).on_click(cx.listener(|v, _, _, cx| { v.replace_watch_music = true; cx.notify(); })))
                    .child(div().text_sm().text_color(rgb(0xa8cbb4)).child("Replace sends and checks new music first. It then deletes old music in the watch’s Music folder. You need space for both copies until deletion ends."))))
                .child(div().flex().flex_col().gap_2()
                    .child(div().text_sm().text_color(rgb(0xa8cbb4)).child("MP3 quality"))
                    .child(qualities)
                    .child(div().text_sm().text_color(rgb(0x91a69a)).child("192 kbps is a good balance of sound and size.")))
                .child(div().p_4().rounded_md().bg(rgb(0x22382b))
                    .child(div().text_lg().child(format!("{} playlists  ·  {} tracks", selected.len(), tracks)))
                    .child(div().text_sm().text_color(rgb(0xa8cbb4)).child(format!("About {:.0} MB at {} kbps", estimate, self.bitrate))))
                .when(!self.direct, |panel| panel.child(div().flex().flex_col().gap_2()
                    .child(div().text_sm().text_color(rgb(0xa8cbb4)).child("Music library folder"))
                    .child(div().text_sm().child(folder))
                    .child(button("main-folder", "Change folder", active).on_click(
                        cx.listener(|view, _, _, cx| view.choose_folder(cx))
                    ))))
                .child(div().text_sm().text_color(rgb(0x91a69a))
                    .child(if self.direct { "The watch stays connected during transfer." } else { "Copy the exported playlist folders into your watch’s Music folder with an MTP app." }));
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
                        .child(div().text_color(rgb(0x9fb8a7)).child(if compact {
                            "Choose playlists, then scroll down for transfer settings."
                        } else {
                            "Choose playlists and MP3 quality, then send them to your watch."
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
                            .bg(rgb(0x263b2d))
                            .child(
                                div()
                                    .h_full()
                                    .w(relative(fraction))
                                    .rounded_md()
                                    .bg(rgb(0x60bc83)),
                            ),
                    );
            }
        }
        let mut footer = div().flex().gap_3();
        if self.connected
            && self.page == Page::Playlists
            && self.login.is_none()
            && self.choice.is_none()
        {
            let can_export = active
                && !self.selected.is_empty()
                && if self.direct {
                    self.selected_watch.is_some() && !self.scanning
                } else {
                    self.destination.is_some()
                };
            footer = footer.child(
                button(
                    "export",
                    if self.direct {
                        "Transfer to watch →"
                    } else {
                        "Export music →"
                    },
                    can_export,
                )
                .bg(rgb(if can_export { 0x21825a } else { 0x202621 }))
                .border_color(rgb(if can_export { 0x4caa78 } else { 0x38443d }))
                .on_click(cx.listener(|v, _, window, cx| {
                    v.create_files(window, cx);
                    cx.notify();
                })),
            );
        }
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
                        .child(format!("Watch transfer · {}", progress.phase)),
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
                        .text_color(rgb(0x91a69a))
                        .child("Rate counts verified MP3 bytes and updates after each track."),
                )
                .child(
                    div()
                        .h(px(8.))
                        .w_full()
                        .rounded_md()
                        .bg(rgb(0x263b2d))
                        .child(
                            div()
                                .h_full()
                                .w(relative(fraction))
                                .rounded_md()
                                .bg(rgb(0x60bc83)),
                        ),
                );
        }
        let navigation = div().flex().gap_2().children(
            [
                (Page::Playlists, "Playlists"),
                (Page::WatchMusic, "Watch music"),
                (Page::Settings, "Settings"),
            ]
            .into_iter()
            .enumerate()
            .map(|(index, (page, label))| {
                let selected = self.page == page;
                let enabled = active && (page != Page::WatchMusic || self.selected_watch.is_some());
                button(
                    ("page", index),
                    format!("{}{}", if selected { "✓ " } else { "" }, label),
                    enabled,
                )
                .bg(rgb(if selected { 0x24543b } else { 0x203027 }))
                .border_color(rgb(if selected { 0x60bc83 } else { 0x31443a }))
                .on_click(cx.listener(move |v, _, _, cx| {
                    if v.modal.is_none()
                        && !v.busy
                        && (page != Page::WatchMusic || v.selected_watch.is_some())
                    {
                        v.page = page;
                        if page == Page::WatchMusic {
                            v.inspect_watch_music();
                        }
                        cx.notify();
                    }
                }))
            }),
        );
        let mut shell = div()
            .size_full()
            .relative()
            .bg(rgb(0x101a15))
            .text_color(rgb(0xe7eee9))
            .font_family("DejaVu Sans")
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
                        .child(div().text_3xl().child("SyncAndRun"))
                        .child(
                            div()
                                .text_sm()
                                .text_color(rgb(0x9acdb1))
                                .child("PLEX → MP3 → GARMIN"),
                        ),
                ),
            )
            .child(navigation)
            .when(self.usb_enabled, |shell| shell.child(watch_card))
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
                self.status != "Ready to export."
                    && self.status != "Connect your Plex account to get started.",
                |shell| {
                    shell.child(
                        div()
                            .p_4()
                            .rounded_md()
                            .bg(rgb(0x1c2921))
                            .child(self.status.clone()),
                    )
                },
            )
            .child(footer);
        if let Some(modal) = &self.modal {
            let (title, detail, confirm): (&str, String, &str) = match modal {
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
                    "Replace watch music?",
                    format!("On {}, the app sends and checks your selected playlists first. It then deletes old music inside Music. This cannot be undone. Activities and Garmin files outside Music stay on the watch. If USB disconnects during deletion, some old music can remain.", watch.model),
                    "Replace watch music",
                ),
                Modal::RemoveMusic(watch, _, name) => (
                    "Remove this music?",
                    format!("Remove ‘{name}’ from Music on {}? This cannot be undone. Activities and Garmin files outside Music stay on the watch. If USB disconnects, part of the folder can remain.", watch.model),
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
                    .bg(rgba(0x07110bdc))
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
                            .child(div().text_color(rgb(0xa8cbb4)).child(detail))
                            .child(
                                div()
                                    .flex()
                                    .gap_3()
                                    .child(
                                        button("modal-confirm", confirm, true)
                                            .bg(rgb(0x21825a))
                                            .border_color(rgb(0x4caa78))
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
            eprintln!("Could not open the Linux window. Check the display and Vulkan driver.");
            cx.quit();
        }
        cx.activate(true);
    });
}
