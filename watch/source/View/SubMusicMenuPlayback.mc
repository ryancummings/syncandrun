using Toybox.WatchUi;
using Toybox.Communications;
using Toybox.Media;
using SyncAndRun.Menu;

module SyncAndRun {
	module Menu {
		// The home menu. Its items follow the watch's state, so a new watch
		// sees setup first and a paired watch sees its music first:
		//   not set up    -> Set up watch, How it works, Settings
		//   paired, empty -> Sync now, Settings
		//   has music     -> Playlists, Play All, Sync now, Storage, Settings
		class Playback extends MenuBase {

			private var d_layout = null;

			function initialize() {
				MenuBase.initialize(WatchUi.loadResource(Rez.Strings.confPlayback_Title), false);
			}

			static function layout() {
				if (!Setup.isReady()) { return 0; }
				return SyncAndRun.BoundedList.size(SyncAndRun.SyncStore.ACTIVE_TRACKS) > 0 ? 2 : 1;
			}

			// MenuView rebuilds the items when this changes, for example when
			// setup finishes or the first sync brings in music.
			function layoutKey() { return layout(); }

			function title() {
				return d_layout == 2 ? MenuBase.title() : WatchUi.loadResource(Rez.Strings.AppName);
			}

			function load() {
				if ($.debug) {
					System.println("Menu.Playback::load()");
				}
				d_layout = layout();
				var syncNow = {
					LABEL => WatchUi.loadResource(Rez.Strings.SyncNow_label),
					SUBLABEL => method(:syncStatusLabel),
					METHOD => method(:onSyncNow),
				};
				if (d_layout == 0) {
					return MenuBase.setItems([
						{
							LABEL => WatchUi.loadResource(Rez.Strings.Setup_label),
							SUBLABEL => method(:setupStep),
							METHOD => method(:onSetup),
						},
						{
							LABEL => WatchUi.loadResource(Rez.Strings.Setup_helpLabel),
							SUBLABEL => WatchUi.loadResource(Rez.Strings.Setup_helpHint),
							METHOD => method(:onHelp),
						},
						new Menu.Settings(),
					]);
				}
				if (d_layout == 1) {
					return MenuBase.setItems([syncNow, new Menu.Settings()]);
				}
				return MenuBase.setItems([
					new Menu.PlaylistsLocal(WatchUi.loadResource(Rez.Strings.Playlists_label)),
					{
						LABEL => WatchUi.loadResource(Rez.Strings.confPlayback_PlayAll_label),
						SUBLABEL => null,
						METHOD => method(:onPlayAll),
					},
					syncNow,
					new Menu.Storage(),
					new Menu.Settings(),
				]);
			}

			static function setupStep() { return Setup.stepLabel(); }

			static function onSetup() { Setup.start(); }

			static function onHelp() { Setup.showHelp(); }

			static function onSyncNow() {
				SyncAndRun.SyncLaunch.recordRequest();
				// Garmin must leave playback mode before it can relaunch this
				// provider in sync mode. Make that transition explicit when the
				// playback session belongs to SyncAndRun.
				Media.stopPlayback();
				if (Communications has :startSync2) {
					Communications.startSync2({ :message => SyncAndRun.SyncStatus.startMessage() });
				} else {
					Communications.startSync();
				}
			}

			static function syncStatusLabel() { return SyncAndRun.SyncStatus.label(); }

			// plays all songs
			static function onPlayAll() {
				var ids = SyncAndRun.BoundedList.toArray(SyncAndRun.SyncStore.ACTIVE_TRACKS);
				var iplayable = new SyncAndRun.IPlayable();
				iplayable.loadSongIds(ids);
				if (iplayable.size() > 0) { Media.startPlayback(null); }
			}

		}
	}
}
