using Toybox.WatchUi;
using Toybox.Communications;
using Toybox.Application;
using Toybox.Lang;
using Toybox.Math;
using Toybox.Media;
using Toybox.System;
using SyncAndRun.Menu;

module SyncAndRun {
	module Menu {
		class Storage extends MenuBase {

			function initialize() {
				MenuBase.initialize(WatchUi.loadResource(Rez.Strings.Storage_label), false);
			}

			function load() {
				if ($.debug) {
					System.println("Menu.Storage::load()");
				}
				return MenuBase.setItems([
					{
						LABEL => WatchUi.loadResource(Rez.Strings.Tracks_label),
						SUBLABEL => method(:sublabel_Tracks),
						METHOD => "tracks",
					},
					{
						LABEL => WatchUi.loadResource(Rez.Strings.Memory_label), 
						SUBLABEL => method(:sublabel_Memory), 
						METHOD => "cache",		// not used, null does not work
					},
					{
						LABEL => WatchUi.loadResource(Rez.Strings.Cache_label), 
						SUBLABEL => method(:sublabel_Cache), 
						METHOD => "cache",		// not used, null does not work
					},
					{
						LABEL => WatchUi.loadResource(Rez.Strings.FailedDownloads_label),
						SUBLABEL => method(:sublabel_Failed),
						METHOD => "failed",
					},
					{
						LABEL => WatchUi.loadResource(Rez.Strings.confSync_MoreInfo_RemoveAll_label), 
						SUBLABEL => WatchUi.loadResource(Rez.Strings.confSync_MoreInfo_RemoveAll_sublabel),
						METHOD => method(:onRemoveAll),
					}
				]);
			}

			function sublabel_Tracks() as Lang.String {
				return SyncAndRun.BoundedList.size(SyncAndRun.SyncStore.ACTIVE_TRACKS).toString();
			}

			function sublabel_Failed() as Lang.String {
				var summary = Application.Storage.getValue("syncandrun.last_sync_summary");
				if (!(summary instanceof Lang.Dictionary) || !(summary["counts"] instanceof Lang.Dictionary)) { return "0"; }
				var counts = summary["counts"] as Lang.Dictionary;
				return counts["failed"].toString();
			}

			function sublabel_Memory() as Lang.String {
				var stats = System.getSystemStats();
				return formatBytes(stats.usedMemory) + " / " + formatBytes(stats.totalMemory);
			}

			function sublabel_Cache() as Lang.String {
				var stats = Media.getCacheStatistics();
				return formatBytes(stats.size) + " / " + formatBytes(stats.capacity);
			}

			function onRemoveAll() {
				var msg = "Are you sure you want to delete all Application data?";
				WatchUi.pushView(new WatchUi.Confirmation(msg), new SyncAndRunConfirmationDelegate(method(:removeAll)), WatchUi.SLIDE_IMMEDIATE);
			}
			
			function removeAll() {
				if ($.debug) {
					System.println("Settings::removeAll()");
				}
				// remove all cached media
				Media.resetContentCache();
				
				// remove all metadata
				Application.Storage.clearValues();
				
				// exit app to make sure ram is cleared
				System.exit();
			}

			function formatBytes(bytes as Lang.Integer) as Lang.String {
				if (bytes == 0) {
					return "0 Bytes";
				}
				var k = 1024;
				var sizes = ["Bytes", "KB", "MB", "GB", "TB", "PB", "EB", "ZB", "YB"];
				var in = Math.floor(Math.log(bytes, 10) / Math.log(k, 10));
				var flt = (bytes / Math.pow(k, in));
				return flt.format("%.1f") + " " + sizes[in.toNumber()];
			}
		}
	}
}
