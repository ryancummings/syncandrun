using Toybox.Application;
using Toybox.Communications;
using Toybox.Lang;
using Toybox.Media;
using Toybox.Timer;

module SyncAndRun {
    class AudioRequestDelegate {
        private var d_reconciler;
        private var d_run;
        private var d_trackId;

        function initialize(reconciler, run, trackId) {
            d_reconciler = reconciler;
            d_run = run;
            d_trackId = trackId;
        }

        function onProgress(transferred, size) {
            d_reconciler.onAudioProgressFor(d_run, d_trackId, transferred, size);
        }

        function onComplete(responseCode, data) {
            d_reconciler.onAudioFor(d_run, d_trackId, responseCode, data);
        }
    }

    class Reconciler {
        private var d_notifyProgress;
        private var d_notifyComplete;
        private var d_client;
        private var d_cancelled = false;
        private var d_revision = null;
        private var d_run = 0;
        private var d_playlistPage = null;
        private var d_playlistIndex = 0;
        private var d_playlistCursor = null;
        private var d_currentPlaylist = null;
        private var d_trackCursor = null;
        private var d_downloadIndex = 0;
        private var d_currentTrack = null;
        private var d_artworkIndex = 0;
        private var d_currentArtwork = null;
        private var d_artworkCompleted = 0;
        private var d_artworkTotal = 0;
        private var d_counts = { "downloaded" => 0, "reused" => 0, "deleted" => 0, "failed" => 0 };
        private var d_errors = [];
        private var d_retryTimer = null;
        private var d_workTimer = null;
        private var d_retryAction = null;
        private var d_retryCount = 0;
        private var d_timings;
        private var d_lastCheckpointDownloaded = 0;
        private var d_metadataTracks = 0;
        private var d_metadataTotalTracks = 0;
        private var d_lastPercentage = 0;

        function initialize(notifyProgress, notifyComplete) {
            d_notifyProgress = notifyProgress;
            d_notifyComplete = notifyComplete;
            d_client = new Client();
            d_timings = new SyncTimings(System.getTimer(), 0);
        }

        function start() {
            d_cancelled = false;
            d_revision = null;
            d_run = 0;
            d_playlistPage = null;
            d_playlistIndex = 0;
            d_playlistCursor = null;
            d_currentPlaylist = null;
            d_trackCursor = null;
            d_downloadIndex = 0;
            d_currentTrack = null;
            d_artworkIndex = 0;
            d_currentArtwork = null;
            d_artworkCompleted = 0;
            d_artworkTotal = 0;
            d_counts = { "downloaded" => 0, "reused" => 0, "deleted" => 0, "failed" => 0 };
            d_errors = [];
            resetRetry();
            resetWorkTimer();
            d_timings = new SyncTimings(System.getTimer(), SyncLaunch.takeLaunchMs());
            d_lastCheckpointDownloaded = 0;
            d_metadataTracks = 0;
            d_metadataTotalTracks = 0;
            d_lastPercentage = 0;
            if (!d_client.validOrigin()) { finishWithMessage("Set a companion server address."); return; }
            notifyStatus("Preparing", 0, 0, 0, 0, 0);
            if (!(State.token() instanceof Lang.String)) {
                var code = pairingCode();
                if (code == null) {
                    finishWithMessage("Create and enter a pairing code.");
                    return;
                }
                notifyStatus("Pairing", 0, 0, 1, 0, 0);
                d_client.pair(code, method(:onPair));
                return;
            }
            requestConfig();
        }

        function stop() {
            d_cancelled = true;
            if (d_retryTimer != null) { d_retryTimer.stop(); }
            resetWorkTimer();
            Communications.cancelAllRequests();
            if (d_revision instanceof Lang.String) { report("cancelled", "Sync cancelled"); }
            else { finishWithMessage("Sync cancelled"); }
        }

        function onPair(responseCode, data) {
            if (d_cancelled) { return; }
            if (responseCode != 200) { responseFailure(responseCode, data, "Pairing failed"); return; }
            var pair = Protocol.parsePair(data);
            if (pair == null) { finishWithMessage("The pairing response was invalid."); return; }
            State.savePairing(pair);
            notifyStatus("Pairing", 1, 1, 3, 0, 0);
            requestConfig();
        }

