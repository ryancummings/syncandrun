using Toybox.Application;
using Toybox.Graphics;
using Toybox.Lang;
using Toybox.WatchUi;

module SyncAndRun {

	const PAIRING_CODE_KEY = "syncandrun.pairing_code";
	const PAIRING_CODE_LENGTH = 6;

	// The code may arrive from the on-watch picker or from the Connect IQ
	// application setting. The picker wins so an on-watch entry is never
	// shadowed by a stale value left in the phone-side setting.
	function pairingCode() {
		var code = Application.Storage.getValue(PAIRING_CODE_KEY);
		if (validPairingCode(code)) { return code; }
		code = Application.Properties.getValue("pairing_code");
		if (validPairingCode(code)) { return code; }
		return null;
	}

	function validPairingCode(code) {
		if (!(code instanceof Lang.String) || (code.length() != PAIRING_CODE_LENGTH)) { return false; }
		for (var idx = 0; idx < PAIRING_CODE_LENGTH; ++idx) {
			var digit = code.substring(idx, idx + 1).toNumber();
			if (!(digit instanceof Lang.Number)) { return false; }
		}
		return true;
	}

	function clearPairingCode() {
		Application.Storage.deleteValue(PAIRING_CODE_KEY);
		Application.Properties.setValue("pairing_code", "");
	}

	// Six independent digit wheels. Buttons drive it on every device, so the
	// view carries no touch-only dependency and needs no capability guard.
	class PairingPicker extends WatchUi.View {

		private var d_digits = [0, 0, 0, 0, 0, 0];
		private var d_index = 0;

		function initialize() {
			View.initialize();

			// Resume a partially entered code rather than restarting at zero.
			var existing = Application.Storage.getValue(PAIRING_CODE_KEY);
			if (!validPairingCode(existing)) { return; }
			for (var idx = 0; idx < PAIRING_CODE_LENGTH; ++idx) {
				d_digits[idx] = existing.substring(idx, idx + 1).toNumber();
			}
		}

		function onUpdate(dc) {
			dc.setColor(Graphics.COLOR_BLACK, Graphics.COLOR_BLACK);
			dc.clear();

			var width = dc.getWidth();
			var centerY = dc.getHeight() / 2;
			var font = Graphics.FONT_NUMBER_MILD;
			var digitHeight = dc.getFontHeight(font);

			dc.setColor(Graphics.COLOR_LT_GRAY, Graphics.COLOR_TRANSPARENT);
			dc.drawText(width / 2, centerY - digitHeight, Graphics.FONT_XTINY,
				WatchUi.loadResource(Rez.Strings.PairingCode), Graphics.TEXT_JUSTIFY_CENTER);

			var cell = width / (PAIRING_CODE_LENGTH + 1);
			var first = (width - (cell * (PAIRING_CODE_LENGTH - 1))) / 2;
			for (var idx = 0; idx < PAIRING_CODE_LENGTH; ++idx) {
				var x = first + (cell * idx);
				var active = (idx == d_index);
				dc.setColor(active ? Graphics.COLOR_WHITE : Graphics.COLOR_DK_GRAY, Graphics.COLOR_TRANSPARENT);
				dc.drawText(x, centerY - (digitHeight / 2), font,
					d_digits[idx].toString(), Graphics.TEXT_JUSTIFY_CENTER);
				if (active) {
					dc.fillRectangle(x - (cell / 3), centerY + (digitHeight / 2), (cell * 2) / 3, 3);
				}
			}

			dc.setColor(Graphics.COLOR_LT_GRAY, Graphics.COLOR_TRANSPARENT);
			dc.drawText(width / 2, centerY + digitHeight, Graphics.FONT_XTINY,
				WatchUi.loadResource((d_index == (PAIRING_CODE_LENGTH - 1))
					? Rez.Strings.PairingPicker_confirm
					: Rez.Strings.PairingPicker_hint),
				Graphics.TEXT_JUSTIFY_CENTER);
		}

		function adjust(delta) {
			d_digits[d_index] = (d_digits[d_index] + delta + 10) % 10;
			WatchUi.requestUpdate();
		}

		// Returns true once the last digit is confirmed.
		function advance() {
			if (d_index >= (PAIRING_CODE_LENGTH - 1)) { return true; }
			d_index += 1;
			WatchUi.requestUpdate();
			return false;
		}

		// Returns false when there is nowhere left to retreat to, which the
		// delegate treats as leaving the picker.
		function retreat() {
			if (d_index == 0) { return false; }
			d_index -= 1;
			WatchUi.requestUpdate();
			return true;
		}

		function code() {
			var text = "";
			for (var idx = 0; idx < PAIRING_CODE_LENGTH; ++idx) {
				text += d_digits[idx].toString();
			}
			return text;
		}
	}

	class PairingPickerDelegate extends WatchUi.BehaviorDelegate {

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
			if (!d_view.advance()) { return true; }

			// A saved code is a claim, not a pairing. The reconciler exchanges
			// it on the next sync and clears it once a token is stored.
			Application.Storage.setValue(PAIRING_CODE_KEY, d_view.code());

			// Replace rather than pop-then-push: the confirmation takes the
			// picker's place in one step, so Back returns to the menu the
			// picker was opened from whatever the stack depth is.
			WatchUi.switchToView(new TextView(WatchUi.loadResource(Rez.Strings.PairingPicker_saved)),
				null, WatchUi.SLIDE_IMMEDIATE);
			return true;
		}

		function onBack() {
			if (d_view.retreat()) { return true; }
			WatchUi.popView(WatchUi.SLIDE_IMMEDIATE);
			return true;
		}
	}
}
