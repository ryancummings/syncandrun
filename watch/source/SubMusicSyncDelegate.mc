using Toybox.Application;
using Toybox.Communications;

module SyncAndRun {
    class SyncDelegate extends Communications.SyncDelegate {
        private var d_reconciler;

        function initialize() {
            Communications.SyncDelegate.initialize();
            d_reconciler = new SyncAndRun.Reconciler(method(:notifyProgress), method(:notifyComplete));
        }

        function notifyProgress(percentageComplete) {
            Communications.notifySyncProgress(percentageComplete);
        }

        function notifyComplete(errorMessage) {
            Communications.notifySyncComplete(errorMessage);
        }

        function isSyncNeeded() { return true; }
        function onStartSync() {
            SyncAndRun.SyncLaunch.captureStart();
            d_reconciler.start();
        }
        function onStopSync() { d_reconciler.stop(); }
    }
}