        function onConfig(responseCode, data) {
            if (d_cancelled) { return; }
            d_timings.finishConfig(System.getTimer());
            if (responseCode != 200 && responseCode != 304 && retryMetadata(responseCode)) { return; }
            resetRetry();
            if (responseCode == 304) {
                var current = Application.Storage.getValue(State.APPLIED_REVISION);
                if (current instanceof Lang.String) {
                    d_counts["reused"] = BoundedList.size(SyncStore.ACTIVE_TRACKS);
                    startArtworkBackfill(current);
                }
                else { finishSuccess(); }
                return;
            }
            if (responseCode != 200) { responseFailure(responseCode, data, "Companion unavailable"); return; }
            var config = Protocol.parseConfig(data);
            if (config == null) { finishWithMessage("Update the companion or watch app."); return; }
            d_revision = config["manifestRevision"];
            Application.Storage.setValue(State.DESIRED_REVISION, d_revision);
            Application.Storage.setValue("syncandrun.profile", config["transcodeProfile"]);
            var applied = Application.Storage.getValue(State.APPLIED_REVISION);
            if ((applied instanceof Lang.String) && applied.equals(d_revision)) {
                startArtworkBackfill(applied);
                return;
            }
            d_run = SyncStore.beginDesired(d_revision);
            notifyStatus("Playlists", 0, 0, 5, 0, 0);
            d_playlistCursor = null;
            requestPlaylistPage();
        }

        function onPlaylistPage(responseCode, data) {
            if (d_cancelled) { return; }
            if (responseCode != 200 && retryMetadata(responseCode)) { return; }
            resetRetry();
            if (responseCode != 200) { responseFailure(responseCode, data, "Playlist fetch failed"); return; }
            var page = Protocol.parsePlaylistPage(data);
            if (page == null) { finishWithMessage("The companion returned an invalid playlist page."); return; }
            d_playlistPage = page;
            d_playlistIndex = 0;
            d_playlistCursor = page["nextCursor"];
            var playlistItems = page["items"];
            for (var pageIndex = 0; pageIndex < playlistItems.size(); ++pageIndex) {
                if (playlistItems[pageIndex]["trackCount"] instanceof Lang.Number) {
                    d_metadataTotalTracks += playlistItems[pageIndex]["trackCount"];
                }
            }
            processNextPlaylist();
        }

        function processNextPlaylist() {
            if (d_cancelled) { return; }
            var items = d_playlistPage["items"];
            if (d_playlistIndex >= items.size()) {
                if (d_playlistCursor != null) {
                    requestPlaylistPage();
                    return;
                }
                SyncStore.finishDesiredTraversal();
                // The final response may already have spent most of Garmin's
                // callback budget parsing and persisting its metadata page.
                // Yield before library-wide planning on the physical watch.
                scheduleWork(method(:finalizeMetadata));
                return;
            }
            d_currentPlaylist = items[d_playlistIndex];
            d_playlistIndex += 1;
            d_trackCursor = null;
            SyncStore.startDesiredPlaylist(d_currentPlaylist);
            requestTrackPage();
        }

        function finalizeMetadata() as Void {
            if (d_cancelled) { return; }
            d_workTimer = null;
            d_counts["deleted"] = SyncStore.obsoleteTrackCount();
            d_downloadIndex = 0;
            var trackTotal = BoundedList.size(SyncStore.DESIRED_TRACKS);
            var pendingTotal = BoundedList.size(SyncStore.DESIRED_PENDING_AUDIO);
            d_counts["reused"] = trackTotal - pendingTotal;
            updateDownloadProgress(trackTotal);
            if (!hasDownloadCapacity()) {
                d_counts["failed"] = missingTrackCount();
                addError("STORAGE_INSUFFICIENT");
                report("partial", "Not enough watch storage.");
                return;
            }
            d_timings.finishMetadata(System.getTimer());
            downloadNext();
        }

