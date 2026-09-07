using Toybox.Application;
using Toybox.Lang;
using Toybox.WatchUi;

module SyncAndRun {
    module Menu {
        class PlaylistsLocal extends MenuBase {
            function initialize(title) { MenuBase.initialize(title, false); }

            function load() {
                var items = [];
                for (var idx = 0; idx < SyncAndRun.BoundedList.size(SyncAndRun.SyncStore.ACTIVE_PLAYLISTS); ++idx) {
                    var id = SyncAndRun.BoundedList.get(SyncAndRun.SyncStore.ACTIVE_PLAYLISTS, idx);
                    var playlist = Application.Storage.getValue(SyncAndRun.SyncStore.activePlaylistKey(id));
                    if (playlist instanceof Lang.Dictionary) { items.add(new Menu.PlaylistSettings(playlist)); }
                }
                return MenuBase.setItems(items);
            }
        }
    }
}
