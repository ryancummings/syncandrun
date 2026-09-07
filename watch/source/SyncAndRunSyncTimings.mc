using Toybox.Application;
using Toybox.Lang;
using Toybox.System;

module SyncAndRun {
    module SyncLaunch {
        const REQUESTED_AT = "syncandrun.sync_requested_at";
        const LAUNCH_MS = "syncandrun.sync_launch_ms";

        function recordRequest() { recordRequestAt(System.getTimer()); }

        function recordRequestAt(now) {
            Application.Storage.setValue(REQUESTED_AT, now);
            Application.Storage.deleteValue(LAUNCH_MS);
        }

        function captureStart() { captureStartAt(System.getTimer()); }

        function captureStartAt(now) {
            var requestedAt = Application.Storage.getValue(REQUESTED_AT);
            Application.Storage.deleteValue(REQUESTED_AT);
            var milliseconds = 0;
            if ((requestedAt instanceof Lang.Number) && (now instanceof Lang.Number) && (now >= requestedAt)) {
                milliseconds = now - requestedAt;
            }
            Application.Storage.setValue(LAUNCH_MS, milliseconds);
        }

        function takeLaunchMs() {
            var milliseconds = Application.Storage.getValue(LAUNCH_MS);
            Application.Storage.deleteValue(LAUNCH_MS);
            if (milliseconds instanceof Lang.Number) { return milliseconds; }
            return 0;
        }
    }

    class SyncTimings {
        private var d_startedAt;
        private var d_launchMs = 0;
        private var d_configMs = 0;
        private var d_configFinished = false;
        private var d_metadataStartedAt;
        private var d_metadataMs = 0;
        private var d_metadataFinished = false;
        private var d_audioStartedAt = null;
        private var d_audioFirstProgressAt = null;
        private var d_audioLastProgressAt = null;
        private var d_audioLastTransferred = 0;
        private var d_artworkStartedAt = null;
        private var d_audioTotalMs = 0;
        private var d_audioStartupMs = 0;
        private var d_audioTransferMs = 0;
        private var d_audioFinalizeMs = 0;
        private var d_artworkMs = 0;
        private var d_audioBytes = 0;
        private var d_audioProgressCallbacks = 0;
        private var d_audioCount = 0;
        private var d_artworkCount = 0;

        function initialize(startedAt, launchMs) {
            d_startedAt = startedAt;
            d_metadataStartedAt = startedAt;
            if (launchMs instanceof Lang.Number) { d_launchMs = launchMs; }
        }

        function finishConfig(now) {
            if (d_configFinished) { return; }
            d_configMs = elapsed(d_startedAt, now);
            d_metadataStartedAt = now;
            d_configFinished = true;
        }

        function finishMetadata(now) {
            if (d_metadataFinished) { return; }
            d_metadataMs = elapsed(d_metadataStartedAt, now);
            d_metadataFinished = true;
        }

        function startAudio(now) {
            finishMetadata(now);
            finishActive(now);
            d_audioStartedAt = now;
            d_audioFirstProgressAt = null;
            d_audioLastProgressAt = null;
            d_audioLastTransferred = 0;
        }

        function audioProgress(now, transferred) {
            if (!(d_audioStartedAt instanceof Lang.Number)) { return; }
            if (!(d_audioFirstProgressAt instanceof Lang.Number)) { d_audioFirstProgressAt = now; }
            d_audioLastProgressAt = now;
            if ((transferred instanceof Lang.Number) && (transferred > d_audioLastTransferred)) {
                d_audioLastTransferred = transferred;
            }
            if (d_audioProgressCallbacks < 1000000) { d_audioProgressCallbacks += 1; }
        }

        function finishAudio(now) {
            if (!(d_audioStartedAt instanceof Lang.Number)) { return; }
            var total = elapsed(d_audioStartedAt, now);
            d_audioTotalMs += total;
            if (d_audioFirstProgressAt instanceof Lang.Number) {
                d_audioStartupMs += elapsed(d_audioStartedAt, d_audioFirstProgressAt);
                d_audioTransferMs += elapsed(d_audioFirstProgressAt, d_audioLastProgressAt);
                d_audioFinalizeMs += elapsed(d_audioLastProgressAt, now);
            } else {
                d_audioStartupMs += total;
            }
            d_audioBytes += d_audioLastTransferred;
            if (d_audioBytes > 2000000000) { d_audioBytes = 2000000000; }
            d_audioCount += 1;
            d_audioStartedAt = null;
            d_audioFirstProgressAt = null;
            d_audioLastProgressAt = null;
            d_audioLastTransferred = 0;
        }

        function startArtwork(now) {
            finishActive(now);
            d_artworkStartedAt = now;
        }

        function finishArtwork(now) {
            if (!(d_artworkStartedAt instanceof Lang.Number)) { return; }
            d_artworkMs += elapsed(d_artworkStartedAt, now);
            d_artworkCount += 1;
            d_artworkStartedAt = null;
        }

        function finishActive(now) {
            finishAudio(now);
            finishArtwork(now);
        }

        function snapshot(now) {
            finishMetadata(now);
            finishActive(now);
            return {
                "launchMs" => d_launchMs,
                "totalMs" => elapsed(d_startedAt, now),
                "configMs" => d_configMs,
                "metadataMs" => d_metadataMs,
                "audioTotalMs" => d_audioTotalMs,
                "audioStartupMs" => d_audioStartupMs,
                "audioTransferMs" => d_audioTransferMs,
                "audioFinalizeMs" => d_audioFinalizeMs,
                "artworkMs" => d_artworkMs,
                "audioBytes" => d_audioBytes,
                "audioProgressCallbacks" => d_audioProgressCallbacks,
                "audioCount" => d_audioCount,
                "artworkCount" => d_artworkCount
            };
        }

        function shouldCheckpoint(downloaded, lastCheckpointDownloaded) {
            return (downloaded >= (lastCheckpointDownloaded + 3));
        }

        function estimateRemainingSeconds(audioRemaining, artworkRemaining) {
            var milliseconds = 0;
            var stable = false;
            if ((audioRemaining > 0) && (d_audioCount >= 2)) {
                milliseconds += audioRemaining * d_audioTotalMs / d_audioCount;
                stable = true;
            }
            if ((artworkRemaining > 0) && (d_artworkCount >= 2)) {
                milliseconds += artworkRemaining * d_artworkMs / d_artworkCount;
                stable = true;
            }
            if (!stable) { return null; }
            return ((milliseconds + 999) / 1000).toNumber();
        }

        function elapsed(startedAt, finishedAt) {
            if (!(startedAt instanceof Lang.Number) || !(finishedAt instanceof Lang.Number)) { return 0; }
            if (finishedAt < startedAt) { return 0; }
            return finishedAt - startedAt;
        }
    }
}