        function onTrackPage(responseCode, data) {
            if (d_cancelled) { return; }
            if (responseCode != 200 && retryMetadata(responseCode)) { return; }
            resetRetry();
            if (responseCode != 200) { responseFailure(responseCode, data, "Track fetch failed"); return; }
            var page = Protocol.parseTrackPage(data);
            if ((page == null) || !page["playlistId"].equals(d_currentPlaylist["id"])) {
                finishWithMessage("The companion returned an invalid track page.");
                return;
            }
            var items = page["items"];
            for (var idx = 0; idx < items.size(); ++idx) {
                var record = SyncStore.upsertDesiredTrack(items[idx], d_run);
                SyncStore.appendDesiredPlaylistTrack(d_currentPlaylist["id"], record["id"]);
            }
            d_metadataTracks += items.size();
            d_trackCursor = page["nextCursor"];
            var metadataPercentage = 5;
            if (d_metadataTotalTracks > 0) {
                metadataPercentage = 5 + ((25 * d_metadataTracks) / d_metadataTotalTracks).toNumber();
                if (metadataPercentage > 29) { metadataPercentage = 29; }
            }
            notifyStatus("Metadata", d_metadataTracks, d_metadataTotalTracks, metadataPercentage, 0, 0);
            if (d_trackCursor != null) {
                requestTrackPage();
                return;
            }
            processNextPlaylist();
        }

        function downloadNext() {
            if (d_cancelled) { return; }
            var total = BoundedList.size(SyncStore.DESIRED_PENDING_AUDIO);
            var skipped = false;
            while (d_downloadIndex < total) {
                var id = BoundedList.get(SyncStore.DESIRED_PENDING_AUDIO, d_downloadIndex);
                d_currentTrack = SyncStore.desiredTrack(id);
                if (!SyncStore.hasRef(d_currentTrack["refId"])) { break; }
                d_counts["reused"] += 1;
                d_downloadIndex += 1;
                skipped = true;
            }
            if (skipped) { updateDownloadProgress(BoundedList.size(SyncStore.DESIRED_TRACKS)); }
            if (d_downloadIndex >= total) {
                scheduleWork(method(:finishDownloads));
                return;
            }
            d_timings.startAudio(System.getTimer());
            var delegate = new AudioRequestDelegate(self, d_run, d_currentTrack["id"]);
            d_client.downloadAudio(
                d_currentTrack["downloadPath"],
                delegate.method(:onProgress),
                delegate.method(:onComplete)
            );
        }

        function isCurrentAudioRequest(run, trackId) {
            return !d_cancelled
                && (run == d_run)
                && (d_currentTrack instanceof Lang.Dictionary)
                && (d_currentTrack["id"] instanceof Lang.String)
                && d_currentTrack["id"].equals(trackId);
        }

        function onAudioFor(run, trackId, responseCode, data) {
            var downloaded = (responseCode == 200) && (data instanceof Media.ContentRef);
            if (!isCurrentAudioRequest(run, trackId)) {
                // Cancellation is advisory on Garmin: an old download can
                // still complete after stop() or after a new reconciliation
                // has reused this Reconciler. Its ContentRef belongs to no
                // active request and must be freed immediately.
                if (downloaded) { SyncStore.deleteAudioRef(data.getId()); }
                return;
            }
            d_timings.finishAudio(System.getTimer());
            if (downloaded) {
                if (SyncStore.saveDesiredRefForRun(trackId, run, data.getId())) {
                    d_counts["downloaded"] += 1;
                } else {
                    // A newer sync already discarded this track's desired
                    // record (its manifest revision changed while this
                    // download was still in flight, e.g. after a Wi-Fi drop
                    // and retry). No stored reference will ever point at the
                    // content this callback just received, so it must be
                    // freed here or it becomes permanently unreachable.
                    SyncStore.deleteAudioRef(data.getId());
                }
            } else {
                d_counts["failed"] += 1;
                addError(responseErrorCode(data, "TRANSCODE_FAILED"));
            }
            advanceDownload();
        }

