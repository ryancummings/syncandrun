using Toybox.Application;
using Toybox.Lang;
using Toybox.Test;

module SyncTimingTests {
    (:test)
    function partitionsAudioAndArtworkStages(logger) {
        var timings = new SyncAndRun.SyncTimings(1000, 250);
        timings.finishConfig(1200);
        timings.finishMetadata(1500);
        timings.startAudio(2000);
        timings.audioProgress(2100, 1000);
        timings.audioProgress(2600, 3000);
        timings.finishAudio(2800);
        timings.startArtwork(2900);
        timings.finishArtwork(3100);
        var result = timings.snapshot(4000);
        Test.assertEqual(3000, result["totalMs"]);
        Test.assertEqual(250, result["launchMs"]);
        Test.assertEqual(200, result["configMs"]);
        Test.assertEqual(300, result["metadataMs"]);
        Test.assertEqual(800, result["audioTotalMs"]);
        Test.assertEqual(100, result["audioStartupMs"]);
        Test.assertEqual(500, result["audioTransferMs"]);
        Test.assertEqual(200, result["audioFinalizeMs"]);
        Test.assertEqual(200, result["artworkMs"]);
        Test.assertEqual(3000, result["audioBytes"]);
        Test.assertEqual(2, result["audioProgressCallbacks"]);
        Test.assertEqual(1, result["audioCount"]);
        Test.assertEqual(1, result["artworkCount"]);
        return true;
    }

    (:test)
    function classifiesAudioWithoutProgressAsStartup(logger) {
        var timings = new SyncAndRun.SyncTimings(1000, 0);
        timings.startAudio(1100);
        timings.finishAudio(1400);
        var result = timings.snapshot(1500);
        Test.assertEqual(300, result["audioTotalMs"]);
        Test.assertEqual(300, result["audioStartupMs"]);
        Test.assertEqual(0, result["audioTransferMs"]);
        Test.assertEqual(0, result["audioFinalizeMs"]);
        Test.assertEqual(1, result["audioCount"]);
        return true;
    }

    (:test)
    function checkpointsEveryThreeCompletedDownloads(logger) {
        var timings = new SyncAndRun.SyncTimings(0, 0);
        Test.assert(!timings.shouldCheckpoint(2, 0));
        Test.assert(timings.shouldCheckpoint(3, 0));
        Test.assert(!timings.shouldCheckpoint(5, 3));
        Test.assert(timings.shouldCheckpoint(6, 3));
        return true;
    }

    (:test)
    function estimatesOnlyAfterStableSamples(logger) {
        var timings = new SyncAndRun.SyncTimings(0, 0);
        timings.startAudio(10);
        timings.finishAudio(1010);
        Test.assert(timings.estimateRemainingSeconds(3, 0) == null);
        timings.startAudio(1100);
        timings.finishAudio(2100);
        Test.assertEqual(3, timings.estimateRemainingSeconds(3, 0));
        return true;
    }

    (:test)
    function measuresAndConsumesNativeSyncLaunchDelay(logger) {
        SyncAndRun.SyncLaunch.recordRequestAt(1000);
        SyncAndRun.SyncLaunch.captureStartAt(4750);
        Test.assertEqual(3750, SyncAndRun.SyncLaunch.takeLaunchMs());
        Test.assertEqual(0, SyncAndRun.SyncLaunch.takeLaunchMs());
        return true;
    }

    (:test)
    function describesResumedArtworkAndCachedRuns(logger) {
        BoundedStorageTests.clearFixtureDesired();
        Test.assertEqual("Preparing library", SyncAndRun.SyncStatus.startMessage());
        Application.Storage.setValue("syncandrun.last_sync_summary", {
            "timings" => {
                "audioCount" => 2,
                "audioTotalMs" => 20000,
                "artworkCount" => 2,
                "artworkMs" => 10000
            }
        });
        var track = ProtocolTests.track(123);
        var run = SyncAndRun.SyncStore.beginDesired(ProtocolTests.REVISION);
        SyncAndRun.SyncStore.upsertDesiredTrack(track, run);
        SyncAndRun.SyncStore.finishDesiredTraversal();
        var resumeMessage = SyncAndRun.SyncStatus.startMessage();
        Test.assertEqual("Resume 1 audio track + 1 artwork | ~15s", resumeMessage);

        Test.assert(SyncAndRun.SyncStore.saveDesiredRef(track["id"], "status-test-ref"));
        Application.Storage.setValue(SyncAndRun.State.DESIRED_REVISION, ProtocolTests.REVISION);
        Test.assertEqual("Checking library + 1 artwork", SyncAndRun.SyncStatus.startMessage());
        Application.Storage.setValue(SyncAndRun.State.APPLIED_REVISION, ProtocolTests.REVISION);
        Test.assertEqual("Syncing 1 artwork", SyncAndRun.SyncStatus.startMessage());

        BoundedStorageTests.clearFixtureDesired();
        Application.Storage.deleteValue(SyncAndRun.State.DESIRED_REVISION);
        Application.Storage.deleteValue(SyncAndRun.State.APPLIED_REVISION);
        SyncAndRun.BoundedList.append(SyncAndRun.SyncStore.ACTIVE_TRACKS, track["id"]);
        Test.assertEqual("Checking 1 cached track", SyncAndRun.SyncStatus.startMessage());
        SyncAndRun.BoundedList.clear(SyncAndRun.SyncStore.ACTIVE_TRACKS);
        Application.Storage.deleteValue("syncandrun.last_sync_summary");
        return true;
    }

    (:test)
    function persistsPhaseCountsProgressAndStableEta(logger) {
        var counts = {
            "downloaded" => 3,
            "reused" => 2,
            "deleted" => 1,
            "failed" => 0
        };
        Test.assertEqual("Audio 5/10 | ~42s", SyncAndRun.SyncStatus.update(
            "Audio", 5, 10, 62, 42, counts
        ));
        var status = Application.Storage.getValue(SyncAndRun.SyncStatus.KEY) as Lang.Dictionary;
        Test.assertEqual("Audio", status["phase"]);
        Test.assertEqual(5, status["current"]);
        Test.assertEqual(10, status["total"]);
        Test.assertEqual(62, status["percentage"]);
        Test.assertEqual(42, status["etaSeconds"]);
        var storedCounts = status["counts"] as Lang.Dictionary;
        Test.assertEqual(3, storedCounts["downloaded"]);
        Application.Storage.deleteValue(SyncAndRun.SyncStatus.KEY);
        return true;
    }
}
