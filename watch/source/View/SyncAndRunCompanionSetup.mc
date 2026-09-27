using Toybox.Application;
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

	// A playback-menu web request can travel through the phone, which may
	// reject home-LAN HTTP. Test through the same Wi-Fi sync context as pairing.
	module CompanionConnectionTest {
		const REQUEST_KEY = "syncandrun.connection_check_requested";
		const RESULT_KEY = "syncandrun.connection_check_result";
		const NOTICE_KEY = "syncandrun.connection_check_notice";

		function start() {
			Application.Storage.deleteValue(RESULT_KEY);
			Application.Storage.deleteValue(NOTICE_KEY);
			Application.Storage.setValue(REQUEST_KEY, true);
			Menu.Playback.onSyncNow();
		}

		function result() { return Application.Storage.getValue(RESULT_KEY); }

		function saveResult(value) {
			Application.Storage.setValue(RESULT_KEY, value);
			Application.Storage.setValue(NOTICE_KEY, value);
		}

		function pendingNotice() { return Application.Storage.getValue(NOTICE_KEY); }

		function acknowledgeNotice() { Application.Storage.deleteValue(NOTICE_KEY); }

		function clearResult() {
			Application.Storage.deleteValue(RESULT_KEY);
			acknowledgeNotice();
		}

		function requested() { return Application.Storage.getValue(REQUEST_KEY) == true; }

		function takeRequest() {
			var wasRequested = requested();
			Application.Storage.deleteValue(REQUEST_KEY);
			return wasRequested;
		}
	}

	class ConnectionResultDelegate extends WatchUi.BehaviorDelegate {
		function initialize() { BehaviorDelegate.initialize(); }

		function continueToMenu() {
			CompanionConnectionTest.acknowledgeNotice();
			var menu = new Menu.Playback();
			menu.load();
			WatchUi.switchToView(new Menu.MenuView(menu), menu.delegate(), WatchUi.SLIDE_IMMEDIATE);
		}

		function onSelect() { continueToMenu(); return true; }

		function onBack() { continueToMenu(); return true; }
	}
}
