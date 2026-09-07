using Toybox.Media;
using Toybox.Lang;
using SyncAndRun;

// This class handles events from the system's media
// player. getContentIterator() returns an iterator
// that iterates over the songs configured to play.
class SyncAndRunContentDelegate extends Media.ContentDelegate {

	private var d_iterator;
	
	enum { START, SKIP_NEXT, SKIP_PREVIOUS, PLAYBACK_NOTIFY, COMPLETE, STOP, PAUSE, RESUME, }
	private var d_events = ["Start", "Skip Next", "Skip Previous", "Playback Notify", "Complete", "Stop", "Pause", "Resume"];

    function initialize() {
        ContentDelegate.initialize();

        resetContentIterator();
    }

    // Returns an iterator that is used by the system to play songs.
    // A custom iterator can be created that extends Media.ContentIterator
    // to return only songs chosen in the sync configuration mode.
    function getContentIterator() {
        return d_iterator;
    }

    // Respond to a user ad click
    function onAdAction(adContext) {
    	if ($.debug) {
			System.println("Ad Action");
    	}
    }
    
    function onCustomButton(button) {
    	if ($.debug) {
    		System.println("Custom Button clicked: " + button);
    	}
    }

    // Respond to a thumbs-up action
    function onThumbsUp(contentRefId) {
    	if ($.debug) {
			System.println("Thumbs Up");
    	}
    }

    // Respond to a thumbs-down action
    function onThumbsDown(contentRefId) {
    	if ($.debug) {
			System.println("Thumbs Down");
    	}
    }

    // Respond to a command to turn shuffle on or off
    function onShuffle() {
    	d_iterator.toggleShuffle();
    }
    
    function onRepeat() {
    	if ($.debug) {
    		System.println("Repeat Mode change");
    	}
    }
    
    function resetContentIterator() {
		d_iterator = new SyncAndRunContentIterator();
    	return d_iterator;
    }
    
    function onMore() {
    	if ($.debug) {
    		System.println("onMore is called");
    	}
    }
    
    function onLibrary() {
    	if ($.debug) {
    		System.println("onLibrary is called");
    	}
    }

    // Handles a notification from the system that an event has
    // been triggered for the given song
    function onSong(contentRefId, songEvent as Media.SongEvent, playbackPosition) as Void {
    	if ($.debug) {
			System.println("onSong Event (" + d_events[songEvent] + ") at position " + playbackPosition);
    	}
	
		if (songEvent == START) {
			var audio = d_iterator.currentAudio(contentRefId);
			if (audio == null) { return; }
			// Artwork is optional and must never abort cached audio playback.
			try {
				Media.setAlbumArt(audio.artwork());
			} catch (ex) {
				// The native player continues with its default artwork.
			}
			return;
		}

    }
}
