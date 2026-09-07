using Toybox.Graphics;
using Toybox.Lang;
using Toybox.WatchUi;

module SyncAndRun {

	const ORIGIN_EDITOR_CHARACTERS = "abcdefghijklmnopqrstuvwxyz0123456789.-:";
	const ORIGIN_EDITOR_SAVE = 1;
	const ORIGIN_EDITOR_CANCEL = 2;
	const ORIGIN_EDITOR_NO_ACTION = 0;
	const ORIGIN_EDITOR_SAVE_INDEX = 0;
	const ORIGIN_EDITOR_SCHEME_INDEX = 1;
	const ORIGIN_EDITOR_CANCEL_INDEX = 2;
	const ORIGIN_EDITOR_CHARACTER_OFFSET = 3;
	const ORIGIN_EDITOR_MAX_AUTHORITY_LENGTH = 245;

	// App-owned companion-origin editor. It deliberately avoids TextPicker and
	// Picker: both render device-specific confirmation UI. BehaviorDelegate
	// maps these four semantic actions onto buttons and touch gestures instead.
	class CompanionOriginEditor extends WatchUi.View {

		private var d_scheme = "https://";
		private var d_authority = "";
		private var d_selection = ORIGIN_EDITOR_CHARACTER_OFFSET;

		function initialize(value) {
			View.initialize();

			if (!(value instanceof Lang.String)) { return; }
			var candidate = value.toLower();
			if ((candidate.length() >= 8) && candidate.substring(0, 8).equals("https://")) {
				d_authority = candidate.substring(8, null);
			} else if ((candidate.length() >= 7) && candidate.substring(0, 7).equals("http://")) {
				d_scheme = "http://";
				d_authority = candidate.substring(7, null);
			} else {
				d_authority = candidate;
			}

			if (d_authority.length() > ORIGIN_EDITOR_MAX_AUTHORITY_LENGTH) {
				d_authority = d_authority.substring(0, ORIGIN_EDITOR_MAX_AUTHORITY_LENGTH);
			}
		}

		function selectionCount() {
			return ORIGIN_EDITOR_CHARACTER_OFFSET + ORIGIN_EDITOR_CHARACTERS.length();
		}

		function adjust(delta) {
			d_selection = (d_selection + delta + selectionCount()) % selectionCount();
			WatchUi.requestUpdate();
		}

		function selectCharacter(character) {
			if (!(character instanceof Lang.String) || (character.length() != 1)) { return false; }
			var index = ORIGIN_EDITOR_CHARACTERS.find(character);
			if (index == null) { return false; }
			d_selection = ORIGIN_EDITOR_CHARACTER_OFFSET + index;
			return true;
		}

		function selectAction(index) {
			if ((index < ORIGIN_EDITOR_SAVE_INDEX) || (index > ORIGIN_EDITOR_CANCEL_INDEX)) { return false; }
			d_selection = index;
			return true;
		}

		function appendCharacter(character) {
			if (!(character instanceof Lang.String) || (character.length() != 1)
				|| (ORIGIN_EDITOR_CHARACTERS.find(character) == null)
				|| (d_authority.length() >= ORIGIN_EDITOR_MAX_AUTHORITY_LENGTH)) { return false; }
			d_authority += character;
			WatchUi.requestUpdate();
			return true;
		}

		function removeCharacter() {
			if (d_authority.length() == 0) { return false; }
			d_authority = d_authority.substring(0, d_authority.length() - 1);
			WatchUi.requestUpdate();
			return true;
		}

		function toggleScheme() {
			d_scheme = d_scheme.equals("https://") ? "http://" : "https://";
			WatchUi.requestUpdate();
		}

		function authority() { return d_authority; }

		function scheme() { return d_scheme; }

		function candidate() { return d_scheme + d_authority; }

		function selectedLabel() {
			if (d_selection == ORIGIN_EDITOR_SAVE_INDEX) {
				return WatchUi.loadResource(Rez.Strings.OriginEditor_save);
			}
			if (d_selection == ORIGIN_EDITOR_SCHEME_INDEX) {
				return WatchUi.loadResource(d_scheme.equals("https://")
					? Rez.Strings.OriginEditor_useHttp
					: Rez.Strings.OriginEditor_useHttps);
			}
			if (d_selection == ORIGIN_EDITOR_CANCEL_INDEX) {
				return WatchUi.loadResource(Rez.Strings.OriginEditor_cancel);
			}
			var index = d_selection - ORIGIN_EDITOR_CHARACTER_OFFSET;
			return ORIGIN_EDITOR_CHARACTERS.substring(index, index + 1);
		}

