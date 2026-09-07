using Toybox.Application;
using Toybox.Lang;
using Toybox.Test;

module BoundedStorageTests {
    function clearFixtureDesired() {
        for (var idx = 0; idx < SyncAndRun.BoundedList.size(SyncAndRun.SyncStore.DESIRED_TRACKS); ++idx) {
            var id = SyncAndRun.BoundedList.get(SyncAndRun.SyncStore.DESIRED_TRACKS, idx);
            Application.Storage.deleteValue(SyncAndRun.SyncStore.desiredTrackKey(id));
        }
        for (var idx = 0; idx < SyncAndRun.BoundedList.size(SyncAndRun.SyncStore.DESIRED_PLAYLISTS); ++idx) {
            var id = SyncAndRun.BoundedList.get(SyncAndRun.SyncStore.DESIRED_PLAYLISTS, idx);
            SyncAndRun.BoundedList.clear(SyncAndRun.SyncStore.desiredPlaylistTracks(id));
            Application.Storage.deleteValue(SyncAndRun.SyncStore.desiredPlaylistKey(id));
        }
        SyncAndRun.BoundedList.clear(SyncAndRun.SyncStore.DESIRED_TRACKS);
        SyncAndRun.BoundedList.clear(SyncAndRun.SyncStore.DESIRED_PENDING_AUDIO);
        Application.Storage.deleteValue(SyncAndRun.SyncStore.DESIRED_PENDING_AUDIO_READY);
        SyncAndRun.BoundedList.clear(SyncAndRun.SyncStore.DESIRED_PLAYLISTS);
        SyncAndRun.SyncStore.clearDesiredArtworkRecords();
        Application.Storage.deleteValue(SyncAndRun.SyncStore.DESIRED_REVISION);
    }

    (:test)
    function storesListsAcrossEightKilobyteSafeChunks(logger) {
        var prefix = "syncandrun.test.bounded";
        SyncAndRun.BoundedList.clear(prefix);
        Test.assertEqual(0, SyncAndRun.BoundedList.size(prefix));
        for (var idx = 0; idx < 500; ++idx) {
            SyncAndRun.BoundedList.append(prefix, "plex:track:" + idx.toString());
        }
        Test.assertEqual(500, SyncAndRun.BoundedList.size(prefix));
        Test.assertEqual("plex:track:0", SyncAndRun.BoundedList.get(prefix, 0));
        Test.assertEqual("plex:track:10", SyncAndRun.BoundedList.get(prefix, 10));
        Test.assertEqual("plex:track:499", SyncAndRun.BoundedList.get(prefix, 499));
        Test.assert(SyncAndRun.BoundedList.contains(prefix, "plex:track:250"));
        Test.assert(!SyncAndRun.BoundedList.contains(prefix, "plex:track:missing"));
        SyncAndRun.BoundedList.clear(prefix);
        Test.assertEqual(0, SyncAndRun.BoundedList.size(prefix));
        return true;
    }

    (:test)
    function commitsSharedTracksOnlyAfterDesiredTraversal(logger) {
        clearFixtureDesired();
        var revision = ProtocolTests.REVISION;
        var run = SyncAndRun.SyncStore.beginDesired(revision);
        var firstPlaylist = ProtocolTests.playlist(1);
        var secondPlaylist = ProtocolTests.playlist(2);
        var shared = ProtocolTests.track(42);
        SyncAndRun.SyncStore.startDesiredPlaylist(firstPlaylist);
        SyncAndRun.SyncStore.upsertDesiredTrack(shared, run);
        SyncAndRun.SyncStore.appendDesiredPlaylistTrack(firstPlaylist["id"], shared["id"]);
        SyncAndRun.SyncStore.startDesiredPlaylist(secondPlaylist);
        var record = SyncAndRun.SyncStore.upsertDesiredTrack(shared, run);
        SyncAndRun.SyncStore.appendDesiredPlaylistTrack(secondPlaylist["id"], shared["id"]);
        Test.assertEqual(2, record["refCount"]);
        Test.assertEqual(1, SyncAndRun.BoundedList.size(SyncAndRun.SyncStore.DESIRED_TRACKS));
        Test.assertEqual(1, SyncAndRun.BoundedList.size(SyncAndRun.SyncStore.DESIRED_PENDING_AUDIO));
        Test.assert(Application.Storage.getValue(SyncAndRun.SyncStore.activeTrackKey(shared["id"])) == null);

        SyncAndRun.SyncStore.commitDesired(revision);
        var active = Application.Storage.getValue(SyncAndRun.SyncStore.activeTrackKey(shared["id"])) as Lang.Dictionary;
        Test.assertEqual(2, active["refCount"]);
        Test.assertEqual(2, SyncAndRun.BoundedList.size(SyncAndRun.SyncStore.ACTIVE_PLAYLISTS));
        Test.assertEqual(1, SyncAndRun.BoundedList.size(SyncAndRun.SyncStore.ACTIVE_TRACKS));

        Application.Storage.deleteValue(SyncAndRun.SyncStore.activeTrackKey(shared["id"]));
        Application.Storage.deleteValue(SyncAndRun.SyncStore.activePlaylistKey(firstPlaylist["id"]));
        Application.Storage.deleteValue(SyncAndRun.SyncStore.activePlaylistKey(secondPlaylist["id"]));
        SyncAndRun.BoundedList.clear(SyncAndRun.SyncStore.activePlaylistTracks(firstPlaylist["id"]));
        SyncAndRun.BoundedList.clear(SyncAndRun.SyncStore.activePlaylistTracks(secondPlaylist["id"]));
        SyncAndRun.BoundedList.clear(SyncAndRun.SyncStore.ACTIVE_PLAYLISTS);
        SyncAndRun.BoundedList.clear(SyncAndRun.SyncStore.ACTIVE_TRACKS);
        SyncAndRun.SyncStore.clearDesiredRecords();
        return true;
    }