        function advanceDownload() {
            d_downloadIndex += 1;
            updateDownloadProgress(BoundedList.size(SyncStore.DESIRED_TRACKS));
            if (d_timings.shouldCheckpoint(d_counts["downloaded"], d_lastCheckpointDownloaded)) {
                reportCheckpoint();
                return;
            }
            downloadNext();
        }

        function reportCheckpoint() {
            var result = {
                "protocolVersion" => Protocol.VERSION,
                "revision" => d_revision,
                "status" => "partial",
                "counts" => d_counts,
                "errorCodes" => d_errors,
                "timings" => d_timings.snapshot(System.getTimer())
            };
            d_lastCheckpointDownloaded = d_counts["downloaded"];
            d_client.reportSync(result, method(:onCheckpointReported));
        }

        function onCheckpointReported(responseCode, data) {
            if (d_cancelled) { return; }
            downloadNext();
        }

        function updateDownloadProgress(total) {
            if (total == 0) { notifyStatus("Audio", 0, 0, 95, 0, SyncStatus.missingArtworkCount()); return; }
            var pendingTotal = BoundedList.size(SyncStore.DESIRED_PENDING_AUDIO);
            var completed = total - pendingTotal + d_downloadIndex;
            var missingAudio = pendingTotal - d_downloadIndex;
            notifyStatus("Audio", completed, total,
                30 + ((65 * completed) / total).toNumber(), missingAudio, SyncStatus.missingArtworkCount());
        }

        function missingTrackCount() {
            return BoundedList.size(SyncStore.DESIRED_PENDING_AUDIO) - d_downloadIndex;
        }

        function hasDownloadCapacity() {
            var missing = missingTrackCount();
            if (missing == 0) { return true; }
            var profile = Application.Storage.getValue("syncandrun.profile");
            var bitrate = 96;
            if ((profile instanceof Lang.String) && profile.equals("compact")) { bitrate = 64; }
            else if ((profile instanceof Lang.String) && profile.equals("high")) { bitrate = 128; }
            var required = 0.0;
            for (var idx = d_downloadIndex; idx < BoundedList.size(SyncStore.DESIRED_PENDING_AUDIO); ++idx) {
                var track = SyncStore.desiredTrack(BoundedList.get(SyncStore.DESIRED_PENDING_AUDIO, idx));
                if (track instanceof Lang.Dictionary) {
                    required += track["durationSeconds"].toFloat() * bitrate.toFloat() * 131.25;
                }
            }
            var stats = Media.getCacheStatistics();
            if (!(stats.capacity instanceof Lang.Number) || (stats.capacity <= 0)) { return true; }
            return required <= (stats.capacity - stats.size).toFloat();
        }

        function onAudioProgressFor(run, trackId, transferred, size) {
            if (!isCurrentAudioRequest(run, trackId)) { return; }
            d_timings.audioProgress(System.getTimer(), transferred);
            if (!(size instanceof Lang.Number) || (size <= 0)) { return; }
            var total = BoundedList.size(SyncStore.DESIRED_TRACKS);
            if (total <= 0) { return; }
            var partial = transferred.toFloat() / size.toFloat();
            var reusedBeforeQueue = total - BoundedList.size(SyncStore.DESIRED_PENDING_AUDIO);
            notifyPercentage(30 + ((65 * (reusedBeforeQueue + d_downloadIndex + partial)) / total).toNumber());
        }

        function finishDownloads() {
            if (d_counts["failed"] > 0) {
                report("partial", "Some tracks could not be downloaded.");
                return;
            }
            // Make the complete audio library visible before optional artwork.
            // The applied revision is marked only after the best-effort phase,
            // so cancellation still causes a safe resumable traversal.
            SyncStore.commitDesiredContent();
            (new IPlayable()).removeRemoved();
            d_artworkIndex = 0;
            d_artworkCompleted = 0;
            d_artworkTotal = SyncStatus.missingArtworkCount();
            notifyStatus("Artwork", 0, d_artworkTotal, 95, 0, d_artworkTotal);
            downloadNextArtwork();
        }

