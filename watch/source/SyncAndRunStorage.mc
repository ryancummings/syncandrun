using Toybox.Application;
using Toybox.Lang;
using Toybox.Media;

module SyncAndRun {
    module BoundedList {
        const CHUNK_SIZE = 25;

        function clear(prefix) {
            var meta = Application.Storage.getValue(prefix + ".meta");
            if (meta instanceof Lang.Dictionary) {
                var chunks = meta["chunks"];
                if (chunks instanceof Lang.Number) {
                    for (var idx = 0; idx < chunks; ++idx) {
                        Application.Storage.deleteValue(prefix + "." + idx.toString());
                    }
                }
            }
            Application.Storage.deleteValue(prefix + ".meta");
        }

        function append(prefix, value) {
            var meta = Application.Storage.getValue(prefix + ".meta");
            if (!(meta instanceof Lang.Dictionary)) { meta = { "count" => 0, "chunks" => 0 }; }
            var count = meta["count"];
            var chunkIndex = (count / CHUNK_SIZE).toNumber();
            var chunk = Application.Storage.getValue(prefix + "." + chunkIndex.toString());
            if (!(chunk instanceof Lang.Array)) { chunk = []; }
            chunk.add(value);
            Application.Storage.setValue(prefix + "." + chunkIndex.toString(), chunk);
            meta["count"] = count + 1;
            meta["chunks"] = chunkIndex + 1;
            Application.Storage.setValue(prefix + ".meta", meta);
        }

        function replace(prefix, values) {
            clear(prefix);
            if (!(values instanceof Lang.Array) || (values.size() == 0)) { return; }
            var chunks = ((values.size() + CHUNK_SIZE - 1) / CHUNK_SIZE).toNumber();
            for (var chunkIndex = 0; chunkIndex < chunks; ++chunkIndex) {
                var first = chunkIndex * CHUNK_SIZE;
                var last = first + CHUNK_SIZE;
                if (last > values.size()) { last = values.size(); }
                Application.Storage.setValue(prefix + "." + chunkIndex.toString(), values.slice(first, last));
            }
            Application.Storage.setValue(prefix + ".meta", { "count" => values.size(), "chunks" => chunks });
        }

        function toArray(prefix) {
            var meta = Application.Storage.getValue(prefix + ".meta");
            if (!(meta instanceof Lang.Dictionary)) { return []; }
            var count = meta["count"];
            var chunks = meta["chunks"];
            if (!(count instanceof Lang.Number) || !(chunks instanceof Lang.Number) || (count <= 0)) { return []; }
            var result = [];
            for (var chunkIndex = 0; chunkIndex < chunks; ++chunkIndex) {
                var chunk = Application.Storage.getValue(prefix + "." + chunkIndex.toString());
                if (chunk instanceof Lang.Array) { result.addAll(chunk); }
            }
            if (result.size() > count) { return result.slice(0, count); }
            return result;
        }

        function size(prefix) {
            var meta = Application.Storage.getValue(prefix + ".meta");
            return (meta instanceof Lang.Dictionary) ? meta["count"] : 0;
        }

        function get(prefix, index) {
            if ((index < 0) || (index >= size(prefix))) { return null; }
            var chunkIndex = (index / CHUNK_SIZE).toNumber();
            var offset = index % CHUNK_SIZE;
            var chunk = Application.Storage.getValue(prefix + "." + chunkIndex.toString());
            if (!(chunk instanceof Lang.Array) || (offset >= chunk.size())) { return null; }
            return chunk[offset];
        }

        function contains(prefix, value) {
            for (var idx = 0; idx < size(prefix); ++idx) {
                var candidate = get(prefix, idx);
                if ((candidate == value)
                    || ((candidate instanceof Lang.String) && candidate.equals(value))) { return true; }
            }
            return false;
        }

        function arrayContains(values, value) {
            if (!(values instanceof Lang.Array)) { return false; }
            for (var idx = 0; idx < values.size(); ++idx) {
                var candidate = values[idx];
                if ((candidate == value)
                    || ((candidate instanceof Lang.String) && candidate.equals(value))) { return true; }
            }
            return false;
        }

        function toSet(values) {
            var result = {};
            if (!(values instanceof Lang.Array)) { return result; }
            for (var idx = 0; idx < values.size(); ++idx) {
                result[values[idx]] = true;
            }
            return result;
        }

