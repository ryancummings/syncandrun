using Toybox.Media;
using Toybox.Math;
using SyncAndRun;

class SyncAndRunContentIterator extends Media.ContentIterator {

	private var d_songcount;
	private var d_playable;

    function initialize() {
        ContentIterator.initialize();

		// retrieve now playing
		d_playable = new SyncAndRun.IPlayable();
		
		d_songcount = d_playable.size();
    }

    // Determine if the the current track can be skipped.
    function canSkip() {
        return true;
    }

    // Get the current media content object.
    function get() {
    	if (d_playable.songidx() >= d_songcount)
    	{
    		return null;
    	}
        return getObj(d_playable.songidx());
    }

    // Get the current media content playback profile
    function getPlaybackProfile() {
        var profile = new Media.PlaybackProfile();
        profile.attemptSkipAfterThumbsDown = true;
        profile.playbackControls = [
            PLAYBACK_CONTROL_NEXT,
            PLAYBACK_CONTROL_PREVIOUS,
            PLAYBACK_CONTROL_VOLUME,
            
            PLAYBACK_CONTROL_LIBRARY,
            
            PLAYBACK_CONTROL_SHUFFLE,
            PLAYBACK_CONTROL_REPEAT,
        ];
        profile.playbackNotificationThreshold = 30;
        profile.requirePlaybackNotification = true;		// notify played
        profile.skipPreviousThreshold = 5;
        // profile.supportsPlaylistPreview = true;
        return profile;
    }

    // Get the next media content object.
    function next() {
    	if ((d_playable.songidx() + 1) >= d_songcount)
    	{
    		return null;
    	}
		d_playable.incSongIdx();
    	return getObj(d_playable.songidx());
    }

    // Get the next media content object without incrementing the iterator.
    function peekNext() {
    	if ((d_playable.songidx() + 1) >= d_songcount)
    	{
    		return null;
    	}
    	return getObj(d_playable.songidx() + 1);
    }

    // Get the previous media content object without decrementing the iterator.
    function peekPrevious() {
    	if (d_playable.songidx() == 0)
    	{
    		return null;
    	}
    	return getObj(d_playable.songidx() - 1);
    }

    // Get the previous media content object.
    function previous() {
    	if (d_playable.songidx() == 0)
    	{
    		return null;
    	}
		d_playable.decSongIdx();
    	return getObj(d_playable.songidx());
    }

    // Determine if playback is currently set to shuffle.
    function shuffling() {
        return d_playable.shuffle();
    }
    
    function toggleShuffle() {
		d_playable.shuffleIdcs(!d_playable.shuffle());
    }

    // Song callbacks describe the iterator's current item. Keep that lookup
    // constant-time; scanning every stored track can exceed Garmin's callback
    // budget on a physical library.
    function currentAudio(contentRefId) {
        var audio = d_playable.getAudio(d_playable.songidx());
        if ((audio instanceof Audio)
            && SyncAndRun.SyncStore.sameRef(audio.refId(), contentRefId)) {
            return audio;
        }
        return null;
    }

	// Retrieve the cached object from Media
	function getObj(idx) {

		// retrieve content reference
		var audio = d_playable.getAudio(idx);
		if ((audio == null) || (audio.refId() == null)) { return null; }
		var contentRef = new Media.ContentRef(audio.refId(), Media.CONTENT_TYPE_AUDIO);
		
		// retrieve metadata
		var content = Media.getCachedContentObj(contentRef);
		var metadata = content.getMetadata();

		// add stored metadata if not given in file (Plex does not provide metadata in file)
		var has_title = (metadata.title != null) && (metadata.title instanceof Lang.String) && (!metadata.title.equals(""));
		var has_artist = (metadata.artist != null) && (metadata.artist instanceof Lang.String) && (!metadata.artist.equals(""));
		var has_album = (metadata.album != null) && (metadata.album instanceof Lang.String) && (!metadata.album.equals(""));
		if (!has_title) {
			metadata.title = audio.title();
		}
		if (!has_artist) {
			metadata.artist = audio.artist();
		}
		if (!has_album) {
			metadata.album = audio.album();
		}
		
		// return content
		return new Media.ActiveContent(contentRef, metadata, 0);
	}
}
