using Toybox.WatchUi;

class SyncAndRunConfirmationDelegate extends WatchUi.ConfirmationDelegate {
	
	var d_callback;
	
	function initialize(callback) {
		ConfirmationDelegate.initialize();
		
		d_callback = callback;
	}
	
	function onResponse(response) {
		if ((d_callback == null) 
			|| (response == WatchUi.CONFIRM_NO)) { 
			return false;
		}
		
		d_callback.invoke();
		return true;
	}
}
