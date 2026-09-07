using Toybox.Media;
using Toybox.WatchUi;

module SyncAndRun {
    module Menu {
        class PlaylistSettings extends MenuBase {
            private var d_playlist;
            private var d_id;

            function initialize(playlist) {
                MenuBase.initialize(playlist["name"], false);
                d_playlist = playlist;
                d_id = playlist["id"];
            }

            function load() {
                return MenuBase.setItems([
                    { LABEL => WatchUi.loadResource(Rez.Strings.Menu_PlayNow_label), SUBLABEL => null, METHOD => method(:onPlay) },
                    { LABEL => WatchUi.loadResource(Rez.Strings.Menu_PlayShuffle_label), SUBLABEL => null, METHOD => method(:onShuffle) },
                    new Menu.SongsLocal(WatchUi.loadResource(Rez.Strings.Songs_label), trackIds(), method(:onSongSelect))
                ]);
            }

            function trackIds() {
                var ids = [];
                var prefix = SyncAndRun.SyncStore.activePlaylistTracks(d_id);
                for (var idx = 0; idx < SyncAndRun.BoundedList.size(prefix); ++idx) {
                    ids.add(SyncAndRun.BoundedList.get(prefix, idx));
                }
                return ids;
            }

            function onPlay() {
                var playable = new SyncAndRun.IPlayable();
                playable.loadPlaylist(d_id, null);
                if (playable.size() > 0) { Media.startPlayback(null); }
            }

            function onShuffle() {
                var playable = new SyncAndRun.IPlayable();
                playable.loadPlaylist(d_id, null);
                playable.shuffleIdcs(true);
                if (playable.size() > 0) { Media.startPlayback(null); }
            }

            function onSongSelect(songId) {
                var playable = new SyncAndRun.IPlayable();
                playable.loadPlaylist(d_id, songId);
                if (playable.size() > 0) { Media.startPlayback(null); }
            }
        }
    }
}
