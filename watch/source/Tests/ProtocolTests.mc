using Toybox.Test;

module ProtocolTests {
    const REVISION = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    function playlist(index) {
        return {
            "id" => "plex:playlist:" + index.toString(),
            "name" => "Fixture Playlist " + index.toString(),
            "revision" => REVISION,
            "trackCount" => index,
            "durationSeconds" => index * 120,
            "tracksPath" => "/api/v1/watch/playlists/fixture/tracks"
        };
    }

    function track(index) {
        return {
            "id" => "plex:track:" + index.toString(),
            "contentFingerprint" => REVISION,
            "title" => "Fixture Track " + index.toString(),
            "artist" => "Fixture Artist",
            "album" => "Fixture Album",
            "durationSeconds" => 241,
            "downloadPath" => "/api/v1/watch/tracks/fixture/audio",
            "artworkId" => "fixture-artwork",
            "artworkPath" => "/api/v1/watch/a/fixture-artwork/fixture"
        };
    }

    (:test)
    function parsesPairAndConfigResponses(logger) {
        var pair = SyncAndRun.Protocol.parsePair({
            "protocolVersion" => 1,
            "deviceToken" => "fixture_device_token_0123456789abcdef",
            "companionId" => "companion:fixture",
            "manifestRevision" => REVISION
        });
        Test.assert(pair != null);
        Test.assert(SyncAndRun.Protocol.parsePair({ "protocolVersion" => 2 }) == null);

        var config = SyncAndRun.Protocol.parseConfig({
            "protocolVersion" => 1,
            "manifestRevision" => REVISION,
            "transcodeProfile" => "balanced",
            "pageSize" => 10,
            "serverTime" => "2026-08-14T18:00:00.000Z"
        });
        Test.assert(config != null);
        config["transcodeProfile"] = "lossless";
        Test.assert(SyncAndRun.Protocol.parseConfig(config) == null);
        return true;
    }

    (:test)
    function enforcesBoundedPlaylistPages(logger) {
        var items = [playlist(0)];
        for (var idx = 1; idx < 10; ++idx) { items.add(playlist(idx)); }
        var page = { "protocolVersion" => 1, "items" => items, "nextCursor" => "fixture-cursor" };
        Test.assert(SyncAndRun.Protocol.parsePlaylistPage(page) != null);
        items.add(playlist(10));
        Test.assert(SyncAndRun.Protocol.parsePlaylistPage(page) == null);
        page["items"] = [];
        page["nextCursor"] = null;
        Test.assert(SyncAndRun.Protocol.parsePlaylistPage(page) != null);
        return true;
    }

    (:test)
    function enforcesBoundedTrackPagesAndFields(logger) {
        var items = [track(0)];
        for (var idx = 1; idx < 10; ++idx) { items.add(track(idx)); }
        var page = {
            "protocolVersion" => 1,
            "playlistId" => "plex:playlist:fixture",
            "items" => items,
            "nextCursor" => null
        };
        Test.assert(SyncAndRun.Protocol.parseTrackPage(page) != null);
        items[0]["downloadPath"] = "https://untrusted.example.test/audio";
        Test.assert(SyncAndRun.Protocol.parseTrackPage(page) == null);
        items[0] = track(0);
        items[0]["contentFingerprint"] = "too-short";
        Test.assert(SyncAndRun.Protocol.parseTrackPage(page) == null);
        items[0] = track(0);
        items[0]["artworkId"] = null;
        Test.assert(SyncAndRun.Protocol.parseTrackPage(page) == null);
        return true;
    }

    (:test)
    function acceptsAbsoluteHttpsArtworkCapabilities(logger) {
        var item = track(1);
        var page = {
            "protocolVersion" => 1,
            "playlistId" => "plex:playlist:fixture",
            "items" => [item],
            "nextCursor" => null
        };
        item["artworkPath"] = "https://art.example.test/api/v1/watch/a/fixture-artwork/1234567890/signature/plex%3Atrack%3A1";
        Test.assert(SyncAndRun.Protocol.parseTrackPage(page) != null);
        item["artworkPath"] = "http://art.example.test/api/v1/watch/a/fixture";
        Test.assert(SyncAndRun.Protocol.parseTrackPage(page) == null);
        item["artworkPath"] = "https://user@art.example.test/api/v1/watch/a/fixture";
        Test.assert(SyncAndRun.Protocol.parseTrackPage(page) == null);
        return true;
    }

    (:test)
    function parsesStableErrors(logger) {
        var parsed = SyncAndRun.Protocol.parseError({
            "error" => {
                "code" => "DEVICE_REVOKED",
                "message" => "This watch was removed. Pair it again.",
                "retryable" => false,
                "requestId" => "req_fixture_01"
            }
        });
        Test.assert(parsed != null);
        Test.assertEqual("DEVICE_REVOKED", parsed["code"]);
        Test.assert(SyncAndRun.Protocol.parseError({ "error" => { "code" => "BAD" } }) == null);
        return true;
    }
}
