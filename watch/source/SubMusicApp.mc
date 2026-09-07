using Toybox.Application;
using Toybox.WatchUi;
using SyncAndRun.Menu;

var debug = false;

class SyncAndRunApp extends Application.AudioContentProviderApp {

    function initialize() {
        AudioContentProviderApp.initialize();

        // update debug status
        $.debug = Application.Properties.getValue("debug");

        if ($.debug) {
			System.println("SyncAndRunApp::initialize()");
        }
        
        // in case variables need to be reset
    //    Application.Storage.clearValues();

    }

    // onStart() is called on application start up
    function onStart(state) {
    	if ($.debug) {
    		System.println("Start with state: " + state);
    	}
    }

    // onStop() is called when your application is exiting
    function onStop(state) {
    	if ($.debug) {
    		System.println("Stop with state: " + state);
    	}
    }
    
    function onSettingsChanged() {
    	if ($.debug) {
    		System.println("Settings changed");
    	}
    	
        // reload the media profile
        Media.requestPlaybackProfileUpdate();
    }

    // Get a Media.ContentDelegate for use by the system to get and iterate through media on the device
    function getContentDelegate(arg) {
    	if ($.debug) {
    		System.println("getContentDelegate with arg: " + arg);
    	}
        
        return new SyncAndRunContentDelegate();
    }

    // Get a delegate that communicates sync status to the system for syncing media content to the device
    function getSyncDelegate() {
        return new SyncAndRun.SyncDelegate();
    }

    // Get the initial view for configuring playback
    function getPlaybackConfigurationView() {
        var menu = new Menu.Playback();
        menu.load();    // menu needs to be loaded when MenuLoader is not used
    	return [ new Menu.MenuView(menu), menu.delegate() ];
    }

    // Get the initial view for configuring sync
    function getSyncConfigurationView() {
        var menu = new Menu.Playback();
        menu.load();    // menu needs to be loaded when MenuLoader is not used
		return [ new SyncAndRun.Menu.MenuView(menu), menu.delegate() ];
    }
    
    function popView() {
    	WatchUi.popView(WatchUi.SLIDE_IMMEDIATE);
    }
}
