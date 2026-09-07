using Toybox.Application;
using Toybox.Communications;
using Toybox.Lang;
using Toybox.Media;
using Toybox.System;

module SyncAndRun {
    module Protocol {
        const VERSION = 1;
        const PAGE_SIZE = 10;

        function validString(value, maximum) {
            return (value instanceof Lang.String) && (value.length() <= maximum);
        }

        function validRevision(value) {
            if (!validString(value, 64) || (value.length() != 64)) { return false; }
            var allowed = "abcdef0123456789";
            for (var idx = 0; idx < value.length(); ++idx) {
                if (allowed.find(value.substring(idx, idx + 1)) == null) { return false; }
            }
            return true;
        }

        function parsePair(data) {
            if (!(data instanceof Lang.Dictionary)) { return null; }
            if (data["protocolVersion"] != VERSION) { return null; }
            if (!validString(data["deviceToken"], 160) || (data["deviceToken"].length() < 32)) { return null; }
            if (!validString(data["companionId"], 96)) { return null; }
            if (!validRevision(data["manifestRevision"])) { return null; }
            return data;
        }

        function parseConfig(data) {
            if (!(data instanceof Lang.Dictionary)) { return null; }
            if (data["protocolVersion"] != VERSION) { return null; }
            if (!validRevision(data["manifestRevision"])) { return null; }
            var profile = data["transcodeProfile"];
            if (!(profile instanceof Lang.String)) { return null; }
            if (!profile.equals("compact") && !profile.equals("balanced") && !profile.equals("high")) { return null; }
            if (data["pageSize"] != PAGE_SIZE) { return null; }
            if (!validString(data["serverTime"], 40)) { return null; }
            return data;
        }

        function parsePlaylistPage(data) {
            if (!validPage(data)) { return null; }
            var items = data["items"];
            for (var idx = 0; idx < items.size(); ++idx) {
                var item = items[idx];
                if (!(item instanceof Lang.Dictionary)) { return null; }
                if (!validString(item["id"], 96) || !validString(item["name"], 80)) { return null; }
                if (!validRevision(item["revision"])) { return null; }
                if (!(item["trackCount"] instanceof Lang.Number) || (item["trackCount"] < 0)) { return null; }
                if (!(item["durationSeconds"] instanceof Lang.Number) || (item["durationSeconds"] < 0)) { return null; }
                if (!validWatchPath(item["tracksPath"])) { return null; }
            }
            return data;
        }

        function parseTrackPage(data) {
            if (!validPage(data) || !validString(data["playlistId"], 96)) { return null; }
            var items = data["items"];
            for (var idx = 0; idx < items.size(); ++idx) {
                var item = items[idx];
                if (!(item instanceof Lang.Dictionary)) { return null; }
                if (!validString(item["id"], 96) || !validRevision(item["contentFingerprint"])) { return null; }
                if (!validString(item["title"], 80) || !validString(item["artist"], 80) || !validString(item["album"], 80)) { return null; }
                if (!(item["durationSeconds"] instanceof Lang.Number) || (item["durationSeconds"] < 0)) { return null; }
                if (!validWatchPath(item["downloadPath"])) { return null; }
                if ((item["artworkId"] != null) && !validString(item["artworkId"], 32)) { return null; }
                if ((item["artworkPath"] != null) && !validArtworkLocation(item["artworkPath"])) { return null; }
                if ((item["artworkId"] == null) != (item["artworkPath"] == null)) { return null; }
            }
            return data;
        }

        function parseError(data) {
            if (!(data instanceof Lang.Dictionary) || !(data["error"] instanceof Lang.Dictionary)) { return null; }
            var error = data["error"];
            if (!validString(error["code"], 40) || !validString(error["message"], 160)) { return null; }
            if (!(error["retryable"] instanceof Lang.Boolean) || !validString(error["requestId"], 32)) { return null; }
            return error;
        }

        function validPage(data) {
            if (!(data instanceof Lang.Dictionary) || (data["protocolVersion"] != VERSION)) { return false; }
            var items = data["items"];
            if (!(items instanceof Lang.Array) || (items.size() > PAGE_SIZE)) { return false; }
            return (data["nextCursor"] == null) || validString(data["nextCursor"], 160);
        }

        function validWatchPath(value) {
            return validString(value, 180)
                && (value.length() >= 14)
                && value.substring(0, 14).equals("/api/v1/watch/");
        }

        function validArtworkLocation(value) {
            if (validString(value, 320)
                && (value.length() >= 16)
                && value.substring(0, 16).equals("/api/v1/watch/a/")) { return true; }
            if (!validString(value, 320) || (value.length() < 24) || !value.substring(0, 8).equals("https://")) {
                return false;
            }
            var path = value.find("/api/v1/watch/a/");
            if ((path == null) || (path < 9)) { return false; }
            var authority = value.substring(8, path);
            return (authority.length() > 0)
                && (authority.find(":") == null)
                && (authority.find("@") == null)
                && (value.find("?") == null)
                && (value.find("#") == null);
        }
    }

    module State {
        const DEVICE_TOKEN = "syncandrun.device_token";
        const COMPANION_ID = "syncandrun.companion_id";
        const DEVICE_ID = "syncandrun.device_id";
        const DESIRED_REVISION = "syncandrun.desired_revision";
        const APPLIED_REVISION = "syncandrun.applied_revision";

