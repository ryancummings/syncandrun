using Toybox.WatchUi;
using Toybox.Communications;
using Toybox.Application;
using Toybox.Lang;
using SyncAndRun.Menu;

module SyncAndRun {
	module Menu {
		class Settings extends MenuBase {

			function initialize() {
				MenuBase.initialize(WatchUi.loadResource(Rez.Strings.Settings_label), false);
			}

			function load() {
				if ($.debug) {
					System.println("Menu.Settings::load()");
				}
				return MenuBase.setItems([
					{
						LABEL => WatchUi.loadResource(Rez.Strings.CompanionServer_label),
						SUBLABEL => method(:companionServer),
						METHOD => method(:onEditCompanion),
					},
					{
						LABEL => WatchUi.loadResource(Rez.Strings.OriginEditor_advanced),
						SUBLABEL => WatchUi.loadResource(Rez.Strings.OriginEditor_advancedHint),
						METHOD => method(:onEditCompanionAdvanced),
					},
					{
						LABEL => WatchUi.loadResource(Rez.Strings.CompanionTest_label),
						SUBLABEL => method(:connectionStatus),
						METHOD => method(:onTestCompanion),
					},
					{
						LABEL => WatchUi.loadResource(Rez.Strings.PairWatch_label),
						SUBLABEL => method(:pairingState),
						METHOD => method(:onPairWatch),
					},
					{
						LABEL => WatchUi.loadResource(Rez.Strings.Profile_label),
						SUBLABEL => method(:profile),
						METHOD => "profile",
					},
					{
						LABEL => WatchUi.loadResource(Rez.Strings.AppName) + " " + WatchUi.loadResource(Rez.Strings.Version_label), 
						SUBLABEL => "1.0.0 / protocol 1",
						METHOD => "version",		// not used, null does not work
					},
					{
						LABEL => WatchUi.loadResource(Rez.Strings.License_label),
						SUBLABEL => "GPL-3.0; derived from SubMusic",
						METHOD => method(:showSource),
					},
					{
						LABEL => WatchUi.loadResource(Rez.Strings.Reset_label),
						SUBLABEL => WatchUi.loadResource(Rez.Strings.confSync_MoreInfo_RemoveAll_sublabel),
						METHOD => method(:onReset),
					},
				]);
			}

			function connectionStatus() {
				return (new SyncAndRun.Client()).validOrigin() ? "Ready to check" : "Address required";
			}

			function companionServer() {
				return SyncAndRun.companionAddress();
			}

			function onEditCompanion() {
				var origin = SyncAndRun.CompanionOrigin.current();
				if (!(origin instanceof Lang.String)) { origin = "https://"; }
				if (WatchUi has :TextPicker) {
					WatchUi.pushView(new WatchUi.TextPicker(SyncAndRun.companionOriginAuthority(origin)),
						new SyncAndRun.CompanionOriginPickerDelegate(SyncAndRun.companionOriginScheme(origin)),
						WatchUi.SLIDE_IMMEDIATE);
					return;
				}
				onEditCompanionAdvanced();
			}

			function onEditCompanionAdvanced() {
				var origin = SyncAndRun.CompanionOrigin.current();
				if (!(origin instanceof Lang.String)) { origin = "https://"; }
				var view = new SyncAndRun.CompanionOriginEditor(origin);
				WatchUi.pushView(view, new SyncAndRun.CompanionOriginEditorDelegate(view),
					WatchUi.SLIDE_IMMEDIATE);
			}

			function onTestCompanion() {
				if (!(new SyncAndRun.Client()).validOrigin()) {
					WatchUi.pushView(new TextView(WatchUi.loadResource(Rez.Strings.CompanionOrigin_required)),
						null, WatchUi.SLIDE_IMMEDIATE);
					return;
				}
				(new SyncAndRun.CompanionConnectionTest()).start();
			}

			function pairingState() {
				if (SyncAndRun.State.token() instanceof Lang.String) { return "Paired"; }
				return SyncAndRun.pairingCode() == null ? "Not paired" : "Code entered";
			}

			function onPairWatch() {
				var view = new SyncAndRun.PairingPicker();
				WatchUi.pushView(view, new SyncAndRun.PairingPickerDelegate(view), WatchUi.SLIDE_IMMEDIATE);
			}

			function profile() {
				var value = Application.Storage.getValue("syncandrun.profile");
				return value instanceof Lang.String ? value : "Not synchronized";
			}

			function showSource() {
				WatchUi.pushView(new TextView("GPL-3.0\ngithub.com/memen45/SubMusic\nSyncAndRun for Garmin source"), null, WatchUi.SLIDE_IMMEDIATE);
			}

			function onReset() { (new Menu.Storage()).onRemoveAll(); }
		}
	}
}
