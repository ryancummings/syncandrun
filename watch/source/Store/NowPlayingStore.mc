using Toybox.Application;
using Toybox.Lang;

module SyncAndRun {
    module PlayableStore {

        const IDS = "syncandrun.playable.ids";
        const STATE = "syncandrun.playable.state";

        function get() {
            var stored = Application.Storage.getValue(STATE);
            var result = {};
            if (stored instanceof Lang.Dictionary) {
                var keys = stored.keys();
                for (var idx = 0; idx < keys.size(); ++idx) {
                    result[keys[idx]] = stored[keys[idx]];
                }
            }
            var ids = SyncAndRun.BoundedList.toArray(IDS);
            var types = [];
            for (var idx = 0; idx < ids.size(); ++idx) {
                types.add(Audio.SONG);
            }
            result["ids"] = ids;
            result["types"] = types;
            return result;
        }

        // these functions should be used only internally by IPlayable class
        function save(playable) {
            SyncAndRun.BoundedList.replace(IDS, playable.ids());
            var state = {
                "idcs" => playable.idcs(),
                "idx" => playable.songidx(),
                "shuffle" => playable.shuffle()
            };
            Application.Storage.setValue(STATE, state);
            return true;
        }

        function remove() {
            SyncAndRun.BoundedList.clear(IDS);
            Application.Storage.deleteValue(STATE);
            return true;
        }
    }
}