        function setContains(values, value) {
            return (values instanceof Lang.Dictionary) && (values[value] == true);
        }
    }

    module SyncStore {
        const ACTIVE_PLAYLISTS = "syncandrun.active.playlists";
        const ACTIVE_TRACKS = "syncandrun.active.tracks";
        const ACTIVE_ARTWORKS = "syncandrun.active.artworks";
        const DESIRED_PLAYLISTS = "syncandrun.desired.playlists";
        const DESIRED_TRACKS = "syncandrun.desired.tracks";
        const DESIRED_PENDING_AUDIO = "syncandrun.desired.pending_audio";
        const DESIRED_PENDING_AUDIO_READY = "syncandrun.desired.pending_audio.ready";
        const DESIRED_ARTWORKS = "syncandrun.desired.artworks";
        const DESIRED_REVISION = "syncandrun.desired.store_revision";
        const DESIRED_RUN = "syncandrun.desired.run";

        function activeTrackKey(id) { return "syncandrun.track." + id; }
        function desiredTrackKey(id) { return "syncandrun.desired.track." + id; }
        function activePlaylistKey(id) { return "syncandrun.playlist." + id; }
        function desiredPlaylistKey(id) { return "syncandrun.desired.playlist." + id; }
        function activePlaylistTracks(id) { return activePlaylistKey(id) + ".tracks"; }
        function desiredPlaylistTracks(id) { return desiredPlaylistKey(id) + ".tracks"; }
        function artworkKey(id) { return "syncandrun.artwork." + id; }
        function desiredArtworkMetaKey(id) { return "syncandrun.desired.artwork.meta." + id; }

        function hasRef(refId) { return refId != null; }

        function sameRef(left, right) {
            if (left == right) { return true; }
            return (left instanceof Lang.String)
                && (right instanceof Lang.String)
                && left.equals(right);
        }

        function deleteAudioRef(refId) {
            if (!hasRef(refId)) { return; }
            try {
                Media.deleteCachedItem(new Media.ContentRef(refId, Media.CONTENT_TYPE_AUDIO));
            } catch (ex) {
                // A stale Garmin cache reference is equivalent to already
                // deleted content and must not prevent metadata reconciliation.
            }
        }

        function beginDesired(revision) {
            var previous = Application.Storage.getValue(DESIRED_REVISION);
            var sameRevision = (previous instanceof Lang.String) && previous.equals(revision);
            if (!sameRevision) { clearDesiredRecords(); }
            for (var idx = 0; idx < BoundedList.size(DESIRED_PLAYLISTS); ++idx) {
                BoundedList.clear(desiredPlaylistTracks(BoundedList.get(DESIRED_PLAYLISTS, idx)));
            }
            BoundedList.clear(DESIRED_PLAYLISTS);
            BoundedList.clear(DESIRED_TRACKS);
            BoundedList.clear(DESIRED_PENDING_AUDIO);
            Application.Storage.deleteValue(DESIRED_PENDING_AUDIO_READY);
            clearDesiredArtworkRecords();
            var run = Application.Storage.getValue(DESIRED_RUN);
            if (!(run instanceof Lang.Number)) { run = 0; }
            run += 1;
            Application.Storage.setValue(DESIRED_RUN, run);
            Application.Storage.setValue(DESIRED_REVISION, revision);
            return run;
        }

        function finishDesiredTraversal() {
            Application.Storage.setValue(DESIRED_PENDING_AUDIO_READY, true);
        }

        function pendingAudioReady() {
            return Application.Storage.getValue(DESIRED_PENDING_AUDIO_READY) == true;
        }

        function startDesiredPlaylist(playlist) {
            var id = playlist["id"];
            BoundedList.append(DESIRED_PLAYLISTS, id);
            BoundedList.clear(desiredPlaylistTracks(id));
            Application.Storage.setValue(desiredPlaylistKey(id), playlist);
        }

        function appendDesiredPlaylistTrack(playlistId, trackId) {
            BoundedList.append(desiredPlaylistTracks(playlistId), trackId);
        }

