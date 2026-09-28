//! Single-line native text entry for connection setup. Secrets are masked and
//! excluded from clipboard reads; values live only in the view until submitted.
use gpui::{prelude::*, *};
use std::ops::Range;

pub struct Input {
    focus: FocusHandle,
    value: String,
    secret: bool,
    selection: Range<usize>,
    marked: Option<Range<usize>>,
}
impl Input {
    pub fn new(secret: bool, cx: &mut Context<Self>) -> Self {
        Self {
            focus: cx.focus_handle(),
            value: String::new(),
            secret,
            selection: 0..0,
            marked: None,
        }
    }
    pub fn value(&self) -> &str {
        &self.value
    }
    pub fn clear(&mut self, cx: &mut Context<Self>) {
        self.value.clear();
        self.selection = 0..0;
        self.marked = None;
        cx.notify();
    }
    fn utf8(&self, offset: usize) -> usize {
        let mut units = 0;
        for (index, ch) in self.value.char_indices() {
            if units >= offset {
                return index;
            }
            units += ch.len_utf16();
        }
        self.value.len()
    }
    fn utf16(&self, index: usize) -> usize {
        self.value[..index].encode_utf16().count()
    }
    fn range_to_utf8(&self, range: Range<usize>) -> Range<usize> {
        self.utf8(range.start)..self.utf8(range.end)
    }
    fn to_utf16(&self, range: Range<usize>) -> Range<usize> {
        self.utf16(range.start)..self.utf16(range.end)
    }
    fn replace(&mut self, range: Range<usize>, text: &str, cx: &mut Context<Self>) {
        let text: String = text.chars().filter(|c| !c.is_control()).collect();
        self.value.replace_range(range.clone(), &text);
        let end = range.start + text.len();
        self.selection = end..end;
        self.marked = None;
        cx.notify();
    }
    fn key(&mut self, event: &KeyDownEvent, _: &mut Window, cx: &mut Context<Self>) {
        let modifiers = event.keystroke.modifiers;
        let command = modifiers.control || modifiers.platform;
        let key = event.keystroke.key.as_str();
        match (command, key) {
            (true, "a") => self.selection = 0..self.value.len(),
            (true, "v") => {
                if let Some(text) = cx.read_from_clipboard().and_then(|c| c.text()) {
                    self.replace(self.selection.clone(), &text, cx);
                }
            }
            (true, "c" | "x") => {
                if !self.secret && !self.selection.is_empty() {
                    cx.write_to_clipboard(ClipboardItem::new_string(
                        self.value[self.selection.clone()].to_owned(),
                    ));
                    if key == "x" {
                        self.replace(self.selection.clone(), "", cx);
                    }
                }
            }
            (false, "backspace" | "delete") => {
                let mut range = self.selection.clone();
                if range.is_empty() {
                    if key == "backspace" {
                        range.start = self.value[..range.start]
                            .char_indices()
                            .next_back()
                            .map(|(i, _)| i)
                            .unwrap_or(0);
                    } else {
                        range.end += self.value[range.end..]
                            .chars()
                            .next()
                            .map(char::len_utf8)
                            .unwrap_or(0);
                    }
                }
                self.replace(range, "", cx);
            }
            (false, "home" | "end" | "left" | "right") => {
                let position = match key {
                    "home" => 0,
                    "end" => self.value.len(),
                    "left" => {
                        if self.selection.is_empty() {
                            self.value[..self.selection.start]
                                .char_indices()
                                .next_back()
                                .map(|(i, _)| i)
                                .unwrap_or(0)
                        } else {
                            self.selection.start
                        }
                    }
                    _ => {
                        if self.selection.is_empty() {
                            self.selection.end
                                + self.value[self.selection.end..]
                                    .chars()
                                    .next()
                                    .map(char::len_utf8)
                                    .unwrap_or(0)
                        } else {
                            self.selection.end
                        }
                    }
                };
                self.selection = position..position;
            }
            _ => return,
        }
        cx.stop_propagation();
        cx.notify();
    }
}
impl Focusable for Input {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus.clone()
    }
}
impl EntityInputHandler for Input {
    fn text_for_range(
        &mut self,
        range: Range<usize>,
        actual: &mut Option<Range<usize>>,
        _: &mut Window,
        _: &mut Context<Self>,
    ) -> Option<String> {
        if self.secret {
            return None;
        }
        let range = self.range_to_utf8(range);
        *actual = Some(self.to_utf16(range.clone()));
        Some(self.value[range].to_owned())
    }
    fn selected_text_range(
        &mut self,
        _: bool,
        _: &mut Window,
        _: &mut Context<Self>,
    ) -> Option<UTF16Selection> {
        Some(UTF16Selection {
            range: self.to_utf16(self.selection.clone()),
            reversed: false,
        })
    }
    fn marked_text_range(&self, _: &mut Window, _: &mut Context<Self>) -> Option<Range<usize>> {
        self.marked.clone().map(|r| self.to_utf16(r))
    }
    fn unmark_text(&mut self, _: &mut Window, _: &mut Context<Self>) {
        self.marked = None;
    }
    fn replace_text_in_range(
        &mut self,
        range: Option<Range<usize>>,
        text: &str,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let range = range
            .map(|r| self.range_to_utf8(r))
            .or(self.marked.clone())
            .unwrap_or(self.selection.clone());
        self.replace(range, text, cx);
    }
    fn replace_and_mark_text_in_range(
        &mut self,
        range: Option<Range<usize>>,
        text: &str,
        selection: Option<Range<usize>>,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let range = range
            .map(|r| self.range_to_utf8(r))
            .or(self.marked.clone())
            .unwrap_or(self.selection.clone());
        let start = range.start;
        self.replace(range, text, cx);
        let end = self.selection.end;
        if start != end {
            self.marked = Some(start..end);
        }
        if let Some(selection) = selection {
            let base = self.utf16(start);
            self.selection = self.range_to_utf8(base + selection.start..base + selection.end);
        }
    }
    fn bounds_for_range(
        &mut self,
        _: Range<usize>,
        bounds: Bounds<Pixels>,
        _: &mut Window,
        _: &mut Context<Self>,
    ) -> Option<Bounds<Pixels>> {
        Some(bounds)
    }
    fn character_index_for_point(
        &mut self,
        _: Point<Pixels>,
        _: &mut Window,
        _: &mut Context<Self>,
    ) -> Option<usize> {
        None
    }
}
impl Render for Input {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let entity = cx.entity();
        div()
            .track_focus(&self.focus)
            .cursor(CursorStyle::IBeam)
            .border_1()
            .border_color(rgb(0x71634f))
            .rounded_md()
            .px_2()
            .py_1()
            .w_full()
            .overflow_hidden()
            .bg(rgb(0x171510))
            .text_color(rgb(0xf0e9dc))
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(|view, _, window, cx| {
                    window.focus(&view.focus);
                    view.selection = view.value.len()..view.value.len();
                    cx.notify();
                }),
            )
            .on_key_down(cx.listener(Self::key))
            .child(
                canvas(
                    |_, _, _| (),
                    move |bounds, (), window, cx| {
                        let input = entity.read(cx);
                        let display = if input.secret {
                            "•".repeat(input.value.chars().count())
                        } else {
                            input.value.clone()
                        };
                        let display_index = |index| {
                            if input.secret {
                                input.value[..index].chars().count() * '•'.len_utf8()
                            } else {
                                index
                            }
                        };
                        let selection = display_index(input.selection.start)
                            ..display_index(input.selection.end);
                        let focus = input.focus.clone();
                        let style = window.text_style();
                        let line = window.text_system().shape_line(
                            display.clone().into(),
                            style.font_size.to_pixels(window.rem_size()),
                            &[TextRun {
                                len: display.len(),
                                font: style.font(),
                                color: style.color,
                                background_color: None,
                                underline: None,
                                strikethrough: None,
                            }],
                            None,
                        );
                        let offset = (line.x_for_index(selection.end) - bounds.size.width + px(3.))
                            .max(px(0.));
                        let origin = point(bounds.left() - offset, bounds.top());
                        window.handle_input(
                            &focus,
                            ElementInputHandler::new(bounds, entity.clone()),
                            cx,
                        );
                        if focus.is_focused(window) {
                            let left = origin.x + line.x_for_index(selection.start);
                            let right = origin.x + line.x_for_index(selection.end);
                            window.paint_quad(fill(
                                Bounds::new(
                                    point(left, bounds.top()),
                                    size((right - left).max(px(2.)), bounds.size.height),
                                ),
                                rgba(if selection.is_empty() {
                                    0xe0a454ff
                                } else {
                                    0xe0a45455
                                }),
                            ));
                        }
                        let _ = line.paint(origin, window.line_height(), window, cx);
                    },
                )
                .w_full()
                .h(px(26.)),
            )
    }
}
