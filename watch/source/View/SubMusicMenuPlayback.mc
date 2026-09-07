using Toybox.WatchUi;
using Toybox.Communications;
using Toybox.Media;
using SyncAndRun.Menu;

module SyncAndRun {
	module Menu {
		class Playback extends MenuBase {

			function initialize() {
				MenuBase.initialize(WatchUi.loadResource(Rez.Strings.confPlayback_Title), false);
			}

			function load() {
				if ($.debug) {
					System.println("Menu.Playback::load()");
				}
				return MenuBase.setItems([
					new Menu.PlaylistsLocal(WatchUi.loadResource(Rez.Strings.Playlists_label)),
					{
						LABEL => WatchUi.loadResource(Rez.Strings.confPlayback_PlayAll_label),
						SUBLABEL => null,
						METHOD => method(:onPlayAll),
					},
					{
						LABEL => WatchUi.loadResource(Rez.Strings.SyncNow_label),
						SUBLABEL => method(:syncStatusLabel),
						METHOD => method(:onSyncNow),
					},
					new Menu.Storage(),
					new Menu.Settings(),
				]);
			}

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
