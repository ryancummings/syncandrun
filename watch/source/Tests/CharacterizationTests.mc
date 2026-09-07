using Toybox.Application;
using Toybox.Test;

module CharacterizationTests {
    (:test)
    function readsFlatTrackMetadata(logger) {
        var id = "plex:track:fixture";
        Application.Storage.setValue(SyncAndRun.SyncStore.activeTrackKey(id), {
            "id" => id,
            "title" => "Fixture Title",
            "artist" => "Fixture Artist",
            "album" => "Fixture Album",
            "durationSeconds" => 241,
            "refId" => "content-ref-fixture",
            "refCount" => 2
        });
        var audio = new Audio(id, Audio.SONG);
        Test.assertEqual("Fixture Title", audio.title());
        Test.assertEqual("Fixture Artist", audio.artist());
        Test.assertEqual("Fixture Album", audio.album());
        Test.assertEqual(241, audio.time());
        Test.assertEqual("content-ref-fixture", audio.refId());
        Application.Storage.deleteValue(SyncAndRun.SyncStore.activeTrackKey(id));
        return true;
    }

    (:test)
    function preservesChunkedPlaylistOrder(logger) {
        var prefix = "syncandrun.test.playlist-order";
        SyncAndRun.BoundedList.clear(prefix);
        SyncAndRun.BoundedList.append(prefix, "track:three");
        SyncAndRun.BoundedList.append(prefix, "track:one");
        SyncAndRun.BoundedList.append(prefix, "track:two");
        Test.assertEqual("track:three", SyncAndRun.BoundedList.get(prefix, 0));
        Test.assertEqual("track:one", SyncAndRun.BoundedList.get(prefix, 1));
        Test.assertEqual("track:two", SyncAndRun.BoundedList.get(prefix, 2));
        var values = SyncAndRun.BoundedList.toArray(prefix);
        Test.assertEqual(3, values.size());
        Test.assertEqual("track:three", values[0]);
        Test.assertEqual("track:one", values[1]);
        Test.assertEqual("track:two", values[2]);
        SyncAndRun.BoundedList.replace(prefix, ["track:four", "track:five"]);
        values = SyncAndRun.BoundedList.toArray(prefix);
        Test.assertEqual(2, values.size());
        Test.assertEqual("track:four", values[0]);
        Test.assertEqual("track:five", values[1]);
        SyncAndRun.BoundedList.clear(prefix);
        return true;
    }

    (:test)
    function preservesPlayableOrdering(logger) {
        var playable = new SyncAndRun.Playable({
            "ids" => ["track:one", "track:two", "track:three"],
            "types" => [Audio.SONG, Audio.SONG, Audio.SONG],
            "idcs" => [2, 0, 1],
            "idx" => 0,
            "shuffle" => true
        });
        Test.assertEqual(3, playable.size());
        Test.assertEqual("track:three", playable.getSongId(0));
        Test.assertEqual("track:one", playable.getSongId(1));
        Test.assertEqual("track:two", playable.getSongId(2));
        Test.assert(playable.shuffle());
        return true;
    }

    (:test)
    function repairsInterruptedPlaybackQueueState(logger) {
        SyncAndRun.PlayableStore.remove();
        SyncAndRun.BoundedList.append(SyncAndRun.PlayableStore.IDS, "track:one");
        SyncAndRun.BoundedList.append(SyncAndRun.PlayableStore.IDS, "track:two");
        Application.Storage.setValue(SyncAndRun.PlayableStore.STATE, {
            "idcs" => [0],
            "idx" => 9,
            "shuffle" => true
        });
        var playable = new SyncAndRun.IPlayable();
        Test.assertEqual(2, playable.size());
        Test.assertEqual(2, playable.idcs().size());
        Test.assertEqual(0, playable.songidx());
        Test.assert(!playable.shuffle());
        SyncAndRun.PlayableStore.remove();
        return true;
    }

    (:test)
    function removesTracksDeletedByReconciliationFromQueue(logger) {
        var keepId = "track:keep";
        var removeId = "track:remove";
        Application.Storage.setValue(SyncAndRun.SyncStore.activeTrackKey(keepId), {
            "id" => keepId,
            "refId" => "ref:keep",
            "durationSeconds" => 1
        });
        Application.Storage.setValue(SyncAndRun.SyncStore.activeTrackKey(removeId), {
            "id" => removeId,
            "refId" => "ref:remove",
            "durationSeconds" => 1
        });
        var playable = new SyncAndRun.IPlayable();
        playable.loadSongIds([keepId, removeId]);
        Application.Storage.deleteValue(SyncAndRun.SyncStore.activeTrackKey(removeId));
        playable = new SyncAndRun.IPlayable();
        Test.assert(playable.removeRemoved());
        Test.assertEqual(1, playable.size());
        Test.assertEqual(keepId, playable.ids()[0]);
        SyncAndRun.PlayableStore.remove();
        Application.Storage.deleteValue(SyncAndRun.SyncStore.activeTrackKey(keepId));
        return true;
    }

    (:test)
    function mapsStableSyncErrorsToActions(logger) {
        var reconciler = new SyncAndRun.Reconciler(null, null);
        Test.assertEqual("Create a new pairing code.", reconciler.userMessage("PAIRING_CODE_EXPIRED"));
        Test.assertEqual("Reconnect Plex in the companion.", reconciler.userMessage("PLEX_TOKEN_INVALID"));
        Test.assertEqual("Refresh playlists in the companion.", reconciler.userMessage("TRACK_NOT_FOUND"));
        Test.assertEqual("Not enough watch storage.", reconciler.userMessage("STORAGE_INSUFFICIENT"));
        Test.assertEqual("Wait a moment, then sync again.", reconciler.userMessage("RATE_LIMITED"));
        return true;
    }
}
