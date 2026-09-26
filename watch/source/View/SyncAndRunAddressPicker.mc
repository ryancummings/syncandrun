using Toybox.Graphics;
using Toybox.Lang;
using Toybox.WatchUi;

module SyncAndRun {

	// Positions 0-11 are the twelve digits of the four IPv4 numbers, three
	// each. Position 12 is the review step. Positions 13-17 are the port digits,
	// reached only when the user asks to change the port.
	const ADDRESS_DIGITS = 12;
	const ADDRESS_REVIEW = 12;
	const ADDRESS_PORT_FIRST = 13;
	const ADDRESS_PORT_DIGITS = 5;
	const ADDRESS_DEFAULT_PORT = 80;
	const ADDRESS_SAVE = 1;

	// Server address entry for a home companion: http://a.b.c.d with an optional
	// port. Digit wheels match the pairing code picker, so both setup steps work
	// the same way. Names, HTTPS, and other forms stay under Settings > Advanced.
	class AddressPicker extends WatchUi.View {

		private var d_octets = [0, 0, 0, 0];
		private var d_port = ADDRESS_DEFAULT_PORT;
		private var d_position = 0;
		private var d_guided = false;

		function initialize(origin, guided) {
			View.initialize();
			d_guided = guided;
			for (var idx = 0; idx < 4; ++idx) { d_octets[idx] = Setup.DEFAULT_PREFIX[idx]; }
			prefill(origin);
		}

		// Resume a saved LAN address so a correction is one or two digits away.
		private function prefill(origin) {
			if (!(origin instanceof Lang.String) || (origin.length() < 8)
				|| !origin.substring(0, 7).equals("http://")) { return; }
			var authority = origin.substring(7, null);
			if (!CompanionOrigin.validIpv4Authority(authority)) { return; }
			var colon = authority.find(":");
			var host = authority;
			if (colon != null) {
				host = authority.substring(0, colon);
				d_port = authority.substring(colon + 1, null).toNumber();
			}
			for (var idx = 0; idx < 4; ++idx) {
				var dot = host.find(".");
				var part = dot == null ? host : host.substring(0, dot);
				d_octets[idx] = part.toNumber();
				if (dot != null) { host = host.substring(dot + 1, null); }
			}
		}

		function position() { return d_position; }

		function isReview() { return d_position == ADDRESS_REVIEW; }

		function isPort() { return d_position >= ADDRESS_PORT_FIRST; }

		function authority() {
			var text = d_octets[0].toString() + "." + d_octets[1].toString() + "."
				+ d_octets[2].toString() + "." + d_octets[3].toString();
			if (d_port != ADDRESS_DEFAULT_PORT) { text += ":" + d_port.toString(); }
			return text;
		}

		function origin() { return "http://" + authority(); }

		// Change the selected digit. A digit that would push its number past the
		// allowed maximum is skipped, so every shown address is valid.
		function adjust(delta) {
			if (isReview()) { return; }
			if (isPort()) {
				var place = ADDRESS_PORT_DIGITS - 1 - (d_position - ADDRESS_PORT_FIRST);
				d_port = stepDigit(d_port, place, delta, 65535);
			} else {
				var octet = d_position / 3;
				d_octets[octet] = stepDigit(d_octets[octet], 2 - (d_position % 3), delta, 255);
			}
			WatchUi.requestUpdate();
		}

		private function stepDigit(value, place, delta, maximum) {
			var unit = 1;
			for (var idx = 0; idx < place; ++idx) { unit *= 10; }
			var digit = (value / unit) % 10;
			var rest = value - (digit * unit);
			for (var attempt = 0; attempt < 10; ++attempt) {
				digit = (digit + delta + 10) % 10;
				if ((rest + (digit * unit)) <= maximum) { return rest + (digit * unit); }
			}
			return rest;
		}