        function upsertDesiredTrack(track, run) {
            var id = track["id"];
            var existing = Application.Storage.getValue(desiredTrackKey(id));
            var firstThisRun = !(existing instanceof Lang.Dictionary) || (existing["seenRun"] != run);
            var refId = null;
            if ((existing instanceof Lang.Dictionary)
                && (existing["contentFingerprint"] instanceof Lang.String)
                && existing["contentFingerprint"].equals(track["contentFingerprint"])) {
                refId = existing["refId"];
            } else {
                var active = Application.Storage.getValue(activeTrackKey(id));
                if ((active instanceof Lang.Dictionary)
                    && (active["contentFingerprint"] instanceof Lang.String)
                    && active["contentFingerprint"].equals(track["contentFingerprint"])) {
                    refId = active["refId"];
                }
            }
            var refCount = 1;
            if (!firstThisRun) { refCount = (existing as Lang.Dictionary)["refCount"] + 1; }
            var artworkId = track["artworkId"];
            if ((artworkId instanceof Lang.String) && !BoundedList.contains(DESIRED_ARTWORKS, artworkId)) {
                BoundedList.append(DESIRED_ARTWORKS, artworkId);
                Application.Storage.setValue(desiredArtworkMetaKey(artworkId), {
                    "id" => artworkId,
                    "path" => track["artworkPath"]
                });
            }
            var record = {
                "id" => id,
                "contentFingerprint" => track["contentFingerprint"],
                "title" => track["title"],
                "artist" => track["artist"],
                "album" => track["album"],
                "durationSeconds" => track["durationSeconds"],
                "downloadPath" => track["downloadPath"],
                "artworkId" => artworkId,
                "artworkPath" => track["artworkPath"],
                "refId" => refId,
                "refCount" => refCount,
                "seenRun" => run
            };
            Application.Storage.setValue(desiredTrackKey(id), record);
            if (firstThisRun) {
                BoundedList.append(DESIRED_TRACKS, id);
                if (!hasRef(refId)) { BoundedList.append(DESIRED_PENDING_AUDIO, id); }
            }
            return record;
        }

        function desiredTrack(id) { return Application.Storage.getValue(desiredTrackKey(id)); }

        function saveDesiredRef(id, refId) {
            var record = desiredTrack(id);
            if (!(record instanceof Lang.Dictionary)) { return false; }
            record["refId"] = refId;
            Application.Storage.setValue(desiredTrackKey(id), record);
            return true;
        }

        function saveDesiredRefForRun(id, run, refId) {
            var record = desiredTrack(id);
            if (!(record instanceof Lang.Dictionary) || (record["seenRun"] != run)) { return false; }
            record["refId"] = refId;
            Application.Storage.setValue(desiredTrackKey(id), record);
            return true;
        }

        function desiredArtwork(index) {
            var id = BoundedList.get(DESIRED_ARTWORKS, index);
            return id == null ? null : Application.Storage.getValue(desiredArtworkMetaKey(id));
        }

        function hasArtwork(id) {
            return (id instanceof Lang.String) && (Application.Storage.getValue(artworkKey(id)) != null);
        }

        function saveArtwork(id, artwork) {
            if (!(id instanceof Lang.String) || (artwork == null)) { return false; }
            Application.Storage.setValue(artworkKey(id), artwork);
            return true;
        }

        function obsoleteTrackCount() {
            var count = 0;
            var activeTracks = BoundedList.toArray(ACTIVE_TRACKS);
            var desiredTracks = BoundedList.toSet(BoundedList.toArray(DESIRED_TRACKS));
            for (var idx = 0; idx < activeTracks.size(); ++idx) {
                if (!BoundedList.setContains(desiredTracks, activeTracks[idx])) { count += 1; }
            }
            return count;
        }

