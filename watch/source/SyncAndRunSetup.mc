using Toybox.Application;
using Toybox.Lang;
using Toybox.WatchUi;

module SyncAndRun {
	// First-run guidance. A watch moves through these stages in order, and the
	// home menu and the Set up watch item both read the current one, so the
	// user is always offered exactly the next thing to do.
	module Setup {
		const NEEDS_ADDRESS = 0;
		const NEEDS_CODE = 1;
		const NEEDS_SYNC = 2;		// address and code saved, claim not yet exchanged
		const READY = 3;

		// The Server address picker assumes a home companion. Most home
		// routers hand out 192.168.x.y, so starting there saves the most presses.
		const DEFAULT_PREFIX = [192, 168, 1, 0];

		function stage() {
			if (State.token() instanceof Lang.String) { return READY; }
			if (!(CompanionOrigin.current() instanceof Lang.String)) { return NEEDS_ADDRESS; }
			if (pairingCode() == null) { return NEEDS_CODE; }
			return NEEDS_SYNC;
		}

		function isReady() { return stage() == READY; }

		function stepLabel() {
			var current = stage();
			if (current == NEEDS_ADDRESS) { return "Step 1 of 2: address"; }
			if (current == NEEDS_CODE) { return "Step 2 of 2: code"; }
			if (current == NEEDS_SYNC) { return "Code saved: pair now"; }
			return "Paired";
		}

		// Opens whichever step is next. Every step ends by opening the one after
		// it, so choosing Set up watch once walks through the whole setup.
		function start() {
			var current = stage();
			if (current == NEEDS_ADDRESS) { openAddress(true); return; }
			if (current == NEEDS_CODE) { openPairing(true); return; }
			syncToPair();
		}

		function openAddress(guided) {
			var view = new AddressPicker(CompanionOrigin.current(), guided);
			WatchUi.pushView(view, new AddressPickerDelegate(view), WatchUi.SLIDE_LEFT);
		}

		function openPairing(guided) {
			var view = new PairingPicker(guided);
			WatchUi.pushView(view, new PairingPickerDelegate(view), WatchUi.SLIDE_LEFT);
		}

		// Pairing is exchanged during a sync, which runs over Wi-Fi. Say so before
		// the system sync screen takes over, because that screen gives no context.
		function syncToPair() {
			WatchUi.pushView(new TextView(WatchUi.loadResource(Rez.Strings.Setup_pairing)),
				null, WatchUi.SLIDE_LEFT);
			Menu.Playback.onSyncNow();
		}

		function showHelp() {
			WatchUi.pushView(new TextView(WatchUi.loadResource(Rez.Strings.Setup_help)),
				null, WatchUi.SLIDE_LEFT);
		}
	}
}