		// Returns a non-zero action only when the delegate must leave or save.
		function activate() {
			if (d_selection == ORIGIN_EDITOR_SAVE_INDEX) { return ORIGIN_EDITOR_SAVE; }
			if (d_selection == ORIGIN_EDITOR_CANCEL_INDEX) { return ORIGIN_EDITOR_CANCEL; }
			if (d_selection == ORIGIN_EDITOR_SCHEME_INDEX) {
				toggleScheme();
				return ORIGIN_EDITOR_NO_ACTION;
			}
			appendCharacter(selectedLabel());
			return ORIGIN_EDITOR_NO_ACTION;
		}

		private function fittedAuthority(dc, maxWidth) {
			if (d_authority.length() == 0) {
				return WatchUi.loadResource(Rez.Strings.OriginEditor_empty);
			}
			var text = d_authority;
			while ((text.length() > 1)
				&& (dc.getTextWidthInPixels(".." + text, Graphics.FONT_XTINY) > maxWidth)) {
				text = text.substring(1, null);
			}
			return text.length() == d_authority.length() ? text : ".." + text;
		}

		function onUpdate(dc) {
			dc.setColor(Graphics.COLOR_BLACK, Graphics.COLOR_BLACK);
			dc.clear();

			var width = dc.getWidth();
			var height = dc.getHeight();
			var optionFont = Graphics.FONT_LARGE;
			var optionHeight = dc.getFontHeight(optionFont);

			dc.setColor(Graphics.COLOR_LT_GRAY, Graphics.COLOR_TRANSPARENT);
			dc.drawText(width / 2, height / 9, Graphics.FONT_XTINY,
				WatchUi.loadResource(Rez.Strings.OriginEditor_title), Graphics.TEXT_JUSTIFY_CENTER);
			dc.drawText(width / 2, height / 4, Graphics.FONT_XTINY,
				d_scheme, Graphics.TEXT_JUSTIFY_CENTER);
			dc.setColor(Graphics.COLOR_WHITE, Graphics.COLOR_TRANSPARENT);
			dc.drawText(width / 2, height / 3, Graphics.FONT_XTINY,
				fittedAuthority(dc, (width * 4) / 5), Graphics.TEXT_JUSTIFY_CENTER);

			dc.drawText(width / 2, (height / 2) - (optionHeight / 3), optionFont,
				selectedLabel(), Graphics.TEXT_JUSTIFY_CENTER);

			dc.setColor(Graphics.COLOR_LT_GRAY, Graphics.COLOR_TRANSPARENT);
			dc.drawText(width / 2, (height * 3) / 4, Graphics.FONT_XTINY,
				WatchUi.loadResource(Rez.Strings.OriginEditor_choose), Graphics.TEXT_JUSTIFY_CENTER);
			dc.drawText(width / 2, ((height * 3) / 4) + dc.getFontHeight(Graphics.FONT_XTINY),
				Graphics.FONT_XTINY, WatchUi.loadResource(Rez.Strings.OriginEditor_back),
				Graphics.TEXT_JUSTIFY_CENTER);
		}
	}

	class CompanionOriginEditorDelegate extends WatchUi.BehaviorDelegate {

		private var d_view;

		function initialize(view) {
			BehaviorDelegate.initialize();
			d_view = view;
		}

		function onPreviousPage() {
			d_view.adjust(1);
			return true;
		}

		function onNextPage() {
			d_view.adjust(-1);
			return true;
		}

		function onSelect() {
			var action = d_view.activate();
			if (action == ORIGIN_EDITOR_CANCEL) {
				WatchUi.popView(WatchUi.SLIDE_IMMEDIATE);
				return true;
			}
			if (action != ORIGIN_EDITOR_SAVE) { return true; }

			if (!CompanionOrigin.save(d_view.candidate())) {
				WatchUi.pushView(new TextView(WatchUi.loadResource(Rez.Strings.CompanionOrigin_invalid)),
					null, WatchUi.SLIDE_IMMEDIATE);
				return true;
			}
			WatchUi.switchToView(new TextView(WatchUi.loadResource(Rez.Strings.CompanionOrigin_saved)),
				null, WatchUi.SLIDE_IMMEDIATE);
			return true;
		}

		function onBack() {
			if (d_view.removeCharacter()) { return true; }
			WatchUi.popView(WatchUi.SLIDE_IMMEDIATE);
			return true;
		}
	}
}