    (:test)
    function removingAPlaylistReclaimsUniqueTracksButKeepsSharedTracks(logger) {
        clearFixtureDesired();
        var playlistA = ProtocolTests.playlist(301);
        var playlistB = ProtocolTests.playlist(302);
        var uniqueA = ProtocolTests.track(303);
        var shared = ProtocolTests.track(304);
        var uniqueB = ProtocolTests.track(305);

        var run1 = SyncAndRun.SyncStore.beginDesired("playlist-removal-fixture-revision-one");
        SyncAndRun.SyncStore.startDesiredPlaylist(playlistA);
        SyncAndRun.SyncStore.upsertDesiredTrack(uniqueA, run1);
        SyncAndRun.SyncStore.appendDesiredPlaylistTrack(playlistA["id"], uniqueA["id"]);
        SyncAndRun.SyncStore.upsertDesiredTrack(shared, run1);
        SyncAndRun.SyncStore.appendDesiredPlaylistTrack(playlistA["id"], shared["id"]);
        SyncAndRun.SyncStore.startDesiredPlaylist(playlistB);
        SyncAndRun.SyncStore.upsertDesiredTrack(shared, run1);
        SyncAndRun.SyncStore.appendDesiredPlaylistTrack(playlistB["id"], shared["id"]);
        SyncAndRun.SyncStore.upsertDesiredTrack(uniqueB, run1);
        SyncAndRun.SyncStore.appendDesiredPlaylistTrack(playlistB["id"], uniqueB["id"]);
        Test.assert(SyncAndRun.SyncStore.saveDesiredRef(uniqueA["id"], "ref-303"));
        Test.assert(SyncAndRun.SyncStore.saveDesiredRef(shared["id"], "ref-304"));
        Test.assert(SyncAndRun.SyncStore.saveDesiredRef(uniqueB["id"], "ref-305"));
        SyncAndRun.SyncStore.commitDesired("playlist-removal-fixture-revision-one");

        Test.assertEqual(2, SyncAndRun.BoundedList.size(SyncAndRun.SyncStore.ACTIVE_PLAYLISTS));
        Test.assertEqual(3, SyncAndRun.BoundedList.size(SyncAndRun.SyncStore.ACTIVE_TRACKS));
        var sharedBefore = Application.Storage.getValue(SyncAndRun.SyncStore.activeTrackKey(shared["id"])) as Lang.Dictionary;
        Test.assertEqual(2, sharedBefore["refCount"]);

        // Playlist B is deselected: only playlist A is traversed on the next sync.
        var run2 = SyncAndRun.SyncStore.beginDesired("playlist-removal-fixture-revision-two");
        SyncAndRun.SyncStore.startDesiredPlaylist(playlistA);
        SyncAndRun.SyncStore.upsertDesiredTrack(uniqueA, run2);
        SyncAndRun.SyncStore.appendDesiredPlaylistTrack(playlistA["id"], uniqueA["id"]);
        SyncAndRun.SyncStore.upsertDesiredTrack(shared, run2);
        SyncAndRun.SyncStore.appendDesiredPlaylistTrack(playlistA["id"], shared["id"]);
        SyncAndRun.SyncStore.commitDesired("playlist-removal-fixture-revision-two");

        Test.assertEqual(1, SyncAndRun.BoundedList.size(SyncAndRun.SyncStore.ACTIVE_PLAYLISTS));
        Test.assertEqual(2, SyncAndRun.BoundedList.size(SyncAndRun.SyncStore.ACTIVE_TRACKS));
        Test.assert(Application.Storage.getValue(SyncAndRun.SyncStore.activePlaylistKey(playlistB["id"])) == null);
        Test.assertEqual(0, SyncAndRun.BoundedList.size(SyncAndRun.SyncStore.activePlaylistTracks(playlistB["id"])));
        // The track unique to the removed playlist is gone...
        Test.assert(Application.Storage.getValue(SyncAndRun.SyncStore.activeTrackKey(uniqueB["id"])) == null);
        // ...but the track shared with the surviving playlist keeps its
        // existing content reference rather than being re-downloaded, and
        // its reference count drops to reflect only the surviving playlist.
        var sharedAfter = Application.Storage.getValue(SyncAndRun.SyncStore.activeTrackKey(shared["id"])) as Lang.Dictionary;
        Test.assertEqual("ref-304", sharedAfter["refId"]);
        Test.assertEqual(1, sharedAfter["refCount"]);
        var uniqueAAfter = Application.Storage.getValue(SyncAndRun.SyncStore.activeTrackKey(uniqueA["id"])) as Lang.Dictionary;
        Test.assertEqual("ref-303", uniqueAAfter["refId"]);

        Application.Storage.deleteValue(SyncAndRun.SyncStore.activeTrackKey(uniqueA["id"]));
        Application.Storage.deleteValue(SyncAndRun.SyncStore.activeTrackKey(shared["id"]));
        Application.Storage.deleteValue(SyncAndRun.SyncStore.activePlaylistKey(playlistA["id"]));
        SyncAndRun.BoundedList.clear(SyncAndRun.SyncStore.activePlaylistTracks(playlistA["id"]));
        SyncAndRun.BoundedList.clear(SyncAndRun.SyncStore.ACTIVE_PLAYLISTS);
        SyncAndRun.BoundedList.clear(SyncAndRun.SyncStore.ACTIVE_TRACKS);
        SyncAndRun.SyncStore.clearDesiredRecords();
        return true;
    }

