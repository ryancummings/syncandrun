using Toybox.Application;
using Toybox.Lang;
using Toybox.Time;
using Toybox.Time.Gregorian;

module SyncAndRun {
    module SyncStatus {
        const KEY = "syncandrun.sync_status";

        function startMessage() {
            var total = BoundedList.size(SyncStore.DESIRED_TRACKS);
            var missingAudio = missingAudioCount();
            var missingArtwork = missingArtworkCount();
            if ((total > 0) && (missingAudio > 0)) {
                var resume = "Resume " + countLabel(missingAudio, "audio track");
                if (missingArtwork > 0) {
                    resume += " + " + countLabel(missingArtwork, "artwork");
                }
                return withEta(resume, estimateFromLast(missingAudio, missingArtwork));
            }
            if (missingArtwork > 0) {
                var applied = Application.Storage.getValue(State.APPLIED_REVISION);
                var desired = Application.Storage.getValue(State.DESIRED_REVISION);
                var artwork = countLabel(missingArtwork, "artwork");
                if ((applied instanceof Lang.String) && (desired instanceof Lang.String)
                    && applied.equals(desired)) {
                    return withEta("Syncing " + artwork, estimateFromLast(0, missingArtwork));
                }
                return withEta("Checking library + " + artwork, estimateFromLast(0, missingArtwork));
            }
            var active = BoundedList.size(SyncStore.ACTIVE_TRACKS);
            if (active > 0) { return "Checking " + countLabel(active, "cached track"); }
            return "Preparing library";
        }

        function countLabel(count, singular) {
            return count.toString() + " " + singular + (count == 1 ? "" : "s");
        }

        function withEta(value, etaSeconds) {
            if ((etaSeconds instanceof Lang.Number) && (etaSeconds >= 10)) {
                value += " | " + formatEta(etaSeconds);
            }
            if (value.length() > 60) { return value.substring(0, 60); }
            return value;
        }

        function update(phase, current, total, percentage, etaSeconds, counts) {
            var label = format(phase, current, total, etaSeconds);
            Application.Storage.setValue(KEY, {
                "phase" => phase,
                "current" => current,
                "total" => total,
                "percentage" => percentage,
                "etaSeconds" => etaSeconds,
                "counts" => counts,
                "label" => label
            });
            return label;
        }

        function label() {
            var status = Application.Storage.getValue(KEY);
            if ((status instanceof Lang.Dictionary) && (status["label"] instanceof Lang.String)) {
                return status["label"];
            }
            return "Ready";
        }

        function format(phase, current, total, etaSeconds) {
            var value = phase;
            if ((total instanceof Lang.Number) && (total > 0)) {
                value += " " + current.toString() + "/" + total.toString();
            }
            if ((etaSeconds instanceof Lang.Number) && (etaSeconds >= 10)) {
                value += " | " + formatEta(etaSeconds);
            }
            if (value.length() > 60) { return value.substring(0, 60); }
            return value;
        }

        function formatEta(seconds) {
            if (seconds < 60) { return "~" + seconds.toString() + "s"; }
            return "~" + ((seconds + 59) / 60).toNumber().toString() + "m";
        }

        function estimateFromLast(audioRemaining, artworkRemaining) {
            var summary = Application.Storage.getValue("syncandrun.last_sync_summary");
            if (!(summary instanceof Lang.Dictionary) || !(summary["timings"] instanceof Lang.Dictionary)) {
                return null;
            }
            var timings = summary["timings"] as Lang.Dictionary;
            var milliseconds = 0;
            var stable = false;
            if ((audioRemaining > 0) && (timings["audioCount"] instanceof Lang.Number)
                && (timings["audioCount"] >= 2) && (timings["audioTotalMs"] instanceof Lang.Number)) {
                milliseconds += audioRemaining * timings["audioTotalMs"] / timings["audioCount"];
                stable = true;
            }
            if ((artworkRemaining > 0) && (timings["artworkCount"] instanceof Lang.Number)
                && (timings["artworkCount"] >= 2) && (timings["artworkMs"] instanceof Lang.Number)) {
                milliseconds += artworkRemaining * timings["artworkMs"] / timings["artworkCount"];
                stable = true;
            }
            if (!stable) { return null; }
            return ((milliseconds + 999) / 1000).toNumber();
        }

        function missingAudioCount() {
            var count = 0;
            var source = SyncStore.pendingAudioReady()
                ? SyncStore.DESIRED_PENDING_AUDIO
                : SyncStore.DESIRED_TRACKS;
            for (var idx = 0; idx < BoundedList.size(source); ++idx) {
                var record = SyncStore.desiredTrack(BoundedList.get(source, idx));
                if ((record instanceof Lang.Dictionary) && !SyncStore.hasRef(record["refId"])) { count += 1; }
            }
            return count;
        }

        function missingArtworkCount() {
            var count = 0;
            for (var idx = 0; idx < BoundedList.size(SyncStore.DESIRED_ARTWORKS); ++idx) {
                var artwork = SyncStore.desiredArtwork(idx);
                if ((artwork instanceof Lang.Dictionary) && !SyncStore.hasArtwork(artwork["id"])) { count += 1; }
            }
            return count;
        }
    }

    /*
     * Writes the two readonly settings the phone shows beside the editable
     * fields. Connect IQ has no informational control, so state is reported
     * through ordinary properties that settings.xml marks readonly.
     */
    module Report {
        const PAIRING = "pairing_status";
        const LAST_SYNC = "last_sync";

        function pairing(paired) {
            Application.Properties.setValue(PAIRING, paired ? "Paired" : "Not paired");
        }

        function syncApplied() {
            Application.Properties.setValue(LAST_SYNC, stamp(Time.now()));
        }

        // ISO-like and locale-free: this is read on a phone in any region, and
        // an ambiguous 08/09 would be worse than useless for support.
        function stamp(moment) {
            var at = Gregorian.info(moment, Time.FORMAT_SHORT);
            return Lang.format("$1$-$2$-$3$ $4$:$5$", [
                at.year.format("%04d"),
                at.month.format("%02d"),
                at.day.format("%02d"),
                at.hour.format("%02d"),
                at.min.format("%02d")
            ]);
        }
    }
}