        function downloadNextArtwork() {
            if (d_cancelled) { return; }
            var total = BoundedList.size(SyncStore.DESIRED_ARTWORKS);
            while (d_artworkIndex < total) {
                d_currentArtwork = SyncStore.desiredArtwork(d_artworkIndex);
                if ((d_currentArtwork instanceof Lang.Dictionary)
                    && (d_currentArtwork["id"] instanceof Lang.String)
                    && (d_currentArtwork["path"] instanceof Lang.String)
                    && !SyncStore.hasArtwork(d_currentArtwork["id"])) {
                    d_timings.startArtwork(System.getTimer());
                    d_client.downloadArtwork(d_currentArtwork["path"], method(:onArtwork));
                    return;
                }
                d_artworkIndex += 1;
            }
            finishArtwork();
        }

        function startArtworkBackfill(revision) {
            d_revision = revision;
            d_artworkIndex = 0;
            d_artworkCompleted = 0;
            d_artworkTotal = SyncStatus.missingArtworkCount();
            notifyStatus("Artwork", 0, d_artworkTotal, 95, 0, d_artworkTotal);
            downloadNextArtwork();
        }

        function onArtwork(responseCode, data) {
            if (d_cancelled) { return; }
            d_timings.finishArtwork(System.getTimer());
            if ((responseCode == 200) && (data != null)) {
                try {
                    SyncStore.saveArtwork(d_currentArtwork["id"], data);
                } catch (ex) {
                    // Artwork is optional; storage pressure must not make a
                    // complete audio sync partial or unusable.
                }
            } else {
                // Garmin may reject an image before sending the HTTP request.
                // Stop after the first failure so an optional artwork issue
                // cannot produce one system error dialog per album.
                finishArtwork();
                return;
            }
            advanceArtwork();
        }

        function finishArtwork() {
            SyncStore.markApplied(d_revision);
            notifyStatus("Reporting", 1, 1, 99, 0, 0);
            report("applied", null);
        }

        function advanceArtwork() {
            d_artworkIndex += 1;
            d_artworkCompleted += 1;
            if (d_artworkTotal > 0) {
                notifyStatus("Artwork", d_artworkCompleted, d_artworkTotal,
                    95 + ((4 * d_artworkCompleted) / d_artworkTotal).toNumber(),
                    0, d_artworkTotal - d_artworkCompleted);
            }
            downloadNextArtwork();
        }

        function report(status, message) {
            var result = {
                "protocolVersion" => Protocol.VERSION,
                "revision" => d_revision,
                "status" => status,
                "counts" => d_counts,
                "errorCodes" => d_errors,
                "timings" => d_timings.snapshot(System.getTimer())
            };
            Application.Storage.setValue("syncandrun.last_sync_summary", result);
            d_client.reportSync(result, method(:onReported));
            Application.Storage.setValue("syncandrun.pending_message", message);
        }

        function onReported(responseCode, data) {
            var message = Application.Storage.getValue("syncandrun.pending_message");
            Application.Storage.deleteValue("syncandrun.pending_message");
            if ((responseCode != 200) && (message == null)) { message = "Sync finished; result reporting failed."; }
            if (message == null) { finishSuccess(); }
            else { finishWithMessage(message); }
        }

        function responseFailure(responseCode, data, fallback) {
            var code = responseErrorCode(data, null);
            if ((code != null) && (code.equals("AUTH_REQUIRED") || code.equals("DEVICE_REVOKED"))) {
                State.clearPairing();
            }
            var message = code == null ? fallback : userMessage(code);
            if (d_revision instanceof Lang.String) {
                d_counts["failed"] += 1;
                addError(code == null ? "INTERNAL_ERROR" : code);
                report("partial", message);
            } else {
                finishWithMessage(message);
            }
        }

        function responseErrorCode(data, fallback) {
            var error = Protocol.parseError(data);
            return error == null ? fallback : error["code"];
        }