    (:test)
    function addingAPlaylistPreservesExistingReferencesAndOnlyQueuesNewTracks(logger) {
        clearFixtureDesired();
        var playlistA = ProtocolTests.playlist(401);
        var trackA1 = ProtocolTests.track(402);
        var trackA2 = ProtocolTests.track(403);

        var run1 = SyncAndRun.SyncStore.beginDesired("playlist-addition-fixture-revision-one");
        SyncAndRun.SyncStore.startDesiredPlaylist(playlistA);
        SyncAndRun.SyncStore.upsertDesiredTrack(trackA1, run1);
        SyncAndRun.SyncStore.appendDesiredPlaylistTrack(playlistA["id"], trackA1["id"]);
        SyncAndRun.SyncStore.upsertDesiredTrack(trackA2, run1);
        SyncAndRun.SyncStore.appendDesiredPlaylistTrack(playlistA["id"], trackA2["id"]);
        Test.assert(SyncAndRun.SyncStore.saveDesiredRef(trackA1["id"], "ref-402"));
        Test.assert(SyncAndRun.SyncStore.saveDesiredRef(trackA2["id"], "ref-403"));
        SyncAndRun.SyncStore.commitDesired("playlist-addition-fixture-revision-one");

        // A second playlist is selected alongside the first.
        var playlistC = ProtocolTests.playlist(404);
        var trackNew = ProtocolTests.track(405);
        var run2 = SyncAndRun.SyncStore.beginDesired("playlist-addition-fixture-revision-two");
        SyncAndRun.SyncStore.startDesiredPlaylist(playlistA);
        SyncAndRun.SyncStore.upsertDesiredTrack(trackA1, run2);
        SyncAndRun.SyncStore.appendDesiredPlaylistTrack(playlistA["id"], trackA1["id"]);
        SyncAndRun.SyncStore.upsertDesiredTrack(trackA2, run2);
        SyncAndRun.SyncStore.appendDesiredPlaylistTrack(playlistA["id"], trackA2["id"]);
        SyncAndRun.SyncStore.startDesiredPlaylist(playlistC);
        SyncAndRun.SyncStore.upsertDesiredTrack(trackNew, run2);
        SyncAndRun.SyncStore.appendDesiredPlaylistTrack(playlistC["id"], trackNew["id"]);
        // Only the brand-new track needs a download; the untouched playlist's
        // tracks were already resolved to their existing content references.
        Test.assertEqual(1, SyncAndRun.BoundedList.size(SyncAndRun.SyncStore.DESIRED_PENDING_AUDIO));
        Test.assert(SyncAndRun.SyncStore.saveDesiredRef(trackNew["id"], "ref-405"));
        SyncAndRun.SyncStore.commitDesired("playlist-addition-fixture-revision-two");

        Test.assertEqual(2, SyncAndRun.BoundedList.size(SyncAndRun.SyncStore.ACTIVE_PLAYLISTS));
        Test.assertEqual(3, SyncAndRun.BoundedList.size(SyncAndRun.SyncStore.ACTIVE_TRACKS));
        var a1 = Application.Storage.getValue(SyncAndRun.SyncStore.activeTrackKey(trackA1["id"])) as Lang.Dictionary;
        var a2 = Application.Storage.getValue(SyncAndRun.SyncStore.activeTrackKey(trackA2["id"])) as Lang.Dictionary;
        var neu = Application.Storage.getValue(SyncAndRun.SyncStore.activeTrackKey(trackNew["id"])) as Lang.Dictionary;
        Test.assertEqual("ref-402", a1["refId"]);
        Test.assertEqual("ref-403", a2["refId"]);
        Test.assertEqual("ref-405", neu["refId"]);

        Application.Storage.deleteValue(SyncAndRun.SyncStore.activeTrackKey(trackA1["id"]));
        Application.Storage.deleteValue(SyncAndRun.SyncStore.activeTrackKey(trackA2["id"]));
        Application.Storage.deleteValue(SyncAndRun.SyncStore.activeTrackKey(trackNew["id"]));
        Application.Storage.deleteValue(SyncAndRun.SyncStore.activePlaylistKey(playlistA["id"]));
        Application.Storage.deleteValue(SyncAndRun.SyncStore.activePlaylistKey(playlistC["id"]));
        SyncAndRun.BoundedList.clear(SyncAndRun.SyncStore.activePlaylistTracks(playlistA["id"]));
        SyncAndRun.BoundedList.clear(SyncAndRun.SyncStore.activePlaylistTracks(playlistC["id"]));
        SyncAndRun.BoundedList.clear(SyncAndRun.SyncStore.ACTIVE_PLAYLISTS);
        SyncAndRun.BoundedList.clear(SyncAndRun.SyncStore.ACTIVE_TRACKS);
        SyncAndRun.SyncStore.clearDesiredRecords();
        return true;
    }

