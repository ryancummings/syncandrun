using Toybox.Application;
using Toybox.Lang;
using Toybox.Media;
using Toybox.System;
using Toybox.Test;

module MemoryProfileTests {
    const RUNTIME_BUDGET = 419430;
    const TRACK_COUNT = 500;

    function revision(character) {
        var result = "";
        for (var idx = 0; idx < 64; ++idx) { result += character; }
        return result;
    }

    function track(index) {
        var id = "plex:track:memory:" + index.toString();
        return {
            "id" => id,
            "contentFingerprint" => revision("d"),
            "title" => "Memory profile track " + index.toString(),
            "artist" => "Fixture artist",
            "album" => "Fixture album",
            "durationSeconds" => 180,
            "downloadPath" => "/api/v1/watch/media/" + index.toString(),
            "artworkPath" => null
        };
    }

    function seedDesiredTracks() {
        SyncAndRun.SyncStore.clearDesiredRecords();
        var run = SyncAndRun.SyncStore.beginDesired(revision("e"));
        var playlist = {
            "id" => "plex:playlist:memory",
            "name" => "Memory profile playlist",
            "revision" => revision("f"),
            "trackCount" => TRACK_COUNT,
            "durationSeconds" => TRACK_COUNT * 180,
            "tracksPath" => "/api/v1/watch/playlists/memory/tracks"
        };
        SyncAndRun.SyncStore.startDesiredPlaylist(playlist);
        for (var idx = 0; idx < TRACK_COUNT; ++idx) {
            var record = SyncAndRun.SyncStore.upsertDesiredTrack(track(idx), run);
            SyncAndRun.SyncStore.appendDesiredPlaylistTrack(playlist["id"], record["id"]);
        }
        Test.assertEqual(TRACK_COUNT, SyncAndRun.BoundedList.size(SyncAndRun.SyncStore.DESIRED_TRACKS));
        Test.assertEqual(TRACK_COUNT, SyncAndRun.BoundedList.size(SyncAndRun.SyncStore.DESIRED_PENDING_AUDIO));
        Test.assertEqual(
            TRACK_COUNT,
            SyncAndRun.BoundedList.size(SyncAndRun.SyncStore.desiredPlaylistTracks(playlist["id"]))
        );
    }

    function sample(logger, label) {
        var stats = System.getSystemStats();
        logger.debug(
            "MEMORY_PROFILE " + label
            + " used=" + stats.usedMemory.toString()
            + " total=" + stats.totalMemory.toString()
        );
        return stats.usedMemory;
    }

    function cleanDesiredTracks() {
        SyncAndRun.SyncStore.clearDesiredRecords();
        Application.Storage.deleteValue(SyncAndRun.SyncStore.DESIRED_REVISION);
        Application.Storage.deleteValue(SyncAndRun.SyncStore.DESIRED_RUN);
    }

    (:test)
    function manifestTraversal(logger) {
        seedDesiredTracks();
        var used = sample(logger, "manifest-traversal-500-tracks");
        cleanDesiredTracks();
        Test.assert(used < RUNTIME_BUDGET);
        return true;
    }

    (:test)
    function audioDownloadCompletion(logger) {
        seedDesiredTracks();
        var lastId = "plex:track:memory:" + (TRACK_COUNT - 1).toString();
        var content = new Media.ContentRef("memory-profile-content", Media.CONTENT_TYPE_AUDIO);
        Test.assert(SyncAndRun.SyncStore.saveDesiredRef(lastId, content.getId()));
        Test.assertEqual(content.getId(), SyncAndRun.SyncStore.desiredTrack(lastId)["refId"]);
        var used = sample(logger, "audio-download-completion-500-tracks");
        Application.Storage.deleteValue(SyncAndRun.SyncStore.desiredTrackKey(lastId));
        cleanDesiredTracks();
        Test.assert(used < RUNTIME_BUDGET);
        return true;
    }

    (:test)
    function playbackStartup(logger) {
        var playlistId = "plex:playlist:startup";
        var prefix = SyncAndRun.SyncStore.activePlaylistTracks(playlistId);
        SyncAndRun.PlayableStore.remove();
        SyncAndRun.BoundedList.clear(prefix);
        for (var idx = 0; idx < TRACK_COUNT; ++idx) {
            var id = "plex:track:startup:" + idx.toString();
            Application.Storage.setValue(SyncAndRun.SyncStore.activeTrackKey(id), {
                "id" => id,
                "title" => "Startup track " + idx.toString(),
                "artist" => "Fixture artist",
                "album" => "Fixture album",
                "durationSeconds" => 180,
                "refId" => "startup-ref:" + idx.toString()
            });
            SyncAndRun.BoundedList.append(prefix, id);
        }
        var started = System.getTimer();
        var playable = new SyncAndRun.IPlayable();
        Test.assert(playable.loadPlaylist(playlistId, null));
        var elapsed = System.getTimer() - started;
        logger.debug("STARTUP_PROFILE playlist-500-tracks elapsed-ms=" + elapsed.toString());
        Test.assertEqual(TRACK_COUNT, playable.size());
        Test.assert(elapsed < 100);
        SyncAndRun.PlayableStore.remove();
        for (var idx = 0; idx < TRACK_COUNT; ++idx) {
            Application.Storage.deleteValue(SyncAndRun.SyncStore.activeTrackKey("plex:track:startup:" + idx.toString()));
        }
        SyncAndRun.BoundedList.clear(prefix);
        return true;
    }

    (:test)
    function reusedAudioPlanning(logger) {
        seedDesiredTracks();
        // A reused traversal leaves no download candidates. The individual
        // fingerprint/ref carry-forward is covered by BoundedStorageTests;
        // this profile guards the 500-item post-traversal planning path.
        SyncAndRun.BoundedList.clear(SyncAndRun.SyncStore.DESIRED_PENDING_AUDIO);
        SyncAndRun.SyncStore.finishDesiredTraversal();
        var started = System.getTimer();
        var reused = SyncAndRun.BoundedList.size(SyncAndRun.SyncStore.DESIRED_TRACKS)
            - SyncAndRun.SyncStatus.missingAudioCount();
        var planningMs = System.getTimer() - started;
        logger.debug(
            "SYNC_PROFILE reused-audio-500-tracks planning-ms=" + planningMs.toString()
        );
        Test.assertEqual(TRACK_COUNT, reused);
        Test.assertEqual(0, SyncAndRun.BoundedList.size(SyncAndRun.SyncStore.DESIRED_PENDING_AUDIO));
        Test.assert(planningMs < 100);
        cleanDesiredTracks();
        return true;
    }

    (:test)
    function reusedAudioReconciliation(logger) {
        seedDesiredTracks();
        var ids = SyncAndRun.BoundedList.toArray(SyncAndRun.SyncStore.DESIRED_TRACKS);
        SyncAndRun.BoundedList.replace(SyncAndRun.SyncStore.ACTIVE_TRACKS, ids);
        var started = System.getTimer();
        var obsolete = SyncAndRun.SyncStore.obsoleteTrackCount();
        var planningMs = System.getTimer() - started;
        logger.debug(
            "SYNC_PROFILE reused-reconciliation-500-tracks planning-ms=" + planningMs.toString()
        );
        Test.assertEqual(0, obsolete);
        Test.assert(planningMs < 100);
        SyncAndRun.BoundedList.clear(SyncAndRun.SyncStore.ACTIVE_TRACKS);
        cleanDesiredTracks();
        return true;
    }
}