        function commitDesiredContent() {
            var oldTracks = BoundedList.toArray(ACTIVE_TRACKS);
            var desiredTracks = BoundedList.toArray(DESIRED_TRACKS);
            var desiredTrackSet = BoundedList.toSet(desiredTracks);
            for (var idx = 0; idx < oldTracks.size(); ++idx) {
                var id = oldTracks[idx];
                if (BoundedList.setContains(desiredTrackSet, id)) { continue; }
                var old = Application.Storage.getValue(activeTrackKey(id));
                if ((old instanceof Lang.Dictionary) && hasRef(old["refId"])) {
                    deleteAudioRef(old["refId"]);
                }
                // Remove keys written by the original per-track artwork store.
                Application.Storage.deleteValue(artworkKey(id));
                Application.Storage.deleteValue(activeTrackKey(id));
            }

            var activePlaylists = BoundedList.toArray(ACTIVE_PLAYLISTS);
            var desiredPlaylists = BoundedList.toArray(DESIRED_PLAYLISTS);
            var desiredPlaylistSet = BoundedList.toSet(desiredPlaylists);
            for (var idx = 0; idx < activePlaylists.size(); ++idx) {
                var id = activePlaylists[idx];
                if (!BoundedList.setContains(desiredPlaylistSet, id)) {
                    BoundedList.clear(activePlaylistTracks(id));
                    Application.Storage.deleteValue(activePlaylistKey(id));
                }
            }

            for (var idx = 0; idx < desiredTracks.size(); ++idx) {
                var id = desiredTracks[idx];
                var desired = desiredTrack(id);
                var previous = Application.Storage.getValue(activeTrackKey(id));
                if ((previous instanceof Lang.Dictionary)
                    && hasRef(previous["refId"])
                    && hasRef(desired["refId"])
                    && !sameRef(previous["refId"], desired["refId"])) {
                    deleteAudioRef(previous["refId"]);
                }
                Application.Storage.deleteValue(artworkKey(id));
                Application.Storage.setValue(activeTrackKey(id), desired);
            }
            BoundedList.replace(ACTIVE_TRACKS, desiredTracks);

            var activeArtworks = BoundedList.toArray(ACTIVE_ARTWORKS);
            var desiredArtworks = BoundedList.toArray(DESIRED_ARTWORKS);
            var desiredArtworkSet = BoundedList.toSet(desiredArtworks);
            for (var idx = 0; idx < activeArtworks.size(); ++idx) {
                var artworkId = activeArtworks[idx];
                if (!BoundedList.setContains(desiredArtworkSet, artworkId)) {
                    Application.Storage.deleteValue(artworkKey(artworkId));
                }
            }
            BoundedList.replace(ACTIVE_ARTWORKS, desiredArtworks);

            for (var idx = 0; idx < desiredPlaylists.size(); ++idx) {
                var id = desiredPlaylists[idx];
                Application.Storage.setValue(activePlaylistKey(id), Application.Storage.getValue(desiredPlaylistKey(id)));
                var source = desiredPlaylistTracks(id);
                BoundedList.replace(activePlaylistTracks(id), BoundedList.toArray(source));
            }
            BoundedList.replace(ACTIVE_PLAYLISTS, desiredPlaylists);
        }

        function markApplied(revision) {
            Application.Storage.setValue(State.APPLIED_REVISION, revision);
            Report.syncApplied();
        }

        function commitDesired(revision) {
            commitDesiredContent();
            markApplied(revision);
        }

        function clearDesiredRecords() {
            for (var idx = 0; idx < BoundedList.size(DESIRED_TRACKS); ++idx) {
                var id = BoundedList.get(DESIRED_TRACKS, idx);
                var desired = Application.Storage.getValue(desiredTrackKey(id));
                var active = Application.Storage.getValue(activeTrackKey(id));
                if ((desired instanceof Lang.Dictionary) && hasRef(desired["refId"])) {
                    var keep = (active instanceof Lang.Dictionary)
                        && hasRef(active["refId"])
                        && sameRef(active["refId"], desired["refId"]);
                    if (!keep) { deleteAudioRef(desired["refId"]); }
                }
                Application.Storage.deleteValue(desiredTrackKey(id));
            }
            for (var idx = 0; idx < BoundedList.size(DESIRED_PLAYLISTS); ++idx) {
                var id = BoundedList.get(DESIRED_PLAYLISTS, idx);
                BoundedList.clear(desiredPlaylistTracks(id));
                Application.Storage.deleteValue(desiredPlaylistKey(id));
            }
            BoundedList.clear(DESIRED_TRACKS);
            BoundedList.clear(DESIRED_PENDING_AUDIO);
            Application.Storage.deleteValue(DESIRED_PENDING_AUDIO_READY);
            BoundedList.clear(DESIRED_PLAYLISTS);
            clearDesiredArtworkRecords();
        }

        function clearDesiredArtworkRecords() {
            for (var idx = 0; idx < BoundedList.size(DESIRED_ARTWORKS); ++idx) {
                Application.Storage.deleteValue(desiredArtworkMetaKey(BoundedList.get(DESIRED_ARTWORKS, idx)));
            }
            BoundedList.clear(DESIRED_ARTWORKS);
        }
    }
}