		// Returns ADDRESS_SAVE when the review step is confirmed.
		function advance() {
			if (isReview()) { return ADDRESS_SAVE; }
			if (d_position == (ADDRESS_PORT_FIRST + ADDRESS_PORT_DIGITS - 1)) {
				if (d_port == 0) { d_port = ADDRESS_DEFAULT_PORT; }
				d_position = ADDRESS_REVIEW;
			} else {
				d_position += 1;
			}
			WatchUi.requestUpdate();
			return 0;
		}

		function editPort() {
			d_position = ADDRESS_PORT_FIRST;
			WatchUi.requestUpdate();
		}

		// Returns false at the first digit, which the delegate treats as leaving.
		function retreat() {
			if (d_position == 0) { return false; }
			d_position = (d_position == ADDRESS_PORT_FIRST) ? ADDRESS_REVIEW : d_position - 1;
			WatchUi.requestUpdate();
			return true;
		}

		function onUpdate(dc) {
			dc.setColor(Graphics.COLOR_BLACK, Graphics.COLOR_BLACK);
			dc.clear();
			var width = dc.getWidth();
			var height = dc.getHeight();
			var small = Graphics.FONT_XTINY;
			var smallHeight = dc.getFontHeight(small);

			dc.setColor(Graphics.COLOR_LT_GRAY, Graphics.COLOR_TRANSPARENT);
			dc.drawText(width / 2, height / 10, small,
				d_guided ? WatchUi.loadResource(Rez.Strings.Setup_step1) : "",
				Graphics.TEXT_JUSTIFY_CENTER);
			dc.setColor(Graphics.COLOR_WHITE, Graphics.COLOR_TRANSPARENT);
			dc.drawText(width / 2, (height / 10) + smallHeight, Graphics.FONT_TINY,
				WatchUi.loadResource(Rez.Strings.OriginEditor_title), Graphics.TEXT_JUSTIFY_CENTER);

			var hints;
			if (isReview()) {
				drawReview(dc, width, height);
				hints = [Rez.Strings.AddressPicker_save, Rez.Strings.AddressPicker_port];
			} else if (isPort()) {
				drawPort(dc, width, height);
				hints = [Rez.Strings.AddressPicker_change, Rez.Strings.AddressPicker_next];
			} else {
				drawAddress(dc, width, height);
				hints = [Rez.Strings.AddressPicker_change, Rez.Strings.AddressPicker_next];
			}

			dc.setColor(Graphics.COLOR_LT_GRAY, Graphics.COLOR_TRANSPARENT);
			var hintY = isReview() ? (height * 33) / 50 : (height * 31) / 50;
			for (var idx = 0; idx < hints.size(); ++idx) {
				dc.drawText(width / 2, hintY + (idx * smallHeight), small,
					WatchUi.loadResource(hints[idx]), Graphics.TEXT_JUSTIFY_CENTER);
			}
		}

		// The address with the number being edited shown as three digits and
		// the active digit underlined, like the pairing code.
		private function drawAddress(dc, width, height) {
			var font = Graphics.FONT_MEDIUM;
			var active = d_position / 3;
			var parts = [];
			for (var idx = 0; idx < 4; ++idx) {
				parts.add(idx == active ? d_octets[idx].format("%03d") : d_octets[idx].toString());
				if (idx < 3) { parts.add("."); }
			}
			var total = 0;
			for (var idx = 0; idx < parts.size(); ++idx) { total += dc.getTextWidthInPixels(parts[idx], font); }
			var x = (width - total) / 2;
			var y = (height * 4) / 10;
			var fontHeight = dc.getFontHeight(font);
			for (var idx = 0; idx < parts.size(); ++idx) {
				var isActive = (idx == (active * 2));
				dc.setColor(isActive ? Graphics.COLOR_WHITE : Graphics.COLOR_LT_GRAY, Graphics.COLOR_TRANSPARENT);
				dc.drawText(x, y, font, parts[idx], Graphics.TEXT_JUSTIFY_LEFT);
				if (isActive) {
					var digit = d_position % 3;
					var before = dc.getTextWidthInPixels(parts[idx].substring(0, digit), font);
					var glyph = dc.getTextWidthInPixels(parts[idx].substring(digit, digit + 1), font);
					dc.setColor(Graphics.COLOR_BLUE, Graphics.COLOR_TRANSPARENT);
					dc.fillRectangle(x + before, y + fontHeight, glyph, 3);
				}
				x += dc.getTextWidthInPixels(parts[idx], font);
			}
		}

