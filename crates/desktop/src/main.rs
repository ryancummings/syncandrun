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
    export::{self, Progress},
    plex::{self, Login, PlaylistSummary, Plex, ServerChoice},
    profile::{self, Profile},
};

enum Event {
    Loaded {
        connected: bool,
        playlists: Vec<PlaylistSummary>,
        selected: Vec<String>,
        server: Option<(String, String, String)>,
    },
    ConnectionUnavailable(String, (String, String, String)),
    SignedIn(Login),
    Discovered(ServerChoice),
    Connected,
    Progress(Progress),
    Exported(PathBuf),
    Purged(export::PurgeResult),
    BackedUp,
    PreferencesFailed(String),
    Failed(String),
}
#[derive(Default, Serialize, Deserialize)]
struct Preferences {
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
    connected: bool,
    playlists: Vec<PlaylistSummary>,
    selected: HashSet<String>,
    settings: bool,
    server: Option<(String, String, String)>,
    connection_status: String,
    login: Option<Arc<Login>>,
    choice: Option<Arc<ServerChoice>>,
    bitrate: u16,
    destination: Option<PathBuf>,
    using_default_library: bool,
    has_saved_selection: bool,
    output: Option<PathBuf>,
    status: String,
    progress: Option<Progress>,
    export_started: Option<Instant>,
    busy: bool,
    cancel: Arc<AtomicBool>,
    sender: mpsc::Sender<Event>,
    receiver: mpsc::Receiver<Event>,
    preference_sender: mpsc::Sender<Preferences>,
}
impl Drop for Desktop {
    fn drop(&mut self) {
        self.cancel.store(true, Ordering::Relaxed);
    }
}
impl Desktop {
    fn new(profile: PathBuf, cx: &mut Context<Self>) -> Self {
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
            connected: false,
            playlists: vec![],
            selected: HashSet::new(),
            settings: false,
            server: None,
            connection_status: "Checking…".into(),
            login: None,
            choice: None,
            bitrate: 192,
            destination: None,
            using_default_library: true,
            has_saved_selection: false,
            output: None,
            status: "Opening profile…".into(),
            progress: None,
            export_started: None,
            busy: false,
            cancel: Arc::new(AtomicBool::new(false)),
            sender,
            receiver,
            preference_sender,
        };
        let prefs = read_preferences(&this.profile);
        this.has_saved_selection = prefs.is_some();
        let prefs = prefs.unwrap_or_default();
        let chosen_library = chosen_library(&prefs);
        this.selected = prefs.selected.into_iter().collect();
        this.using_default_library = chosen_library.is_none();
        this.destination = chosen_library.or_else(default_library_path);
        this.bitrate = prefs
            .bitrate
            .filter(|b| BITRATES.contains(b))
            .unwrap_or(192);
        this.load();
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
            Ok(Event::Loaded {
                connected: connection.is_some(),
                playlists,
                selected: profile.selected_ids()?,
                server: connection.map(|c| (c.base_uri, c.server_id, c.library_id)),
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
            Event::Loaded { connected,playlists,selected,server } => {
                self.connected = connected; self.playlists = playlists;
                self.server = server;
                self.connection_status = if connected { "Connected and playlists loaded" } else { "No Plex account connected" }.into();
                if !self.has_saved_selection { self.selected = selected.into_iter().collect(); }
                self.status = if connected { "Choose playlists to take with you." } else { "Connect your Plex account to get started." }.into();
            },
            Event::SignedIn(login) => { self.login = Some(Arc::new(login)); self.choice = None; self.status = "Choose your Plex server.".into(); },
            Event::Discovered(choice) => { self.choice = Some(Arc::new(choice)); self.status = "Choose your music library.".into(); },
            Event::Connected => {
                self.login = None; self.choice = None; self.connected = true; self.busy = false; self.load(); return;
            },
            Event::Exported(path) => { self.output = Some(path); self.progress = None; self.status = "Files ready. Copy the playlist folders into your watch’s Music folder using Files or another MTP app.".into(); },
            Event::Purged(result) => {
                self.output = None;
                self.status = format!("Cleared {} generated files from the music library. {} modified files were preserved; unrelated files were untouched.", result.removed, result.preserved_modified);
            },
            Event::BackedUp => self.status = "Backup complete. Keep the database and encryption secret together in this private folder.".into(),
            Event::ConnectionUnavailable(message, server) => {
                self.connected = true;
                self.server = Some(server);
                self.connection_status = "Saved connection; Plex is unreachable".into();
                self.status = format!("{message}. Your saved connection is intact. Use Refresh to retry.");
            },
            Event::Failed(message) => { self.progress = None; self.status = message; },
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
    fn choose_folder(&mut self, backup: bool, cx: &mut Context<Self>) {
        if self.busy {
            return;
        }
        let prompt = cx.prompt_for_paths(PathPromptOptions {
            files: false,
            directories: true,
            multiple: false,
            prompt: Some(
                if backup {
                    "Choose backup folder"
                } else {
                    "Choose your SyncAndRun library folder"
                }
                .into(),
            ),
        });
        cx.spawn(async move |view, cx| {
            let result = prompt.await;
            let _ = view.update(cx, |view, cx| {
                match result {
                    Ok(Ok(Some(paths))) if !paths.is_empty() => {
                        let path = paths[0].clone();
                        if backup {
                            view.job("Backing up profile…", move |profile, _, _| {
                                Profile::open(profile)?.backup(&path)?;
                                Ok(Event::BackedUp)
                            });
                        } else {
                            view.destination = Some(path);
                            view.using_default_library = false;
                            view.save_preferences();
                        }
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
    fn create_files(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.busy {
            return;
        }
        if self.using_default_library && self.destination.as_ref().is_some_and(|p| !p.exists()) {
            let path = self.destination.as_ref().expect("default path").clone();
            let answer = window.prompt(
                PromptLevel::Info,
                "Create ~/Music/SyncAndRun?",
                Some("Export playlists there now?"),
                &["Create and export", "Cancel"],
                cx,
            );
            cx.spawn(async move |view, cx| {
                if answer.await.ok() == Some(0) {
                    let _ = view.update(cx, |view, cx| {
                        if !view.busy && view.destination.as_ref() == Some(&path) {
                            view.start_export(true);
                            cx.notify();
                        }
                    });
                }
            })
            .detach();
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
    fn confirm_purge(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.busy {
            return;
        }
        let Some(library) = self.destination.clone() else {
            return;
        };
        let answer = window.prompt(
            PromptLevel::Warning,
            "Clear library music?",
            Some("Other files stay in the library."),
            &["Clear music", "Cancel"],
            cx,
        );
        cx.spawn(async move |view, cx| {
            if answer.await.ok() == Some(0) {
                let _ = view.update(cx, |view, cx| {
                    if !view.busy && view.destination.as_ref() == Some(&library) {
                        view.job("Clearing generated music…", move |profile, _, _| {
                            let _profile_lock = Profile::open(profile)?;
                            Ok(Event::Purged(export::purge_library(&library)?))
                        });
                        cx.notify();
                    }
                });
            }
        })
        .detach();
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
impl Render for Desktop {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let active = !self.busy;
        let mut content = div().flex().flex_col().gap_3();
        if let Some(choice) = self.choice.clone() {
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
        } else if self.settings {
            content = content
                .child(div().text_2xl().child("Settings"))
                .child(div().text_xl().child("Plex account"))
                .child(self.connection_status.clone())
                .child(match &self.server {
                    Some((address, server, library)) => format!("Server address: {address}\nServer ID: {server}\nMusic library ID: {library}"),
                    None => "No server saved.".into(),
                })
                .child(button("account", "Connect or change Plex account", active).on_click(cx.listener(|v, _, _, cx| { v.sign_in(); cx.notify(); })))
                .child(div().text_xl().child("Music library folder"))
                .child(div().text_color(rgb(0xa5b3aa)).child("Create a SyncAndRun library folder wherever you want to stage music, then select it here. The app will use the home folder shown below if you leave this unchanged; it will ask before creating it on the first export."))
                .child(button("folder", "Choose library folder", active).on_click(cx.listener(|v, _, _, cx| v.choose_folder(false, cx))))
                .child(self.destination.as_ref().map(|p| format!("{}{}", p.display(), if self.using_default_library { " (default)" } else { "" })).unwrap_or_else(|| "No home folder found; choose a library folder".into()))
                .child(div().text_color(rgb(0xa5b3aa)).child("Playlist folders and .m3u8 files go directly into this library folder. Repeat exports update generated music and leave your other files alone."))
                .child(div().text_xl().child("Advanced"))
                .child(format!("MP3 bitrate: {} kbps · Transfer layout: MTP playlist folders · Profile: {}", self.bitrate, self.profile.display()))
                .child(button("backup", "Back up encrypted profile", active).on_click(cx.listener(|v, _, _, cx| v.choose_folder(true, cx))));
        } else if !self.connected {
            content = content.child(div().text_2xl().child("Your music. Ready for a run."))
                .child(div().text_color(rgb(0xa5b3aa)).child("Sign in to Plex, choose your playlists, and create MP3 files for your Garmin watch."))
                .child(button("login","Connect Plex",active).on_click(cx.listener(|view,_,_,cx| { view.sign_in(); cx.notify(); })));
        } else {
            let selected: Vec<_> = self
                .playlists
                .iter()
                .filter(|p| self.selected.contains(&p.id))
                .collect();
            let seconds: u64 = selected.iter().map(|p| p.duration_seconds).sum();
            let tracks: u64 = selected.iter().map(|p| p.track_count).sum();
            let estimate = seconds as f64 * self.bitrate as f64 * 1000.0 / 8.0 * 1.03 / 1_000_000.0;
            let mut available = div()
                .id("available-playlists")
                .flex()
                .flex_col()
                .gap_2()
                .h(px(120.))
                .overflow_y_scroll();
            let mut syncing = div()
                .id("syncing-playlists")
                .flex()
                .flex_col()
                .gap_2()
                .h(px(120.))
                .overflow_y_scroll();
            if self.playlists.is_empty() {
                available =
                    available.child("No audio playlists found. Create one in Plex, then refresh.");
            }
            for (i, p) in self.playlists.iter().enumerate() {
                let id = p.id.clone();
                let checked = self.selected.contains(&id);
                let selectable = p.track_count <= 10000;
                let item = button(
                    ("playlist", i),
                    format!(
                        "{}   ·   {} tracks{}",
                        p.title,
                        p.track_count,
                        if selectable { "" } else { " · too large" }
                    ),
                    active && selectable,
                )
                .on_click(cx.listener(move |v, _, _, cx| {
                    if !v.busy && selectable {
                        if !v.selected.remove(&id) {
                            v.selected.insert(id.clone());
                        }
                        cx.notify();
                        v.save_preferences();
                    }
                }));
                if checked {
                    syncing = syncing.child(item);
                } else {
                    available = available.child(item);
                }
            }
            if selected.is_empty() {
                syncing = syncing.child("Click an available playlist to add it here.");
            }
            let qualities = div()
                .flex()
                .gap_2()
                .children(BITRATES.into_iter().map(|bitrate| {
                    button(
                        ("quality", bitrate as usize),
                        format!(
                            "{}{}",
                            bitrate,
                            if self.bitrate == bitrate { " ✓" } else { "" }
                        ),
                        active,
                    )
                    .on_click(cx.listener(move |v, _, _, cx| {
                        if !v.busy {
                            v.bitrate = bitrate;
                            cx.notify();
                            v.save_preferences();
                        }
                    }))
                }));
            content = content
                .child(
                    div()
                        .flex()
                        .justify_between()
                        .items_center()
                        .child(div().text_xl().child("1  Choose playlists"))
                        .child(button("refresh", "Refresh", active).on_click(cx.listener(
                            |v, _, _, cx| {
                                v.load();
                                cx.notify();
                            },
                        ))),
                )
                .child(div().text_color(rgb(0x9acdb1)).child(format!("Available playlists · {}", self.playlists.len() - selected.len())))
                .child(available)
                .child(div().text_color(rgb(0x9acdb1)).child(format!("Syncing playlists · {}", selected.len())))
                .child(syncing)
                .child(div().text_xl().child("2  MP3 quality · kbps"))
                .child(qualities)
                .child(div().text_color(rgb(0xa5b3aa)).child(format!(
                    "{} playlists · {} tracks · about {:.0} MB. Watch free space is not measured.",
                    selected.len(),
                    tracks,
                    estimate
                )))
                .child(div().text_xl().child("3  Music library for MTP transfer"))
                .child(
                    div()
                        .flex()
                        .gap_3()
                        .items_center()
                        .child(button("main-folder", "Change library folder", active).on_click(cx.listener(|v, _, _, cx| v.choose_folder(false, cx))))
                        .child(
                            self.destination
                                .as_ref()
                                .map(|p| format!("{}{}", p.display(), if self.using_default_library { " (default)" } else { "" }))
                                .unwrap_or_else(|| "Choose a library folder".into()),
                        ),
                )
                .child(div().text_color(rgb(0xa5b3aa)).child("Create a SyncAndRun library folder anywhere and select it above. Playlist folders are staged directly inside it. The default home folder is created only after you confirm the first export."));
            if let Some(p) = &self.progress {
                let fraction = if p.expected == 0 {
                    1.0
                } else {
                    p.completed as f32 / p.expected as f32
                };
                let eta = self
                    .export_started
                    .and_then(|start| {
                        (p.completed > 0 && p.completed < p.expected).then(|| {
                            let remaining = start.elapsed().as_secs_f64()
                                * (p.expected - p.completed) as f64
                                / p.completed as f64;
                            format!(
                                " · about {} min {} sec remaining",
                                (remaining / 60.0) as u64,
                                (remaining as u64) % 60
                            )
                        })
                    })
                    .unwrap_or_default();
                content = content
                    .child(div().child(format!(
                        "Export progress: {} / {} tracks ({:.0}%){}",
                        p.completed,
                        p.expected,
                        fraction * 100.0,
                        eta
                    )))
                    .child(
                        div()
                            .h(px(12.))
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
        if self.connected && !self.settings && self.login.is_none() && self.choice.is_none() {
            footer = footer.child(
                button(
                    "export",
                    "Export selected playlists to MP3 →",
                    active && !self.selected.is_empty() && self.destination.is_some(),
                )
                .on_click(cx.listener(|v, _, window, cx| {
                    v.create_files(window, cx);
                    cx.notify();
                })),
            );
            footer = footer.child(
                button(
                    "purge",
                    "Clear library after transfer",
                    active
                        && self
                            .destination
                            .as_ref()
                            .is_some_and(|p| p.join(".syncandrun-files.json").exists()),
                )
                .on_click(cx.listener(|v, _, window, cx| v.confirm_purge(window, cx))),
            );
        }
        if self.busy {
            footer = footer.child(button("cancel", "Cancel", true).on_click(cx.listener(
                |v, _, _, cx| {
                    v.cancel.store(true, Ordering::Relaxed);
                    v.status =
                        "Cancelling… Waiting for the current network request to stop.".into();
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
        div()
            .size_full()
            .bg(rgb(0x101a15))
            .text_color(rgb(0xe7eee9))
            .font_family("DejaVu Sans")
            .p_8()
            .flex()
            .flex_col()
            .gap_5()
            .child(
                div()
                    .flex()
                    .justify_between()
                    .items_center()
                    .child(
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
                    )
                    .child(
                        div()
                            .flex()
                            .gap_2()
                            .child(
                                button("header-folder", "Library folder", active).on_click(
                                    cx.listener(|v, _, _, cx| v.choose_folder(false, cx)),
                                ),
                            )
                            .child(
                                button(
                                    "settings",
                                    if self.settings {
                                        "Back to playlists"
                                    } else {
                                        "Settings"
                                    },
                                    active,
                                )
                                .on_click(cx.listener(
                                    |v, _, _, cx| {
                                        v.settings = !v.settings;
                                        cx.notify();
                                    },
                                )),
                            ),
                    ),
            )
            .child(
                div()
                    .id("content")
                    .flex_1()
                    .overflow_y_scroll()
                    .child(content),
            )
            .child(
                div()
                    .p_4()
                    .rounded_md()
                    .bg(rgb(0x1c2921))
                    .child(self.status.clone()),
            )
            .child(footer)
    }
}
fn main() {
    let mut args = std::env::args_os().skip(1);
    let mut path = None;
    while let Some(arg) = args.next() {
        if arg == "--profile" {
            path = args.next().map(PathBuf::from);
            if path.is_none() {
                eprintln!("--profile needs a folder");
                std::process::exit(2);
            }
        } else if arg == "--help" || arg == "-h" {
            println!("syncandrun-desktop [--profile FOLDER]");
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
                |_, cx| cx.new(|cx| Desktop::new(path, cx)),
            )
            .is_err()
        {
            eprintln!("Could not open the Linux window. Check the display and Vulkan driver.");
            cx.quit();
        }
        cx.activate(true);
    });
}