    (:test)
    function discardsADownloadWhoseDesiredRecordWasSupersededBeforeItArrived(logger) {
        clearFixtureDesired();
        // Reproduces the mechanism behind the orphaned-cache defect: a sync
        // is superseded by a newer one (e.g. a Wi-Fi drop and retry with a
        // different manifest revision) while a track download from the old
        // attempt is still in flight. When that download's callback finally
        // lands, its desired record no longer exists.
        var track = ProtocolTests.track(501);
        var run = SyncAndRun.SyncStore.beginDesired("orphaned-download-fixture-revision");
        SyncAndRun.SyncStore.upsertDesiredTrack(track, run);
        Test.assert(Application.Storage.getValue(SyncAndRun.SyncStore.desiredTrackKey(track["id"])) != null);

        Application.Storage.deleteValue(SyncAndRun.SyncStore.desiredTrackKey(track["id"]));
        Test.assert(!SyncAndRun.SyncStore.saveDesiredRef(track["id"], "late-arriving-ref"));

        clearFixtureDesired();
        return true;
    }

    (:test)
    function rejectsALateDownloadWhenANewerRunReusesTheSameTrackId(logger) {
        clearFixtureDesired();
        var track = ProtocolTests.track(502);
        var firstRun = SyncAndRun.SyncStore.beginDesired("late-same-track-revision-one");
        SyncAndRun.SyncStore.upsertDesiredTrack(track, firstRun);

        var secondRun = SyncAndRun.SyncStore.beginDesired("late-same-track-revision-two");
        SyncAndRun.SyncStore.upsertDesiredTrack(track, secondRun);

        // The old callback must not attach its ContentRef to the newer run's
        // record merely because both manifests contain the same track id.
        Test.assert(!SyncAndRun.SyncStore.saveDesiredRefForRun(track["id"], firstRun, "stale-ref"));
        Test.assert(SyncAndRun.SyncStore.saveDesiredRefForRun(track["id"], secondRun, "current-ref"));
        var desired = SyncAndRun.SyncStore.desiredTrack(track["id"]);
        Test.assertEqual("current-ref", desired["refId"]);

        // Avoid asking the simulator media cache to delete this synthetic id.
        Application.Storage.deleteValue(SyncAndRun.SyncStore.desiredTrackKey(track["id"]));
        SyncAndRun.BoundedList.clear(SyncAndRun.SyncStore.DESIRED_TRACKS);
        SyncAndRun.BoundedList.clear(SyncAndRun.SyncStore.DESIRED_PENDING_AUDIO);
        Application.Storage.deleteValue(SyncAndRun.SyncStore.DESIRED_REVISION);
        return true;
    }

