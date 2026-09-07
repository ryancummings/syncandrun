using Toybox.Application;
using Toybox.Lang;
using Toybox.WatchUi;

module SyncAndRun {
    module Menu {
        class SongsLocal extends MenuBase {
            private var d_ids;
            private var d_handler;

            function initialize(title, ids, handler) {
                MenuBase.initialize(title, false);
                d_ids = ids;
                d_handler = handler;
            }

            function load() {
                var items = [];
                for (var idx = 0; idx < d_ids.size(); ++idx) {
                    var id = d_ids[idx];
                    var track = Application.Storage.getValue(SyncAndRun.SyncStore.activeTrackKey(id));
                    if (!(track instanceof Lang.Dictionary) || (track["refId"] == null)) { continue; }
                    items.add({ LABEL => track["title"], SUBLABEL => track["artist"], METHOD => id });
                }
                return MenuBase.setItems(items);
            }

            function onSongSelect(item) {
                if (d_handler != null) { d_handler.invoke(item.getId()); }
            }

            function delegate() { return new MenuDelegate(method(:onSongSelect), null); }
        }
    }
}