        function userMessage(code) {
            if (code.equals("DEVICE_REVOKED") || code.equals("AUTH_REQUIRED")) { return "Pair this watch again."; }
            if (code.equals("PAIRING_CODE_INVALID")) { return "Check the pairing code and try again."; }
            if (code.equals("PAIRING_CODE_EXPIRED")) { return "Create a new pairing code."; }
            if (code.equals("PROTOCOL_UNSUPPORTED")) { return "Update the companion or watch app."; }
            if (code.equals("PLEX_TOKEN_INVALID")) { return "Reconnect Plex in the companion."; }
            if (code.equals("PLEX_UNAVAILABLE")) { return "The Plex server is unavailable."; }
            if (code.equals("PLAYLIST_NOT_FOUND") || code.equals("TRACK_NOT_FOUND")) { return "Refresh playlists in the companion."; }
            if (code.equals("TRANSCODE_FAILED")) { return "Plex could not convert a track."; }
            if (code.equals("STORAGE_INSUFFICIENT")) { return "Not enough watch storage."; }
            if (code.equals("RATE_LIMITED")) { return "Wait a moment, then sync again."; }
            if (code.equals("INVALID_REQUEST")) { return "Update the companion or watch app."; }
            if (code.equals("INTERNAL_ERROR")) { return "The companion could not finish sync."; }
            return "Sync failed: " + code;
        }

        function requestConfig() {
            d_retryAction = method(:requestConfig);
            d_client.config(method(:onConfig));
        }

        function requestPlaylistPage() {
            d_retryAction = method(:requestPlaylistPage);
            d_client.playlists(d_playlistCursor, method(:onPlaylistPage));
        }

        function requestTrackPage() {
            d_retryAction = method(:requestTrackPage);
            d_client.tracks(d_currentPlaylist["id"], d_trackCursor, method(:onTrackPage));
        }

        function retryMetadata(responseCode) {
            var retryable = (responseCode < 0)
                || (responseCode == 429)
                || (responseCode == 500)
                || (responseCode == 502)
                || (responseCode == 503)
                || (responseCode == 504);
            if (!retryable || (d_retryCount >= 3) || (d_retryAction == null)) { return false; }
            d_retryCount += 1;
            var delay = d_retryCount == 1 ? 1000 : (d_retryCount == 2 ? 2000 : 4000);
            d_retryTimer = new Timer.Timer();
            d_retryTimer.start(method(:onRetryTimer), delay, false);
            return true;
        }

        function onRetryTimer() as Void {
            if (!d_cancelled && (d_retryAction != null)) { d_retryAction.invoke(); }
        }

        function resetRetry() {
            if (d_retryTimer != null) { d_retryTimer.stop(); }
            d_retryTimer = null;
            d_retryCount = 0;
        }

        function scheduleWork(action) {
            resetWorkTimer();
            d_workTimer = new Timer.Timer();
            d_workTimer.start(action, 50, false);
        }

        function resetWorkTimer() {
            if (d_workTimer != null) { d_workTimer.stop(); }
            d_workTimer = null;
        }

        function addError(code) {
            if (!(code instanceof Lang.String) || (d_errors.size() >= 10)) { return; }
            for (var idx = 0; idx < d_errors.size(); ++idx) {
                if (d_errors[idx].equals(code)) { return; }
            }
            d_errors.add(code);
        }

        function finishSuccess() {
            var total = d_counts["downloaded"] + d_counts["reused"];
            notifyStatus("Done", total, total, 100, 0, 0);
            d_notifyComplete.invoke(null);
        }

        function finishWithMessage(message) {
            SyncStatus.update("Stopped", 0, 0, d_lastPercentage, null, d_counts);
            d_notifyComplete.invoke(message);
        }

        function notifyStatus(phase, current, total, percentage, audioRemaining, artworkRemaining) {
            var eta = d_timings.estimateRemainingSeconds(audioRemaining, artworkRemaining);
            if (eta == null) { eta = SyncStatus.estimateFromLast(audioRemaining, artworkRemaining); }
            SyncStatus.update(phase, current, total, percentage, eta, d_counts);
            notifyPercentage(percentage);
        }

        function notifyPercentage(percentage) {
            if (percentage < d_lastPercentage) { percentage = d_lastPercentage; }
            if (percentage > 100) { percentage = 100; }
            d_lastPercentage = percentage;
            d_notifyProgress.invoke(percentage);
        }
    }
}