    (:test)
    function deduplicatesArtworkByIdentity(logger) {
        clearFixtureDesired();
        var first = ProtocolTests.track(77);
        var second = ProtocolTests.track(78);
        second["artworkId"] = first["artworkId"];
        second["artworkPath"] = first["artworkPath"];
        var revision = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
        var run = SyncAndRun.SyncStore.beginDesired(revision);
        SyncAndRun.SyncStore.upsertDesiredTrack(first, run);
        SyncAndRun.SyncStore.upsertDesiredTrack(second, run);
        Test.assertEqual(1, SyncAndRun.BoundedList.size(SyncAndRun.SyncStore.DESIRED_ARTWORKS));
        Test.assert(SyncAndRun.SyncStore.saveArtwork(first["artworkId"], "shared-artwork"));
        Test.assert(SyncAndRun.SyncStore.hasArtwork(second["artworkId"]));
        Application.Storage.setValue(SyncAndRun.SyncStore.activeTrackKey(first["id"]), first);
        Test.assertEqual("shared-artwork", (new Audio(first["id"], Audio.SONG)).artwork());
        Application.Storage.deleteValue(SyncAndRun.SyncStore.activeTrackKey(first["id"]));
        Application.Storage.deleteValue(SyncAndRun.SyncStore.artworkKey(first["artworkId"]));
        SyncAndRun.SyncStore.clearDesiredRecords();
        return true;
    }

    (:test)
    function reusesCompletedDownloadWhenInterruptedRevisionRestarts(logger) {
        clearFixtureDesired();
        var id = "plex:track:resume-fixture";
        var revision = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
        var track = ProtocolTests.track(88);
        track["id"] = id;
        var firstRun = SyncAndRun.SyncStore.beginDesired(revision);
        SyncAndRun.SyncStore.upsertDesiredTrack(track, firstRun);
        Test.assert(SyncAndRun.SyncStore.saveDesiredRef(id, "resume-content-ref"));

        var resumedRun = SyncAndRun.SyncStore.beginDesired(revision);
        var resumed = SyncAndRun.SyncStore.upsertDesiredTrack(track, resumedRun);
        Test.assertEqual("resume-content-ref", resumed["refId"]);
        Test.assertEqual(1, resumed["refCount"]);
        Test.assertEqual(1, SyncAndRun.BoundedList.size(SyncAndRun.SyncStore.DESIRED_TRACKS));
        Test.assertEqual(0, SyncAndRun.BoundedList.size(SyncAndRun.SyncStore.DESIRED_PENDING_AUDIO));

        // This synthetic id is not a simulator media-cache reference, so remove
        // only the storage fixture instead of asking Media to delete it.
        Application.Storage.deleteValue(SyncAndRun.SyncStore.desiredTrackKey(id));
        SyncAndRun.BoundedList.clear(SyncAndRun.SyncStore.DESIRED_TRACKS);
        SyncAndRun.BoundedList.clear(SyncAndRun.SyncStore.DESIRED_PENDING_AUDIO);
        Application.Storage.deleteValue(SyncAndRun.SyncStore.DESIRED_REVISION);
        return true;
    }

    (:test)
    function preservesStoredPairingTokenDuringSyncPlanning(logger) {
        clearFixtureDesired();
        var previous = Application.Storage.getValue(SyncAndRun.State.DEVICE_TOKEN);
        Application.Storage.setValue(SyncAndRun.State.DEVICE_TOKEN, "stored-token-fixture");

        SyncAndRun.SyncStore.beginDesired(
            "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"
        );
        Test.assertEqual("stored-token-fixture", SyncAndRun.State.token());

        SyncAndRun.SyncStore.clearDesiredRecords();
        Application.Storage.deleteValue(SyncAndRun.SyncStore.DESIRED_REVISION);
        if (previous == null) {
            Application.Storage.deleteValue(SyncAndRun.State.DEVICE_TOKEN);
        } else {
            Application.Storage.setValue(SyncAndRun.State.DEVICE_TOKEN, previous);
        }
        return true;
    }

