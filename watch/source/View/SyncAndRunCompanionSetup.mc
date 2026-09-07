using Toybox.Lang;
using Toybox.WatchUi;

module SyncAndRun {

	function companionAddress() {
		var origin = CompanionOrigin.current();
		return origin instanceof Lang.String ? origin : "Not set";
	}

	function companionOriginScheme(value) {
		var origin = CompanionOrigin.normalize(value);
		if ((origin instanceof Lang.String) && (origin.length() >= 7)
			&& origin.substring(0, 7).equals("http://")) { return "http://"; }
		return "https://";
	}

	function companionOriginAuthority(value) {
		var origin = CompanionOrigin.normalize(value);
		if (!(origin instanceof Lang.String)) { return ""; }
		var scheme = companionOriginScheme(origin);
		return origin.substring(scheme.length(), null);
	}

	function companionOriginPickerCandidate(text, scheme) {
		if (!(text instanceof Lang.String)) { return null; }
		if (text.find("://") != null) { return text; }
		return ((scheme instanceof Lang.String) && scheme.equals("http://") ? "http://" : "https://") + text;
	}

	// TextPicker dismisses itself after invoking this delegate. Do not push or
	// switch views here: affected Connect IQ firmware can pop the newly pushed
	// view instead of the picker, leaving the picker visible after confirmation.
	class CompanionOriginPickerDelegate extends WatchUi.TextPickerDelegate {

		private var d_scheme;

		function initialize(scheme) {
			TextPickerDelegate.initialize();
			d_scheme = scheme;
		}

		function onTextEntered(text, changed) {
			var saved = CompanionOrigin.save(companionOriginPickerCandidate(text, d_scheme));
			if (WatchUi has :showToast) {
				WatchUi.showToast(saved
					? Rez.Strings.CompanionOrigin_savedToast
					: Rez.Strings.CompanionOrigin_invalidToast, null);
			}
			return true;
		}

		function onCancel() { return true; }
	}

	class CompanionConnectionTest {

		private var d_view;

		function initialize() {
			d_view = new TextView(WatchUi.loadResource(Rez.Strings.CompanionTest_checking));
		}

		function start() {
			WatchUi.pushView(d_view, null, WatchUi.SLIDE_IMMEDIATE);
			(new Client()).health(method(:onResponse));
		}

		function onResponse(responseCode, data) {
			if ((responseCode == 200) && (data instanceof Lang.Dictionary)
				&& (data["status"] instanceof Lang.String) && data["status"].equals("ok")) {
				d_view.setText(WatchUi.loadResource(Rez.Strings.CompanionTest_ready) + "\n" + companionAddress());
				return;
			}
			if ((responseCode >= 200) && (responseCode < 600)) {
				d_view.setText(WatchUi.loadResource(Rez.Strings.CompanionTest_notReady));
				return;
			}
			d_view.setText(WatchUi.loadResource(Rez.Strings.CompanionTest_unreachable));
		}
	}
}