        function deviceId() {
            var id = Application.Storage.getValue(DEVICE_ID);
            if (id instanceof Lang.String) { return id; }
            id = "watch:" + System.getDeviceSettings().uniqueIdentifier;
            Application.Storage.setValue(DEVICE_ID, id);
            return id;
        }

        function token() { return Application.Storage.getValue(DEVICE_TOKEN); }

        function savePairing(pair) {
            Application.Storage.setValue(DEVICE_TOKEN, pair["deviceToken"]);
            Application.Storage.setValue(COMPANION_ID, pair["companionId"]);
            Application.Storage.setValue(DESIRED_REVISION, pair["manifestRevision"]);
            Report.pairing(true);
            // A pairing code is single-use; clear both entry paths so a spent
            // code cannot be replayed and the menu stops offering it.
            clearPairingCode();
        }

        function clearPairing() {
            Application.Storage.deleteValue(DEVICE_TOKEN);
            Application.Storage.deleteValue(COMPANION_ID);
            Application.Storage.deleteValue(DESIRED_REVISION);
            Application.Storage.deleteValue(APPLIED_REVISION);
            Report.pairing(false);
        }
    }

    class Client {
        private var d_origin;

        function initialize() {
            d_origin = CompanionOrigin.current();
        }

        function validOrigin() {
            // current() already validates and normalizes both supported schemes.
            return d_origin instanceof Lang.String;
        }

        function pair(code, callback) {
            var parameters = {
                "code" => code,
                "deviceId" => State.deviceId(),
                "deviceName" => System.getDeviceSettings().partNumber,
                "appVersion" => "1.0.0",
                "protocolVersion" => Protocol.VERSION
            };
            request("/api/v1/watch/pair", parameters, Communications.HTTP_REQUEST_METHOD_POST, false, callback);
        }

        function health(callback) {
            var options = {
                :method => Communications.HTTP_REQUEST_METHOD_GET,
                :headers => { "Accept" => "application/json" },
                :responseType => Communications.HTTP_RESPONSE_CONTENT_TYPE_JSON
            };
            Communications.makeWebRequest(d_origin + "/health/ready", {}, options, callback);
        }

        function config(callback) {
            var requestHeaders = headers(true, false);
            var applied = Application.Storage.getValue(State.APPLIED_REVISION);
            // An incomplete artwork set needs fresh expiring capabilities even
            // when the audio/content revision itself has not changed.
            if ((applied instanceof Lang.String) && (SyncStatus.missingArtworkCount() == 0)) {
                requestHeaders.put("If-None-Match", "\"" + applied + "\"");
            }
            var options = {
                :method => Communications.HTTP_REQUEST_METHOD_GET,
                :headers => requestHeaders,
                :responseType => Communications.HTTP_RESPONSE_CONTENT_TYPE_JSON
            };
            Communications.makeWebRequest(d_origin + "/api/v1/watch/config", {}, options, callback);
        }

        function playlists(cursor, callback) {
            var parameters = {};
            if (cursor != null) { parameters.put("cursor", cursor); }
            request("/api/v1/watch/playlists", parameters, Communications.HTTP_REQUEST_METHOD_GET, true, callback);
        }

        function tracks(playlistId, cursor, callback) {
            var parameters = {};
            if (cursor != null) { parameters.put("cursor", cursor); }
            var path = "/api/v1/watch/playlists/" + Communications.encodeURL(playlistId) + "/tracks";
            request(path, parameters, Communications.HTTP_REQUEST_METHOD_GET, true, callback);
        }

        function reportSync(result, callback) {
            request("/api/v1/watch/sync-result", result, Communications.HTTP_REQUEST_METHOD_POST, true, callback);
        }

        function downloadAudio(path, progress, callback) {
            var options = {
                :method => Communications.HTTP_REQUEST_METHOD_GET,
                :headers => headers(true, false),
                :responseType => Communications.HTTP_RESPONSE_CONTENT_TYPE_AUDIO,
                :mediaEncoding => Media.ENCODING_MP3,
                :fileDownloadProgressCallback => progress
            };
            Communications.makeWebRequest(d_origin + path, {}, options, callback);
        }

        function downloadArtwork(path, callback) {
            var options = {
                :maxWidth => 80,
                :maxHeight => 80,
                :dithering => Communications.IMAGE_DITHERING_NONE
            };
            var location = path;
            if (!(path instanceof Lang.String) || (path.length() < 8) || !path.substring(0, 8).equals("https://")) {
                location = d_origin + path;
            }
            Communications.makeImageRequest(location, {}, options, callback);
        }

        function request(path, parameters, method, authenticated, callback) {
            var options = {
                :method => method,
                :headers => headers(authenticated, method == Communications.HTTP_REQUEST_METHOD_POST),
                :responseType => Communications.HTTP_RESPONSE_CONTENT_TYPE_JSON
            };
            Communications.makeWebRequest(d_origin + path, parameters, options, callback);
        }

        function headers(authenticated, jsonBody) {
            var result = { "Accept" => "application/json" };
            if (jsonBody) { result.put("Content-Type", Communications.REQUEST_CONTENT_TYPE_JSON); }
            if (authenticated) {
                var token = State.token();
                if (token instanceof Lang.String) { result.put("Authorization", "Bearer " + token); }
            }
            return result;
        }
    }
}