    (:test)
    function preservesGarminObjectContentReferences(logger) {
        clearFixtureDesired();
        var id = "plex:track:numeric-ref";
        var playlistId = "plex:playlist:numeric-ref";
        var track = ProtocolTests.track(99);
        track["id"] = id;
        var playlist = ProtocolTests.playlist(99);
        playlist["id"] = playlistId;
        var revision = "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";

        var run = SyncAndRun.SyncStore.beginDesired(revision);
        SyncAndRun.SyncStore.startDesiredPlaylist(playlist);
        SyncAndRun.SyncStore.upsertDesiredTrack(track, run);
        SyncAndRun.SyncStore.appendDesiredPlaylistTrack(playlistId, id);
        Test.assert(SyncAndRun.SyncStore.saveDesiredRef(id, 4242));
        SyncAndRun.SyncStore.commitDesired(revision);

        var active = Application.Storage.getValue(SyncAndRun.SyncStore.activeTrackKey(id)) as Lang.Dictionary;
        Test.assert(SyncAndRun.SyncStore.hasRef(active["refId"]));
        Test.assertEqual(4242, active["refId"]);
        var songs = new SyncAndRun.Menu.SongsLocal("Fixture songs", [id], null);
        Test.assert(songs.load());
        Test.assert(songs.getItem(0) != null);

        // Keep the matching active record until desired cleanup so the
        // simulator does not try to delete this synthetic cache reference.
        SyncAndRun.SyncStore.clearDesiredRecords();
        Application.Storage.deleteValue(SyncAndRun.SyncStore.activeTrackKey(id));
        Application.Storage.deleteValue(SyncAndRun.SyncStore.activePlaylistKey(playlistId));
        SyncAndRun.BoundedList.clear(SyncAndRun.SyncStore.activePlaylistTracks(playlistId));
        SyncAndRun.BoundedList.clear(SyncAndRun.SyncStore.ACTIVE_PLAYLISTS);
        SyncAndRun.BoundedList.clear(SyncAndRun.SyncStore.ACTIVE_TRACKS);
        return true;
    }

    (:test)
    function reportsPairingAndSyncStateToTheReadonlySettings(logger) {
        // The phone's settings screen shows these two through readonly
        // entries, so they are the only feedback the owner gets there.
        SyncAndRun.Report.pairing(true);
        Test.assertEqual("Paired", Application.Properties.getValue("pairing_status"));
        SyncAndRun.Report.pairing(false);
        Test.assertEqual("Not paired", Application.Properties.getValue("pairing_status"));

        SyncAndRun.Report.syncApplied();
        var stamp = Application.Properties.getValue("last_sync");
        Test.assert(stamp instanceof Lang.String);
        // Locale-free "YYYY-MM-DD HH:MM"; an ambiguous 08/09 would be useless
        // in a support conversation.
        Test.assertEqual(16, stamp.length());
        Test.assertEqual("-", stamp.substring(4, 5));
        Test.assertEqual("-", stamp.substring(7, 8));
        Test.assertEqual(" ", stamp.substring(10, 11));
        Test.assertEqual(":", stamp.substring(13, 14));
        return true;
    }

    (:test)
    function prefersOnWatchPairingCodeOverApplicationSetting(logger) {
        var previousSetting = Application.Properties.getValue("pairing_code");
        Application.Storage.deleteValue(SyncAndRun.PAIRING_CODE_KEY);

        // Neither source populated.
        Application.Properties.setValue("pairing_code", "");
        Test.assert(SyncAndRun.pairingCode() == null);

        // The application setting alone still pairs, so the phone-side path
        // keeps working for anyone already using it.
        Application.Properties.setValue("pairing_code", "111111");
        Test.assertEqual("111111", SyncAndRun.pairingCode());

        // An on-watch entry must win over a stale setting value.
        Application.Storage.setValue(SyncAndRun.PAIRING_CODE_KEY, "246810");
        Test.assertEqual("246810", SyncAndRun.pairingCode());

        // Non-numeric and wrong-length values are not codes.
        Application.Storage.setValue(SyncAndRun.PAIRING_CODE_KEY, "12345");
        Test.assertEqual("111111", SyncAndRun.pairingCode());
        Application.Storage.setValue(SyncAndRun.PAIRING_CODE_KEY, "12345x");
        Test.assertEqual("111111", SyncAndRun.pairingCode());

        // Pairing consumes the code from both sources.
        Application.Storage.setValue(SyncAndRun.PAIRING_CODE_KEY, "246810");
        SyncAndRun.clearPairingCode();
        Test.assert(SyncAndRun.pairingCode() == null);

        if (previousSetting instanceof Lang.String) {
            Application.Properties.setValue("pairing_code", previousSetting);
        }
        return true;
    }

