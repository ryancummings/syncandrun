//! The sidebar workspace: music sources, pages and the Garmin device on the
//! left; the current page in the middle; transfer settings on the right.
use super::*;
use gpui_kit::assets::IconName;
use gpui_kit::component::{
    Disableable as _, Icon, Selectable as _, Sizable as _, StyledExt as _,
    button::{Button, ButtonCustomVariant, ButtonGroup, ButtonVariants as _},
    checkbox::Checkbox,
    dialog::Dialog,
    h_flex,
    input::Input,
    progress::Progress as ProgressBar,
    scroll::ScrollableElement as _,
    sidebar::{Sidebar, SidebarFooter, SidebarGroup, SidebarHeader, SidebarMenu, SidebarMenuItem},
    spinner::Spinner,
    v_flex,
};
use gpui_kit::prelude::FluentBuilder as _;

const BUSY_REASON: &str = "Finish the current operation or close the dialog first.";
const SOURCES: [Provider; 3] = [Provider::Plex, Provider::Jellyfin, Provider::Local];

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
fn estimate_mb(seconds: u64, bitrate: u16) -> f64 {
    seconds as f64 * bitrate as f64 * 1000.0 / 8.0 * 1.03 / 1_000_000.0
}
fn card(cx: &App) -> Div {
    v_flex()
        .gap_3()
        .p_5()
        .rounded(cx.theme().radius_lg)
        .border_1()
        .border_color(cx.theme().border)
        .bg(cx.theme().group_box)
}
/// A rounded, bordered box on the secondary surface.
fn inset(element: Div, cx: &App) -> Div {
    element
        .rounded(cx.theme().radius)
        .border_1()
        .border_color(cx.theme().border)
        .bg(cx.theme().secondary)
}
fn heading(text: impl Into<SharedString>) -> Div {
    div().text_xl().child(text.into())
}
fn muted(text: impl Into<SharedString>, cx: &App) -> Div {
    div()
        .text_sm()
        .text_color(cx.theme().muted_foreground)
        .child(text.into())
}
fn detail(label: &'static str, value: impl Into<SharedString>, cx: &App) -> Div {
    v_flex()
        .gap_0p5()
        .min_w_0()
        .child(muted(label, cx))
        .child(div().text_sm().truncate().child(value.into()))
}
fn stat(label: &'static str, value: String, cx: &App) -> Div {
    v_flex()
        .w(px(160.))
        .p_3()
        .rounded(cx.theme().radius)
        .bg(cx.theme().secondary)
        .child(div().text_2xl().child(value))
        .child(muted(label, cx))
}
/// One button of a segmented control; the chosen one takes the warm accent.
fn segment(
    id: impl Into<ElementId>,
    label: impl Into<SharedString>,
    selected: bool,
    disabled: bool,
    cx: &App,
) -> Button {
    let button = Button::new(id).label(label).flex_1().disabled(disabled);
    if selected {
        button.selected(true).custom(
            ButtonCustomVariant::new(cx)
                .color(cx.theme().sidebar_accent)
                .foreground(cx.theme().foreground)
                .hover(cx.theme().sidebar_accent)
                .active(cx.theme().sidebar_accent),
        )
    } else {
        button
    }
}
fn segmented(
    id: &'static str,
    options: impl IntoIterator<Item = (&'static str, bool)>,
    disabled: bool,
    cx: &App,
) -> ButtonGroup {
    ButtonGroup::new(id).small().w_full().children(
        options
            .into_iter()
            .enumerate()
            .map(|(index, (label, selected))| segment((id, index), label, selected, disabled, cx)),
    )
}

/// Builds the troubleshooting dialog from the view's live diagnostic state.
pub fn troubleshooting_dialog(dialog: Dialog, view: &WeakEntity<Desktop>, cx: &mut App) -> Dialog {
    let Some(entity) = view.upgrade() else {
        return dialog;
    };
    let close = view.clone();
    let desktop = entity.read(cx);
    let mut body = v_flex()
        .gap_3()
        .child("SyncAndRun is checking USB visibility, access, udev, competing MTP apps, and device discovery. It may run a time-limited MTP probe if needed.");
    if desktop.watch_diagnostic_running {
        body = body.child(
            h_flex()
                .gap_2()
                .p_3()
                .rounded(cx.theme().radius)
                .bg(cx.theme().secondary)
                .text_color(cx.theme().primary)
                .child(Spinner::new().color(cx.theme().primary))
                .child("Checking device connection…"),
        );
    } else if let Some(result) = &desktop.watch_diagnostics {
        let prompt = result.agent_prompt();
        let rerun = view.clone();
        let copy = view.clone();
        let copied = desktop.watch_prompt_copied;
        let code = |text: String, cx: &App| {
            div()
                .p_3()
                .rounded(cx.theme().radius)
                .bg(cx.theme().background)
                .font_family(cx.theme().mono_font_family.clone())
                .text_sm()
                .child(text)
        };
        body = body
            .child(div().text_lg().child("What the checks found"))
            .child(code(result.summary(), cx))
            .child(div().text_lg().child("What to do next"))
            .children(
                result
                    .steps()
                    .iter()
                    .enumerate()
                    .map(|(index, step)| div().child(format!("{}. {step}", index + 1))),
            )
            .child(
                h_flex().child(
                    Button::new("rerun-watch-checks")
                        .label("Run checks again")
                        .on_click(move |_, _, cx| {
                            let _ = rerun.update(cx, |view, cx| {
                                view.run_watch_diagnostics();
                                cx.notify();
                            });
                        }),
                ),
            )
            .child(div().text_lg().child("Ask an agent to fix this:"))
            .child(code(prompt.clone(), cx))
            .child(
                h_flex().child(
                    Button::new("copy-watch-agent-prompt")
                        .label(if copied { "Copied" } else { "Copy prompt" })
                        .on_click(move |_, _, cx| {
                            cx.write_to_clipboard(ClipboardItem::new_string(prompt.clone()));
                            let _ = copy.update(cx, |view, cx| {
                                view.watch_prompt_copied = true;
                                view.status = "Troubleshooting prompt copied.".into();
                                cx.notify();
                            });
                        }),
                ),
            );
    }
    dialog
        .title("Garmin device troubleshooting")
        .w(px(650.))
        .child(
            div()
                .id("watch-help-scroll")
                .max_h(px(520.))
                .overflow_y_scrollbar()
                .child(body),
        )
        .on_close(move |_, _, cx| {
            let _ = close.update(cx, |view, cx| {
                view.modal = None;
                cx.notify();
            });
        })
}

impl Desktop {
    fn folder_label(&self, empty: &str) -> String {
        match &self.destination {
            Some(path) if self.using_default_library => format!("{} (default)", path.display()),
            Some(path) => path.display().to_string(),
            None => empty.into(),
        }
    }
    fn selected_playlists(&self) -> Vec<&PlaylistSummary> {
        self.playlists
            .iter()
            .filter(|p| self.selected.contains(&p.id))
            .collect()
    }
    fn chosen_watch(&self) -> Option<&Watch> {
        self.watches
            .iter()
            .find(|w| Some(w.key()) == self.selected_watch)
    }
    fn open_page(&mut self, page: Page) {
        if self.modal.is_some() || (page == Page::WatchMusic && self.selected_watch.is_none()) {
            return;
        }
        self.page = page;
        self.watch_music_pending = false;
        if page == Page::WatchMusic {
            if self.busy {
                self.watch_music_pending = true;
            } else {
                self.inspect_watch_music();
            }
        }
    }

    fn render_sidebar(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let locked = self.busy || self.modal.is_some();
        let sources = SidebarMenu::new().children(SOURCES.map(|provider| {
            let index = source_index(provider);
            let current = self.provider == provider;
            let note = if current && self.source_loading {
                "Loading"
            } else if current && self.connected {
                "Connected"
            } else if self.saved_sources[index] == Some(true) {
                "Saved"
            } else {
                ""
            };
            let dot = if current && self.connected {
                cx.theme().success
            } else if note.is_empty() {
                cx.theme().border
            } else {
                cx.theme().muted_foreground
            };
            SidebarMenuItem::new(provider.label())
                .icon(Icon::new(match provider {
                    Provider::Plex => IconName::Globe,
                    Provider::Jellyfin => IconName::Network,
                    Provider::Local => IconName::FolderOpen,
                }))
                .active(current)
                .disable(locked)
                .suffix(move |_, cx| {
                    h_flex()
                        .gap_1p5()
                        .child(
                            div()
                                .text_xs()
                                .text_color(cx.theme().muted_foreground)
                                .child(note),
                        )
                        .child(div().size_2().rounded_full().bg(dot))
                })
                .on_click(cx.listener(move |view, _, window, cx| {
                    view.switch_provider(provider, window, cx);
                    cx.notify();
                }))
        }));
        let pages = SidebarMenu::new().children(
            [
                (Page::Playlists, "Playlists", IconName::Play),
                (Page::WatchMusic, "Device content", IconName::HardDrive),
                (Page::Settings, "Settings", IconName::Settings),
            ]
            .map(|(page, label, icon)| {
                SidebarMenuItem::new(label)
                    .icon(Icon::new(icon))
                    .active(self.page == page)
                    .disable(
                        self.modal.is_some()
                            || (page == Page::WatchMusic && self.selected_watch.is_none()),
                    )
                    .on_click(cx.listener(move |view, _, _, cx| {
                        view.open_page(page);
                        cx.notify();
                    }))
            }),
        );
        let mut sidebar = Sidebar::new("navigation")
            .w(px(250.))
            .header(
                SidebarHeader::new().child(
                    v_flex()
                        .gap_1()
                        .child(div().text_lg().font_bold().child("SYNCANDRUN"))
                        .child(
                            div()
                                .text_xs()
                                .font_family(cx.theme().mono_font_family.clone())
                                .text_color(cx.theme().primary)
                                .child(format!(
                                    "{} → MP3 → GARMIN",
                                    self.provider.label().to_uppercase()
                                )),
                        ),
                ),
            )
            .child(SidebarGroup::new("Music source").child(sources))
            .child(SidebarGroup::new("Library").child(pages));
        if self.usb_enabled {
            sidebar = sidebar.footer(SidebarFooter::new().child(self.render_device_card(cx)));
        }
        sidebar
    }

    fn render_device_card(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let active = !self.busy && self.modal.is_none();
        let chosen = self.chosen_watch();
        let mut card = v_flex()
            .w_full()
            .gap_2()
            .p_3()
            .map(|this| inset(this, cx))
            .child(
                h_flex()
                    .gap_2()
                    .child(div().size_2().rounded_full().bg(if chosen.is_some() {
                        cx.theme().success
                    } else {
                        cx.theme().muted_foreground
                    }))
                    .child(
                        div()
                            .text_sm()
                            .font_semibold()
                            .truncate()
                            .child(chosen.map_or("Garmin device".into(), |w| w.model.clone())),
                    ),
            );
        if let Some(watch) = chosen {
            let used = watch.total_bytes.saturating_sub(watch.free_bytes);
            card = card
                .child(
                    ProgressBar::new("watch-space")
                        .value(used as f32 * 100. / watch.total_bytes.max(1) as f32)
                        .accessibility_label("Used space on the device"),
                )
                .child(muted(
                    format!(
                        "{:.2} GB free of {:.2} GB · firmware {}",
                        watch.free_bytes as f64 / 1e9,
                        watch.total_bytes as f64 / 1e9,
                        watch.firmware
                    ),
                    cx,
                ));
        } else if self.watches.is_empty() {
            card = card
                .child(ProgressBar::new("watch-wait").loading(true))
                .child(
                    div()
                        .text_xs()
                        .text_color(cx.theme().primary)
                        .child("Waiting for a Garmin device · checking automatically"),
                );
        }
        if self.watches.len() > 1 || chosen.is_none() {
            for watch in &self.watches {
                let key = watch.key();
                card = card.child(
                    Button::new(SharedString::from(format!("watch-{key}")))
                        .label(watch.model.clone())
                        .small()
                        .outline()
                        .selected(Some(&key) == self.selected_watch.as_ref())
                        .disabled(!active)
                        .on_click(cx.listener(move |view, _, _, cx| {
                            if !view.busy {
                                view.selected_watch = Some(key.clone());
                                view.music_items.clear();
                                if view.page == Page::WatchMusic {
                                    view.inspect_watch_music();
                                }
                                cx.notify();
                            }
                        })),
                );
            }
        }
        card.child(muted(self.watch_status.clone(), cx).text_xs())
            .child(
                h_flex()
                    .gap_2()
                    .child(
                        Button::new("scan-watch")
                            .label("Scan again")
                            .small()
                            .flex_1()
                            .disabled(!active)
                            .tooltip(if active {
                                "Scan for device"
                            } else {
                                BUSY_REASON
                            })
                            .on_click(cx.listener(|view, _, _, cx| {
                                if !view.busy && !view.scanning {
                                    view.scan_watches();
                                    cx.notify();
                                }
                            })),
                    )
                    .child(
                        Button::new("watch-help")
                            .label("Troubleshoot")
                            .small()
                            .flex_1()
                            .disabled(self.modal.is_some() || self.exporting)
                            .on_click(cx.listener(|view, _, window, cx| {
                                if !view.exporting {
                                    view.open_modal(Modal::WatchTroubleshooting, window, cx);
                                }
                            })),
                    ),
            )
    }

    fn render_header(
        &self,
        title: impl Into<SharedString>,
        subtitle: impl Into<SharedString>,
        actions: impl IntoElement,
        cx: &App,
    ) -> Div {
        h_flex()
            .flex_wrap()
            .gap_3()
            .justify_between()
            .px_7()
            .pt_5()
            .pb_4()
            .border_b_1()
            .border_color(cx.theme().border)
            .child(
                v_flex()
                    .gap_1()
                    .child(div().text_2xl().child(title.into()))
                    .child(muted(subtitle, cx)),
            )
            .child(actions)
    }

    fn render_playlists(&self, compact: bool, cx: &mut Context<Self>) -> AnyElement {
        let active = !self.busy && self.modal.is_none();
        let filter = self.playlist_filter.read(cx).value().to_lowercase();
        let selected = self.selected_playlists();
        let mut rows = v_flex().id("playlists").w_full();
        rows = rows.child(
            h_flex()
                .px_5()
                .py_2()
                .gap_3()
                .text_xs()
                .text_color(cx.theme().muted_foreground)
                .border_b_1()
                .border_color(cx.theme().border)
                .child(div().w(px(24.)))
                .child(div().flex_1().child("PLAYLIST"))
                .child(div().w(px(80.)).text_right().child("TRACKS"))
                .child(div().w(px(90.)).text_right().child("SIZE")),
        );
        if self.playlists.is_empty() && !self.source_loading {
            rows = rows.child(div().p_5().child(format!(
                "No audio playlists found. Create one in {}, then refresh.",
                self.provider.label()
            )));
        }
        for playlist in self
            .playlists
            .iter()
            .filter(|p| filter.is_empty() || p.title.to_lowercase().contains(&filter))
        {
            let id = playlist.id.clone();
            let checked = self.selected.contains(&id);
            let selectable = playlist.track_count <= 10000;
            let reason = if !selectable {
                "This playlist exceeds the 10,000-track limit."
            } else {
                "Finish the current operation or close the dialog before changing playlists."
            };
            let toggle = cx.listener(move |view, _: &bool, _, cx| {
                if !view.busy && view.modal.is_none() && selectable {
                    if !view.selected.remove(&id) {
                        view.selected.insert(id.clone());
                    }
                    view.save_preferences();
                    cx.notify();
                }
            });
            rows = rows.child(
                h_flex()
                    .px_5()
                    .py_3()
                    .gap_3()
                    .text_sm()
                    .border_b_1()
                    .border_color(cx.theme().table_row_border)
                    .when(checked, |row| row.bg(cx.theme().list_active))
                    .child(
                        Checkbox::new(SharedString::from(format!("playlist-{}", playlist.id)))
                            .checked(checked)
                            .disabled(!(active && selectable))
                            .when(!(active && selectable), |checkbox| checkbox.tooltip(reason))
                            .accessibility_label(playlist.title.clone())
                            .on_change(toggle),
                    )
                    .child(div().flex_1().min_w_0().truncate().child(if selectable {
                        playlist.title.clone()
                    } else {
                        format!("{} · too large", playlist.title)
                    }))
                    .child(
                        div()
                            .w(px(80.))
                            .text_right()
                            .font_family(cx.theme().mono_font_family.clone())
                            .text_color(cx.theme().muted_foreground)
                            .child(playlist.track_count.to_string()),
                    )
                    .child(
                        div()
                            .w(px(90.))
                            .text_right()
                            .font_family(cx.theme().mono_font_family.clone())
                            .text_color(cx.theme().muted_foreground)
                            .child(format!(
                                "{:.1} MB",
                                estimate_mb(playlist.duration_seconds, self.bitrate)
                            )),
                    ),
            );
        }
        let header = self.render_header(
            "Your music",
            format!(
                "{} · {} playlists · {} selected",
                self.connection_status,
                self.playlists.len(),
                selected.len()
            ),
            h_flex()
                .gap_2()
                .child(
                    Input::new(&self.playlist_filter)
                        .small()
                        .w(px(200.))
                        .prefix(Icon::new(IconName::Search).small()),
                )
                .child(
                    Button::new("refresh")
                        .icon(IconName::RefreshCw)
                        .label(format!("Refresh from {}", self.provider.label()))
                        .small()
                        .disabled(!active)
                        .tooltip(if active {
                            "Reload playlists"
                        } else {
                            BUSY_REASON
                        })
                        .on_click(cx.listener(|view, _, _, cx| {
                            view.load();
                            cx.notify();
                        })),
                ),
            cx,
        );
        let table = div().id("playlist-scroll").flex_1().min_w_0().child(rows);
        let table = if compact {
            table.into_any_element()
        } else {
            table.overflow_y_scrollbar().into_any_element()
        };
        let aside = self.render_transfer_panel(compact, cx);
        let body = if compact {
            v_flex()
                .id("playlist-page")
                .flex_1()
                .min_h_0()
                .overflow_y_scrollbar()
                .child(table)
                .child(aside)
                .into_any_element()
        } else {
            h_flex()
                .flex_1()
                .min_h_0()
                .items_stretch()
                .child(table)
                .child(aside)
                .into_any_element()
        };
        v_flex()
            .size_full()
            .child(header)
            .child(body)
            .into_any_element()
    }

    fn render_transfer_panel(&self, compact: bool, cx: &mut Context<Self>) -> impl IntoElement {
        let active = !self.busy && self.modal.is_none();
        let selected = self.selected_playlists();
        let tracks: u64 = selected.iter().map(|p| p.track_count).sum();
        let seconds: u64 = selected.iter().map(|p| p.duration_seconds).sum();
        let can_export = active
            && !self.selected.is_empty()
            && if self.direct {
                self.selected_watch.is_some() && !self.scanning
            } else {
                self.destination.is_some()
            };
        let export_reason = if !active {
            BUSY_REASON
        } else if self.selected.is_empty() {
            "Choose at least one playlist first."
        } else if self.direct {
            "Connect and select a Garmin device first."
        } else {
            "Choose an export folder first."
        };
        let folder = self.folder_label("Choose a library folder");
        let bitrates = self.provider.bitrates();
        let mut panel = v_flex()
            .gap_5()
            .p_5()
            .bg(cx.theme().sidebar)
            .when(compact, |panel| {
                panel.w_full().border_t_1().border_color(cx.theme().border)
            })
            .when(!compact, |panel| {
                panel
                    .w(px(320.))
                    .flex_none()
                    .border_l_1()
                    .border_color(cx.theme().border)
            })
            .child(div().text_lg().child("Transfer"))
            .child(
                v_flex().gap_1p5().child(muted("Destination", cx)).child(
                    segmented(
                        "destination",
                        [("Device", self.direct), ("Folder", !self.direct)],
                        !active,
                        cx,
                    )
                    .on_click(cx.listener(
                        |view, clicks: &Vec<usize>, _, cx| {
                            if !view.busy && view.modal.is_none() {
                                view.direct = clicks.contains(&0);
                                view.output = None;
                                view.save_preferences();
                                cx.notify();
                            }
                        },
                    )),
                ),
            );
        if self.direct {
            panel = panel.child(
                v_flex()
                    .gap_1p5()
                    .child(muted("Music already on the device", cx))
                    .child(
                        segmented(
                            "device-mode",
                            [
                                ("Keep", !self.replace_watch_music),
                                ("Replace", self.replace_watch_music),
                            ],
                            !active,
                            cx,
                        )
                        .on_click(cx.listener(|view, clicks: &Vec<usize>, _, cx| {
                            view.replace_watch_music = clicks.contains(&1);
                            cx.notify();
                        })),
                    )
                    .child(muted(
                        if self.replace_watch_music {
                            "Replace sends and checks new music first. Then it deletes old music from the device’s Music folder. The device needs space for both copies until deletion ends."
                        } else {
                            "New playlists are added. Music already on the device stays."
                        },
                        cx,
                    )),
            );
        } else {
            panel = panel.child(
                v_flex()
                    .gap_1p5()
                    .child(
                        h_flex()
                            .justify_between()
                            .child(muted("Music library folder", cx))
                            .child(
                                Button::new("main-folder")
                                    .label("Change folder")
                                    .small()
                                    .disabled(!active)
                                    .on_click(cx.listener(|view, _, _, cx| view.choose_folder(cx))),
                            ),
                    )
                    .child(div().text_sm().child(folder)),
            );
        }
        panel = panel.child(
            v_flex()
                .gap_1p5()
                .child(
                    h_flex()
                        .justify_between()
                        .child(muted("MP3 quality", cx))
                        .child(div().text_sm().child(format!("{} kbps", self.bitrate))),
                )
                .child(
                    ButtonGroup::new("quality")
                        .xsmall()
                        .w_full()
                        .children(bitrates.iter().map(|bitrate| {
                            segment(
                                ("quality", *bitrate as usize),
                                bitrate.to_string(),
                                self.bitrate == *bitrate,
                                !active,
                                cx,
                            )
                        }))
                        .on_click(cx.listener(move |view, clicks: &Vec<usize>, _, cx| {
                            if let Some(bitrate) = clicks.first().and_then(|i| bitrates.get(*i))
                                && !view.busy
                            {
                                view.bitrate = *bitrate;
                                view.save_preferences();
                                cx.notify();
                            }
                        })),
                )
                .child(muted("192 kbps is a good balance of sound and size.", cx).text_xs()),
        );
        panel = panel.child(div().flex_1());
        if let Some(progress) = &self.watch_progress {
            panel = panel.child(self.render_watch_progress(progress, cx));
        } else if let Some(progress) = self.progress.as_ref().filter(|_| !self.direct) {
            panel = panel.child(self.render_export_progress(progress, cx));
        }
        panel
            .child(
                v_flex()
                    .gap_0p5()
                    .pt_4()
                    .border_t_1()
                    .border_color(cx.theme().border)
                    .child(format!("{} playlists · {} tracks", selected.len(), tracks))
                    .child(muted(
                        format!(
                            "About {:.0} MB at {} kbps",
                            estimate_mb(seconds, self.bitrate),
                            self.bitrate
                        ),
                        cx,
                    )),
            )
            .child(muted(
                if self.direct {
                    "Keep the device connected until the transfer finishes."
                } else {
                    "Copy the exported playlist folders into your device’s Music folder with an MTP app."
                },
                cx,
            ))
            .child(
                Button::new("export")
                    .primary()
                    .large()
                    .w_full()
                    .label(if self.direct {
                        "Transfer to device →"
                    } else {
                        "Export music →"
                    })
                    .disabled(!can_export)
                    .when(!can_export, |button| button.tooltip(export_reason))
                    .on_click(cx.listener(|view, _, window, cx| {
                        view.create_files(window, cx);
                        cx.notify();
                    })),
            )
    }

    fn render_watch_progress(
        &self,
        progress: &device::TransferProgress,
        cx: &App,
    ) -> impl IntoElement {
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
                        .saturating_sub(progress.tracks.completed)) as f64
                    / progress.tracks.completed as f64,
            ))
        };
        v_flex()
            .gap_2()
            .p_4()
            .map(|this| inset(this, cx))
            .child(
                h_flex()
                    .justify_between()
                    .child(
                        div()
                            .text_sm()
                            .child(format!("Device transfer · {}", progress.phase)),
                    )
                    .child(
                        div()
                            .text_sm()
                            .font_family(cx.theme().mono_font_family.clone())
                            .text_color(cx.theme().primary)
                            .child(format!(
                                "{} / {}",
                                progress.tracks.completed, progress.tracks.expected
                            )),
                    ),
            )
            .child(ProgressBar::new("watch-progress").value(fraction * 100.))
            .child(muted(
                format!(
                    "{} verified · about {} estimated",
                    data_size(progress.bytes),
                    data_size(progress.estimated_bytes)
                ),
                cx,
            ))
            .child(muted(
                format!(
                    "Rate: {rate} · Elapsed: {} · Time left: {eta}",
                    clock_time(elapsed)
                ),
                cx,
            ))
            .child(
                muted(
                    "Rate counts verified MP3 bytes and updates after each track.",
                    cx,
                )
                .text_xs(),
            )
    }

    fn render_export_progress(&self, progress: &Progress, cx: &App) -> impl IntoElement {
        let fraction = if progress.expected == 0 {
            1.
        } else {
            progress.completed as f32 / progress.expected as f32
        };
        let eta = self
            .export_started
            .and_then(|start| {
                (progress.completed > 0 && progress.completed < progress.expected).then(|| {
                    let remaining = start.elapsed().as_secs_f64()
                        * (progress.expected - progress.completed) as f64
                        / progress.completed as f64;
                    format!(
                        " · about {} min {} sec remaining",
                        (remaining / 60.) as u64,
                        (remaining as u64) % 60
                    )
                })
            })
            .unwrap_or_default();
        v_flex()
            .gap_2()
            .p_4()
            .map(|this| inset(this, cx))
            .child(div().text_sm().child(format!(
                "{} of {} tracks ({:.0}%){}",
                progress.completed,
                progress.expected,
                fraction * 100.,
                eta
            )))
            .child(ProgressBar::new("export-progress").value(fraction * 100.))
    }

    fn render_device_content(&self, cx: &mut Context<Self>) -> AnyElement {
        let active = !self.busy && self.modal.is_none();
        let mut list = v_flex().px_7().py_5().gap_2();
        for item in &self.music_items {
            let name = item.name.clone();
            let id = item.id;
            list = list.child(
                h_flex()
                    .gap_3()
                    .px_4()
                    .py_3()
                    .rounded(cx.theme().radius)
                    .border_1()
                    .border_color(cx.theme().border)
                    .bg(cx.theme().group_box)
                    .child(Icon::new(if item.folder {
                        IconName::Folder
                    } else {
                        IconName::File
                    }))
                    .child(div().flex_1().min_w_0().truncate().text_sm().child(format!(
                        "{} {}",
                        if item.folder { "Folder:" } else { "File:" },
                        name
                    )))
                    .child(
                        div()
                            .text_sm()
                            .font_family(cx.theme().mono_font_family.clone())
                            .text_color(cx.theme().muted_foreground)
                            .child(data_size(item.bytes)),
                    )
                    .child(
                        Button::new(SharedString::from(format!("remove-watch-item-{id}")))
                            .label("Remove…")
                            .small()
                            .danger()
                            .outline()
                            .disabled(!active)
                            .on_click(cx.listener(move |view, _, window, cx| {
                                if let Some(watch) = view.chosen_watch().cloned() {
                                    view.open_modal(
                                        Modal::RemoveMusic(watch, id, name.clone()),
                                        window,
                                        cx,
                                    );
                                }
                            })),
                    ),
            );
        }
        v_flex()
            .size_full()
            .child(self.render_header(
                "Device content",
                "See files and folders directly inside the device’s Music folder. Folder sizes include their contents. To add or replace music, open Playlists. Activities and Garmin files outside Music stay on the device.",
                Button::new("refresh-watch-music")
                    .icon(IconName::RefreshCw)
                    .label("Refresh device content")
                    .small()
                    .disabled(!active)
                    .on_click(cx.listener(|view, _, _, cx| {
                        view.inspect_watch_music();
                        cx.notify();
                    })),
                cx,
            ))
            .child(
                div()
                    .id("device-content")
                    .flex_1()
                    .min_h_0()
                    .overflow_y_scrollbar()
                    .child(list),
            )
            .into_any_element()
    }

    fn render_settings(&self, compact: bool, cx: &mut Context<Self>) -> AnyElement {
        let active = !self.busy && self.modal.is_none();
        let overview = self.overview.as_ref();
        let library_name = overview
            .and_then(|o| o.library_name.as_deref())
            .unwrap_or("Saved music library");
        let server_id = self.server.as_ref().map(|s| s.1.as_str()).unwrap_or("—");
        let library_id = self.server.as_ref().map(|s| s.2.as_str()).unwrap_or("—");
        let library_tracks = (if self.provider == Provider::Local {
            Some(self.playlists.iter().map(|p| p.track_count).sum())
        } else {
            overview.and_then(|o| o.library_tracks)
        })
        .map(|count| count.to_string())
        .unwrap_or_else(|| "—".into());
        let selected = self.selected_playlists();
        let selected_tracks: u64 = selected.iter().map(|p| p.track_count).sum();
        let server_card = if self.provider == Provider::Local {
            card(cx)
                .flex_1()
                .min_w_0()
                .child(heading("Local music folder"))
                .child(div().text_lg().child(library_name.to_owned()))
                .child(div().text_sm().child(self.connection_status.clone()))
                .child(div().text_sm().child(format!(
                    "{} playlist groups · {} tracks",
                    self.playlists.len(),
                    self.playlists.iter().map(|p| p.track_count).sum::<u64>()
                )))
                .child(
                    h_flex().child(
                        Button::new("change-local-folder")
                            .label("Change folder…")
                            .disabled(!active)
                            .on_click(cx.listener(|view, _, _, cx| {
                                view.choose_local_source(cx);
                                cx.notify();
                            })),
                    ),
                )
        } else {
            card(cx)
                .flex_1()
                .min_w_0()
                .child(heading(format!("{} server", self.provider.label())))
                .child(
                    div().text_lg().child(
                        overview
                            .and_then(|o| o.server_name.as_deref())
                            .unwrap_or("Saved music server")
                            .to_owned(),
                    ),
                )
                .child(
                    div()
                        .text_sm()
                        .text_color(if self.connected {
                            cx.theme().success
                        } else {
                            cx.theme().warning
                        })
                        .child(self.connection_status.clone()),
                )
                .child(detail(
                    "Address",
                    self.server
                        .as_ref()
                        .map(|s| s.0.clone())
                        .unwrap_or_else(|| "No server saved".into()),
                    cx,
                ))
                .child(detail("Server ID", server_id.to_owned(), cx))
                .child(muted(
                    format!(
                        "{} version · {}",
                        self.provider.label(),
                        overview
                            .and_then(|o| o.server_version.as_deref())
                            .unwrap_or("Unavailable")
                    ),
                    cx,
                ))
                .child(
                    h_flex().child(
                        Button::new("account")
                            .label("Connect or change account")
                            .disabled(!active)
                            .on_click(cx.listener(|view, _, _, cx| {
                                if view.modal.is_none() {
                                    if view.provider == Provider::Jellyfin {
                                        view.jellyfin_setup = true;
                                    } else {
                                        view.sign_in();
                                    }
                                    cx.notify();
                                }
                            })),
                    ),
                )
        };
        let library_card = card(cx)
            .flex_1()
            .min_w_0()
            .child(heading(format!("{} music library", self.provider.label())))
            .child(div().text_lg().child(library_name.to_owned()))
            .child(muted(format!("Library ID · {library_id}"), cx))
            .child(muted(
                format!(
                    "SyncAndRun reads playlists and tracks from {}. It does not change your music library.",
                    self.provider.label()
                ),
                cx,
            ))
            .child(
                h_flex()
                    .flex_wrap()
                    .gap_2()
                    .child(stat("Library tracks", library_tracks, cx))
                    .child(stat("Audio playlists", self.playlists.len().to_string(), cx))
                    .child(stat("Selected playlists", selected.len().to_string(), cx))
                    .child(stat("Selected tracks", selected_tracks.to_string(), cx)),
            );
        let folder = self.folder_label("No library folder selected");
        let has_exports = self
            .destination
            .as_ref()
            .is_some_and(|path| path.join(".syncandrun-files.json").exists());
        let management = card(cx)
            .child(heading("Export folder on this computer"))
            .child(div().child(folder))
            .child(muted("Each export creates a folder and playlist file for every selected playlist. Later exports update files made by SyncAndRun. They remove old files only if you did not change them. Your other files stay.", cx))
            .child(muted("After copying music to your device, you can clear unchanged files made by SyncAndRun. Changed and unrelated files stay.", cx))
            .child(
                h_flex()
                    .gap_2()
                    .child(
                        Button::new("folder")
                            .label("Change export folder")
                            .disabled(!active)
                            .on_click(cx.listener(|view, _, _, cx| view.choose_folder(cx))),
                    )
                    .when(has_exports, |row| {
                        row.child(
                            Button::new("purge")
                                .label("Clear exported music…")
                                .danger()
                                .outline()
                                .disabled(!active)
                                .on_click(cx.listener(|view, _, window, cx| {
                                    view.confirm_purge(window, cx)
                                })),
                        )
                    }),
            );
        let cards = if compact {
            v_flex()
        } else {
            h_flex().items_start()
        };
        v_flex()
            .size_full()
            .child(self.render_header("Settings", "Connection and library details.", div(), cx))
            .child(
                div()
                    .id("settings")
                    .flex_1()
                    .min_h_0()
                    .overflow_y_scrollbar()
                    .child(
                        v_flex()
                            .gap_4()
                            .px_7()
                            .py_5()
                            .child(cards.gap_4().child(server_card).child(library_card))
                            .child(management),
                    ),
            )
            .into_any_element()
    }

    /// Source setup screens: sign-in, server and library choice.
    fn render_setup(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        let active = !self.busy && self.modal.is_none();
        let mut content = card(cx).max_w(px(620.));
        if let Some(login) = self.jellyfin_login.clone() {
            content = content.child(heading(format!(
                "Choose a music library on {}",
                login.server_name
            )));
            if login.libraries.is_empty() {
                content = content.child("No music libraries are available to this Jellyfin account. Check library access on your server.");
            }
            for library in &login.libraries {
                let id = library.id.clone();
                let login = login.clone();
                content = content.child(
                    Button::new(SharedString::from(format!("jellyfin-library-{id}")))
                        .label(library.title.clone())
                        .disabled(!active)
                        .on_click(cx.listener(move |view, _, _, cx| {
                            let login = login.clone();
                            let id = id.clone();
                            view.job("Saving Jellyfin connection…", move |path, _, _| {
                                let mut profile = Profile::open(path)?;
                                Jellyfin::new(&profile)?.connect(&mut profile, &login, &id)?;
                                Ok(Event::Connected)
                            });
                            cx.notify();
                        })),
                );
            }
            content = content.child(
                h_flex().child(
                    Button::new("jellyfin-back")
                        .label("Back to sign in")
                        .ghost()
                        .disabled(!active)
                        .on_click(cx.listener(|view, _, _, cx| {
                            if !view.busy {
                                view.jellyfin_login = None;
                                view.jellyfin_setup = true;
                                cx.notify();
                            }
                        })),
                ),
            );
        } else if !self.connected && self.provider == Provider::Local {
            content = content
                .child(heading("Local music folder"))
                .child("Choose a folder containing MP3 or FLAC files. Each folder with tracks becomes a playlist.")
                .child(
                    h_flex().child(
                        Button::new("choose-local-source")
                            .primary()
                            .icon(IconName::FolderOpen)
                            .label("Choose music folder…")
                            .disabled(!active)
                            .on_click(cx.listener(|view, _, _, cx| {
                                view.choose_local_source(cx);
                                cx.notify();
                            })),
                    ),
                );
        } else if self.jellyfin_setup || (!self.connected && self.provider == Provider::Jellyfin) {
            let field = |label: &'static str, input: &Entity<InputState>| {
                v_flex()
                    .gap_1p5()
                    .child(div().text_sm().child(label))
                    .child(Input::new(input).disabled(!active))
            };
            content = content
                .child(heading("Connect Jellyfin"))
                .child(muted("Enter your Jellyfin server address and account. Use the full address, including a base path if your server has one.", cx))
                .child(
                    field("Server address (for example, http://192.168.1.20:8096)", &self.jellyfin_url).when_some(
                        self.jellyfin_url_error.clone(),
                        |field, error| {
                            field.child(div().text_sm().text_color(cx.theme().danger).child(error))
                        },
                    ),
                )
                .child(field("Username", &self.jellyfin_user))
                .child(field("Password", &self.jellyfin_password))
                .child(muted("The saved access token is encrypted in your local profile. Your password is not saved.", cx))
                .child(
                    h_flex().child(
                        Button::new("jellyfin-login")
                            .primary()
                            .label(if active { "Sign in to Jellyfin" } else { "Signing in…" })
                            .loading(self.busy)
                            .disabled(!active)
                            .on_click(cx.listener(|view, _, window, cx| {
                                view.jellyfin_sign_in(window, cx);
                                cx.notify();
                            })),
                    ),
                );
        } else if let Some(choice) = self.choice.clone() {
            content = content.child(heading("Choose a music library"));
            if choice.libraries.is_empty() {
                content =
                    content.child("This server has no music libraries. Choose another server.");
            }
            for library in &choice.libraries {
                let key = library.key.clone();
                let choice = choice.clone();
                let login = self.login.clone();
                content = content.child(
                    Button::new(SharedString::from(format!("library-{key}")))
                        .label(library.title.clone())
                        .disabled(!active)
                        .on_click(cx.listener(move |view, _, _, cx| {
                            if let Some(login) = login.clone() {
                                let choice = choice.clone();
                                let key = key.clone();
                                view.job("Saving Plex connection…", move |path, _, _| {
                                    let mut profile = Profile::open(path)?;
                                    Plex::new(&profile)?.connect(
                                        &mut profile,
                                        &login,
                                        &choice,
                                        &key,
                                    )?;
                                    Ok(Event::Connected)
                                });
                                cx.notify();
                            }
                        })),
                );
            }
            content = content.child(
                h_flex().child(
                    Button::new("back")
                        .label("Back to servers")
                        .ghost()
                        .disabled(!active)
                        .on_click(cx.listener(|view, _, _, cx| {
                            if !view.busy {
                                view.choice = None;
                                cx.notify();
                            }
                        })),
                ),
            );
        } else if let Some(login) = self.login.clone() {
            content = content.child(heading("Choose a Plex server"));
            for server in &login.servers {
                let server = server.clone();
                content = content.child(
                    Button::new(SharedString::from(format!("server-{}", server.name)))
                        .label(server.name.clone())
                        .disabled(!active)
                        .on_click(cx.listener(move |view, _, _, cx| {
                            let server = server.clone();
                            view.job("Finding music libraries…", move |path, cancel, _| {
                                let profile = Profile::open(path)?;
                                Ok(Event::Discovered(
                                    Plex::new(&profile)?.discover(&server, &cancel)?,
                                ))
                            });
                            cx.notify();
                        })),
                );
            }
        } else if !self.connected && self.page != Page::Settings {
            content = content.child(heading("Connect Plex")).child(
                h_flex().child(
                    Button::new("login")
                        .primary()
                        .label("Sign in with Plex →")
                        .disabled(!active)
                        .on_click(cx.listener(|view, _, _, cx| {
                            view.sign_in();
                            cx.notify();
                        })),
                ),
            );
        } else {
            return None;
        }
        Some(
            v_flex()
                .id("setup")
                .size_full()
                .overflow_y_scrollbar()
                .px_7()
                .py_6()
                .child(content)
                .into_any_element(),
        )
    }

    fn render_status_bar(&self, cx: &mut Context<Self>) -> Option<impl IntoElement> {
        let quiet = self.source_loading
            || self.status == "Ready to export."
            || self.status == "Connect a music account to get started."
            || self.status == "Choose a music source to get started.";
        if quiet && !self.busy && self.output.is_none() {
            return None;
        }
        Some(
            h_flex()
                .gap_3()
                .px_7()
                .py_3()
                .border_t_1()
                .border_color(if self.exporting {
                    cx.theme().primary
                } else {
                    cx.theme().border
                })
                .bg(cx.theme().sidebar)
                .when(self.busy, |bar| bar.child(Spinner::new().color(cx.theme().primary)))
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .text_sm()
                        .when(!quiet || self.busy, |text| text.child(self.status.clone())),
                )
                .when(self.busy, |bar| {
                    bar.child(
                        Button::new("cancel")
                            .label("Cancel")
                            .small()
                            .on_click(cx.listener(|view, _, _, cx| {
                                view.cancel.store(true, Ordering::Relaxed);
                                view.status = "Cancelling… Waiting for the current request and cleanup to finish.".into();
                                cx.notify();
                            })),
                    )
                })
                .when_some(self.output.clone(), |bar, path| {
                    bar.child(
                        Button::new("show")
                            .icon(IconName::FolderOpen)
                            .label("Open exported folder")
                            .small()
                            .on_click(move |_, _, cx| cx.reveal_path(&path)),
                    )
                }),
        )
    }
}

impl Render for Desktop {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        // A dialog closed without its own callbacks (for example by Escape)
        // must not leave the view locked.
        if self.modal.is_some() && !window.has_active_dialog(cx) {
            self.modal = None;
        }
        let width: f32 = window.bounds().size.width.into();
        let compact = width < 1100.;
        let page = if self.page == Page::WatchMusic {
            self.render_device_content(cx)
        } else if let Some(setup) = self.render_setup(cx) {
            setup
        } else if self.page == Page::Settings {
            self.render_settings(compact, cx)
        } else {
            self.render_playlists(compact, cx)
        };
        h_flex()
            .size_full()
            .items_stretch()
            .bg(cx.theme().background)
            .text_color(cx.theme().foreground)
            .font_family(cx.theme().font_family.clone())
            .child(self.render_sidebar(cx))
            .child(
                v_flex()
                    .flex_1()
                    .min_w_0()
                    .child(div().flex_1().min_h_0().child(page))
                    .children(self.render_status_bar(cx)),
            )
    }
}
