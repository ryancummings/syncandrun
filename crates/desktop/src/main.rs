use anyhow::{Context as _, Result};
use gpui::{prelude::*, *};
use std::{
    collections::HashSet,
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
    time::Duration,
};
use syncandrun_core::{
    BITRATES,
    export::{self, Progress, Route},
    plex::{self, Login, PlaylistSummary, Plex, ServerChoice},
    profile::{self, Profile},
};

enum Event {
    Loaded {
        connected: bool,
        playlists: Vec<PlaylistSummary>,
        selected: Vec<String>,
    },
    ConnectionUnavailable(String),
    SignedIn(Login),
    Discovered(ServerChoice),
    Connected,
    Progress(Progress),
    Exported(PathBuf),
    BackedUp,
    Failed(String),
}
struct Desktop {
    profile: PathBuf,
    connected: bool,
    playlists: Vec<PlaylistSummary>,
    selected: HashSet<String>,
    login: Option<Arc<Login>>,
    choice: Option<Arc<ServerChoice>>,
    bitrate: u16,
    destination: Option<PathBuf>,
    output: Option<PathBuf>,
    status: String,
    busy: bool,
    cancel: Arc<AtomicBool>,
    sender: mpsc::Sender<Event>,
    receiver: mpsc::Receiver<Event>,
}
impl Drop for Desktop {
    fn drop(&mut self) {
        self.cancel.store(true, Ordering::Relaxed);
    }
}
impl Desktop {
    fn new(profile: PathBuf, cx: &mut Context<Self>) -> Self {
        let (sender, receiver) = mpsc::channel();
        let mut this = Self {
            profile,
            connected: false,
            playlists: vec![],
            selected: HashSet::new(),
            login: None,
            choice: None,
            bitrate: 192,
            destination: None,
            output: None,
            status: "Opening profile…".into(),
            busy: false,
            cancel: Arc::new(AtomicBool::new(false)),
            sender,
            receiver,
        };
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
                    Err(error) => return Ok(Event::ConnectionUnavailable(error.to_string())),
                }
            } else {
                vec![]
            };
            Ok(Event::Loaded {
                connected: connection.is_some(),
                playlists,
                selected: profile.selected_ids()?,
            })
        });
    }
    fn apply(&mut self, event: Event) {
        match event {
            Event::Progress(p) => { self.status = format!("Creating MP3 files · {} of {}",p.completed,p.expected); return; },
            Event::Loaded { connected,playlists,selected } => {
                self.connected = connected; self.playlists = playlists;
                self.selected = selected.into_iter().collect();
                self.status = if connected { "Choose playlists to take with you." } else { "Connect your Plex account to get started." }.into();
            },
            Event::SignedIn(login) => { self.login = Some(Arc::new(login)); self.choice = None; self.status = "Choose your Plex server.".into(); },
            Event::Discovered(choice) => { self.choice = Some(Arc::new(choice)); self.status = "Choose your music library.".into(); },
            Event::Connected => {
                self.login = None; self.choice = None; self.connected = true; self.busy = false; self.load(); return;
            },
            Event::Exported(path) => { self.output = Some(path); self.status = "Files ready. Copy the playlist folders into your watch’s Music folder using Files or another MTP app.".into(); },
            Event::BackedUp => self.status = "Backup complete. Keep the database and encryption secret together in this private folder.".into(),
            Event::ConnectionUnavailable(message) => {
                self.connected = true;
                self.status = format!("{message}. Your saved connection is intact. Use Refresh to retry.");
            },
            Event::Failed(message) => self.status = message,
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
                    "Choose save folder"
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
    fn create_files(&mut self) {
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
        self.job(
            "Refreshing the selected playlists…",
            move |path, cancel, sender| {
                let mut profile = Profile::open(path)?;
                let plex = Plex::new(&profile)?;
                let plan = plex.refresh(&mut profile, &ids, &cancel)?;
                let connection = profile.connection()?.context("Sign in to Plex first")?;
                let path = export::export(
                    &plan,
                    bitrate,
                    Route::Mtp,
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
            let mut list = div()
                .id("playlists")
                .flex()
                .flex_col()
                .gap_2()
                .h(px(210.))
                .overflow_y_scroll();
            if self.playlists.is_empty() {
                list = list.child("No audio playlists found. Create one in Plex, then refresh.");
            }
            for (i, p) in self.playlists.iter().enumerate() {
                let id = p.id.clone();
                let checked = self.selected.contains(&id);
                let selectable = p.track_count <= 10000;
                list = list.child(
                    button(
                        ("playlist", i),
                        format!(
                            "{}  {}   ·   {} tracks{}",
                            if checked { "☑" } else { "☐" },
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
                        }
                    })),
                );
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
                .child(list)
                .child(div().text_xl().child("2  MP3 quality · kbps"))
                .child(qualities)
                .child(div().text_color(rgb(0xa5b3aa)).child(format!(
                    "{} playlists · {} tracks · about {:.0} MB. Watch free space is not measured.",
                    selected.len(),
                    tracks,
                    estimate
                )))
                .child(div().text_xl().child("3  Save for MTP transfer"))
                .child(
                    div()
                        .flex()
                        .gap_3()
                        .items_center()
                        .child(
                            button("folder", "Choose folder", active)
                                .on_click(cx.listener(|v, _, _, cx| v.choose_folder(false, cx))),
                        )
                        .child(
                            self.destination
                                .as_ref()
                                .map(|p| p.display().to_string())
                                .unwrap_or_else(|| "Choose where to save your files".into()),
                        ),
                )
                .child(
                    button(
                        "export",
                        "Create music files",
                        active && !selected.is_empty() && self.destination.is_some(),
                    )
                    .on_click(cx.listener(|v, _, _, cx| {
                        v.create_files();
                        cx.notify();
                    })),
                );
        }
        let mut footer = div().flex().gap_3();
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
                                button("backup", "Back up profile", active)
                                    .on_click(cx.listener(|v, _, _, cx| v.choose_folder(true, cx))),
                            )
                            .child(button("account", "Plex account", active).on_click(
                                cx.listener(|v, _, _, cx| {
                                    v.sign_in();
                                    cx.notify();
                                }),
                            )),
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