    (:test)
    function digitPickerBuildsASixDigitCode(logger) {
        Application.Storage.deleteValue(SyncAndRun.PAIRING_CODE_KEY);
        var picker = new SyncAndRun.PairingPicker();
        Test.assertEqual("000000", picker.code());

        // Each wheel is independent and wraps in both directions.
        picker.adjust(3);
        Test.assertEqual("300000", picker.code());
        picker.adjust(-4);
        Test.assertEqual("900000", picker.code());

        Test.assert(!picker.advance());
        picker.adjust(1);
        Test.assertEqual("910000", picker.code());

        // Back steps within the code before it leaves the picker.
        Test.assert(picker.retreat());
        picker.adjust(1);
        Test.assertEqual("010000", picker.code());
        Test.assert(!picker.retreat());

        // advance() reports completion only on the final digit.
        for (var idx = 0; idx < (SyncAndRun.PAIRING_CODE_LENGTH - 1); ++idx) {
            Test.assert(!picker.advance());
        }
        Test.assert(picker.advance());

        // A resumed picker restores a previously entered code.
        Application.Storage.setValue(SyncAndRun.PAIRING_CODE_KEY, "135790");
        Test.assertEqual("135790", (new SyncAndRun.PairingPicker()).code());
        Application.Storage.deleteValue(SyncAndRun.PAIRING_CODE_KEY);
        return true;
    }

    (:test)
    function companionOriginCanBeEnteredOnWatch(logger) {
        var previousSetting = Application.Properties.getValue("companion_url");
        var previousStored = Application.Storage.getValue(SyncAndRun.CompanionOrigin.STORAGE_KEY);
        var previousToken = Application.Storage.getValue(SyncAndRun.State.DEVICE_TOKEN);
        var previousPairingCode = Application.Storage.getValue(SyncAndRun.PAIRING_CODE_KEY);

        Application.Properties.setValue("companion_url", "");
        Application.Storage.deleteValue(SyncAndRun.CompanionOrigin.STORAGE_KEY);
        Application.Storage.deleteValue(SyncAndRun.State.DEVICE_TOKEN);

        Test.assertEqual("https://music.example.test", SyncAndRun.CompanionOrigin.normalize("Music.Example.Test"));
        Test.assertEqual("https://music.example.test", SyncAndRun.CompanionOrigin.normalize("HTTPS://MUSIC.EXAMPLE.TEST"));
        Test.assertEqual("http://music.example.test", SyncAndRun.CompanionOrigin.normalize("HTTP://MUSIC.EXAMPLE.TEST"));
        Test.assertEqual("https://192.168.1.20", SyncAndRun.CompanionOrigin.normalize("192.168.1.20"));
        Test.assertEqual("http://192.168.1.20:3000", SyncAndRun.CompanionOrigin.normalize("http://192.168.1.20:3000"));
        Test.assertEqual("https://music.example.test:8443", SyncAndRun.CompanionOrigin.normalize("https://music.example.test:8443"));
        Test.assert(SyncAndRun.CompanionOrigin.normalize("https://music.example.test/path") == null);
        Test.assert(SyncAndRun.CompanionOrigin.normalize("http://music.example.test:0") == null);
        Test.assert(SyncAndRun.CompanionOrigin.normalize("http://music.example.test:65536") == null);
        Test.assert(SyncAndRun.CompanionOrigin.normalize("http://music.example.test:abc") == null);
        Test.assert(SyncAndRun.CompanionOrigin.normalize("http://999.168.1.20:3000") == null);
        Test.assert(SyncAndRun.CompanionOrigin.normalize("https://user@music.example.test") == null);
        Test.assert(SyncAndRun.CompanionOrigin.normalize("bad_host.example.test") == null);
        Test.assert(SyncAndRun.CompanionOrigin.normalize("-bad.example.test") == null);
        Test.assert(SyncAndRun.CompanionOrigin.normalize("bad..example.test") == null);

        // Existing Connect IQ settings remain a fallback until the watch saves
        // its own authoritative value.
        Application.Properties.setValue("companion_url", "https://legacy.example.test");
        Test.assertEqual("https://legacy.example.test", SyncAndRun.CompanionOrigin.current());
        Application.Storage.setValue(SyncAndRun.CompanionOrigin.STORAGE_KEY, "https://watch.example.test");
        Test.assertEqual("https://watch.example.test", SyncAndRun.CompanionOrigin.current());
        Test.assertEqual("https://watch.example.test", SyncAndRun.companionAddress());

        // Changing servers invalidates only server-specific credentials. It
        // mirrors the origin to Connect IQ settings and leaves media alone.
        Application.Storage.setValue(SyncAndRun.State.DEVICE_TOKEN, "old-device-token");
        Test.assert(SyncAndRun.CompanionOrigin.save("new.example.test"));
        Test.assertEqual("https://new.example.test", SyncAndRun.CompanionOrigin.current());
        Test.assertEqual("https://new.example.test", Application.Properties.getValue("companion_url"));
        Test.assert(SyncAndRun.State.token() == null);
        Test.assert(!SyncAndRun.CompanionOrigin.save("https://new.example.test/path"));
        Test.assertEqual("https://new.example.test", SyncAndRun.CompanionOrigin.current());

        if (previousSetting instanceof Lang.String) {
            Application.Properties.setValue("companion_url", previousSetting);
        } else {
            Application.Properties.setValue("companion_url", "");
        }
        if (previousStored instanceof Lang.String) {
            Application.Storage.setValue(SyncAndRun.CompanionOrigin.STORAGE_KEY, previousStored);
        } else {
            Application.Storage.deleteValue(SyncAndRun.CompanionOrigin.STORAGE_KEY);
        }
        if (previousToken instanceof Lang.String) {
            Application.Storage.setValue(SyncAndRun.State.DEVICE_TOKEN, previousToken);
        } else {
            Application.Storage.deleteValue(SyncAndRun.State.DEVICE_TOKEN);
        }
        if (previousPairingCode instanceof Lang.String) {
            Application.Storage.setValue(SyncAndRun.PAIRING_CODE_KEY, previousPairingCode);
        } else {
            Application.Storage.deleteValue(SyncAndRun.PAIRING_CODE_KEY);
        }
        return true;
    }