		private function drawReview(dc, width, height) {
			dc.setColor(Graphics.COLOR_WHITE, Graphics.COLOR_TRANSPARENT);
			var y = (height * 7) / 20;
			dc.drawText(width / 2, y, Graphics.FONT_MEDIUM, authority(), Graphics.TEXT_JUSTIFY_CENTER);
			dc.setColor(Graphics.COLOR_LT_GRAY, Graphics.COLOR_TRANSPARENT);
			dc.drawText(width / 2, y + dc.getFontHeight(Graphics.FONT_MEDIUM),
				Graphics.FONT_XTINY, d_port == ADDRESS_DEFAULT_PORT
					? WatchUi.loadResource(Rez.Strings.AddressPicker_standardPort)
					: WatchUi.loadResource(Rez.Strings.AddressPicker_customPort),
				Graphics.TEXT_JUSTIFY_CENTER);
		}

		private function drawPort(dc, width, height) {
			var font = Graphics.FONT_MEDIUM;
			var text = d_port.format("%05d");
			var y = (height * 4) / 10;
			dc.setColor(Graphics.COLOR_LT_GRAY, Graphics.COLOR_TRANSPARENT);
			var label = WatchUi.loadResource(Rez.Strings.AddressPicker_portLabel);
			var labelWidth = dc.getTextWidthInPixels(label, font);
			var x = (width - labelWidth - dc.getTextWidthInPixels(text, font)) / 2;
			dc.drawText(x, y, font, label, Graphics.TEXT_JUSTIFY_LEFT);
			x += labelWidth;
			dc.setColor(Graphics.COLOR_WHITE, Graphics.COLOR_TRANSPARENT);
			dc.drawText(x, y, font, text, Graphics.TEXT_JUSTIFY_LEFT);
			var digit = d_position - ADDRESS_PORT_FIRST;
			var before = dc.getTextWidthInPixels(text.substring(0, digit), font);
			var glyph = dc.getTextWidthInPixels(text.substring(digit, digit + 1), font);
			dc.setColor(Graphics.COLOR_BLUE, Graphics.COLOR_TRANSPARENT);
			dc.fillRectangle(x + before, y + dc.getFontHeight(font), glyph, 3);
		}
	}

	class AddressPickerDelegate extends WatchUi.BehaviorDelegate {

		private var d_view;

		function initialize(view) {
			BehaviorDelegate.initialize();
			d_view = view;
		}

		function onPreviousPage() {
			if (d_view.isReview()) { d_view.editPort(); return true; }
			d_view.adjust(1);
			return true;
		}

		function onNextPage() {
			if (d_view.isReview()) { d_view.editPort(); return true; }
			d_view.adjust(-1);
			return true;
		}

		function onSelect() {
			if (d_view.advance() != ADDRESS_SAVE) { return true; }
			if (!CompanionOrigin.save(d_view.origin())) {
				WatchUi.pushView(new TextView(WatchUi.loadResource(Rez.Strings.CompanionOrigin_invalid)),
					null, WatchUi.SLIDE_IMMEDIATE);
				return true;
			}
			// Continue straight to the pairing code whenever it is still needed,
			// replacing this picker so Back returns to where setup began.
			if (Setup.stage() == Setup.NEEDS_CODE) {
				var view = new PairingPicker(true);
				WatchUi.switchToView(view, new PairingPickerDelegate(view), WatchUi.SLIDE_LEFT);
				return true;
			}
			WatchUi.switchToView(new TextView(WatchUi.loadResource(Rez.Strings.CompanionOrigin_savedToast)),
				null, WatchUi.SLIDE_IMMEDIATE);
			return true;
		}

		function onBack() {
			if (d_view.retreat()) { return true; }
			WatchUi.popView(WatchUi.SLIDE_RIGHT);
			return true;
		}
	}
}
