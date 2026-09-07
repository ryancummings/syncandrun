using Toybox.Application;
using Toybox.Lang;
using Toybox.Media;

class Audio {
    enum { SONG, END }

    private var d_id;
    private var d_record;

    function initialize(id, type) {
        d_id = id;
        d_record = Application.Storage.getValue(SyncAndRun.SyncStore.activeTrackKey(id));
        if (!(d_record instanceof Lang.Dictionary)) { d_record = { "id" => id }; }
    }

    function id() { return d_id; }
    function title() { return value("title", ""); }
    function artist() { return value("artist", ""); }
    function album() { return value("album", ""); }
    function time() { return value("durationSeconds", 0); }
    function mime() { return "audio/mpeg"; }
    function refId() { return d_record["refId"]; }
    function playback() { return 0; }
    function type() { return SONG; }
    function setPlayback(value) { return false; }

    function setRefId(refId) {
        d_record["refId"] = refId;
        Application.Storage.setValue(SyncAndRun.SyncStore.activeTrackKey(d_id), d_record);
        return true;
    }

    function artwork() {
        var artworkId = d_record["artworkId"];
        if (artworkId instanceof Lang.String) {
            return Application.Storage.getValue(SyncAndRun.SyncStore.artworkKey(artworkId));
        }
        // Compatibility with the original per-track artwork storage layout.
        return Application.Storage.getValue(SyncAndRun.SyncStore.artworkKey(d_id));
    }

    function metadata() {
        if (refId() == null) { return null; }
        return Media.getCachedContentObj(new Media.ContentRef(refId(), Media.CONTENT_TYPE_AUDIO)).getMetadata();
    }

    function value(key, fallback) {
        var result = d_record[key];
        return result == null ? fallback : result;
    }

    static function typeToString(type) { return "song"; }
}