    (:test)
    function nativeCompanionOriginEntryOmitsTheSchemeAndPreservesItOnSave(logger) {
        Test.assertEqual("syncandrun.example.com",
            SyncAndRun.companionOriginAuthority("https://syncandrun.example.com"));
        Test.assertEqual("https://", SyncAndRun.companionOriginScheme("https://syncandrun.example.com"));
        Test.assertEqual("http://", SyncAndRun.companionOriginScheme("http://192.168.1.20:3000"));
        Test.assertEqual("https://syncandrun.example.com",
            SyncAndRun.companionOriginPickerCandidate("syncandrun.example.com", "https://"));
        Test.assertEqual("http://192.168.1.20:3000",
            SyncAndRun.companionOriginPickerCandidate("192.168.1.20:3000", "http://"));
        Test.assertEqual("https://typed.example.test",
            SyncAndRun.companionOriginPickerCandidate("https://typed.example.test", "http://"));
        return true;
    }

    (:test)
    function companionOriginEditorUsesPortableBehaviorControls(logger) {
        var editor = new SyncAndRun.CompanionOriginEditor("https://");
        Test.assertEqual("https://", editor.candidate());
        Test.assertEqual("", editor.authority());
        Test.assertEqual("https://", editor.scheme());

        // The editor exposes only origin-safe authority characters. Select
        // appends, Back removes, and no device-native confirm callback exists.
        Test.assert(editor.selectCharacter("s"));
        Test.assertEqual(SyncAndRun.ORIGIN_EDITOR_NO_ACTION, editor.activate());
        Test.assertEqual("https://s", editor.candidate());
        Test.assert(editor.appendCharacter("y"));
        Test.assertEqual("https://sy", editor.candidate());
        Test.assert(!editor.appendCharacter("/"));
        Test.assert(editor.removeCharacter());
        Test.assertEqual("https://s", editor.candidate());
        Test.assert(editor.removeCharacter());
        Test.assert(!editor.removeCharacter());

        // Scheme, save, and cancel are normal selectable actions in the same
        // app-owned wheel, so button and touch devices share one interaction.
        Test.assert(editor.selectAction(SyncAndRun.ORIGIN_EDITOR_SCHEME_INDEX));
        Test.assertEqual("USE HTTP", editor.selectedLabel());
        Test.assertEqual(SyncAndRun.ORIGIN_EDITOR_NO_ACTION, editor.activate());
        Test.assertEqual("http://", editor.scheme());
        Test.assertEqual("USE HTTPS", editor.selectedLabel());
        Test.assert(editor.selectAction(SyncAndRun.ORIGIN_EDITOR_SAVE_INDEX));
        Test.assertEqual(SyncAndRun.ORIGIN_EDITOR_SAVE, editor.activate());
        Test.assert(editor.selectAction(SyncAndRun.ORIGIN_EDITOR_CANCEL_INDEX));
        Test.assertEqual(SyncAndRun.ORIGIN_EDITOR_CANCEL, editor.activate());
        Test.assert(!editor.selectAction(-1));
        Test.assert(!editor.selectCharacter("A"));

        // Existing origins reopen without losing their scheme, host, or port.
        editor = new SyncAndRun.CompanionOriginEditor("http://192.168.1.20:3000");
        Test.assertEqual("http://", editor.scheme());
        Test.assertEqual("192.168.1.20:3000", editor.authority());
        Test.assertEqual("http://192.168.1.20:3000", editor.candidate());

        // Navigation is circular: Down from the first action reaches the last
        // character, while Up returns to SAVE.
        editor.selectAction(SyncAndRun.ORIGIN_EDITOR_SAVE_INDEX);
        editor.adjust(-1);
        Test.assertEqual(":", editor.selectedLabel());
        editor.adjust(1);
        Test.assertEqual("SAVE", editor.selectedLabel());
        return true;
    }
}
