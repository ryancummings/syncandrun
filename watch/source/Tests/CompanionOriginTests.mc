using Toybox.Application;
using Toybox.Lang;
using Toybox.Test;

(:test)
module CompanionOriginTests {
    (:test)
    function savedOriginsAndSettingsUseTheSameClientPolicy(logger) {
        var keys = [SyncAndRun.CompanionOrigin.STORAGE_KEY,
            SyncAndRun.State.DEVICE_TOKEN, SyncAndRun.State.COMPANION_ID,
            SyncAndRun.State.DESIRED_REVISION, SyncAndRun.State.APPLIED_REVISION,
            SyncAndRun.PAIRING_CODE_KEY];
        var previous = [];
        for (var idx = 0; idx < keys.size(); ++idx) {
            previous.add(Application.Storage.getValue(keys[idx]));
        }
        var previousOrigin = Application.Properties.getValue("companion_url");
        var previousCode = Application.Properties.getValue("pairing_code");
        try {
            Application.Properties.setValue("companion_url", "");
            Application.Storage.deleteValue(SyncAndRun.CompanionOrigin.STORAGE_KEY);
            Test.assert(!(new SyncAndRun.Client()).validOrigin());

            var origins = ["http://192.168.1.20:3000", "https://music.example.test",
                "http://music.example.test", "Music.Example.Test:8443"];
            for (var idx = 0; idx < origins.size(); ++idx) {
                // Connect IQ fallback and on-watch save reach the same client.
                Application.Storage.deleteValue(SyncAndRun.CompanionOrigin.STORAGE_KEY);
                Application.Properties.setValue("companion_url", origins[idx]);
                Test.assert((new SyncAndRun.Client()).validOrigin());
                Test.assert(SyncAndRun.CompanionOrigin.save(origins[idx]));
                Test.assert((new SyncAndRun.Client()).validOrigin());
            }

            Test.assert(SyncAndRun.CompanionOrigin.save("http://music.example.test"));
            Application.Storage.setValue(SyncAndRun.State.DEVICE_TOKEN, "fixture-device-token");
            Application.Storage.setValue(SyncAndRun.State.APPLIED_REVISION, "fixture-revision");
            Application.Storage.setValue(SyncAndRun.PAIRING_CODE_KEY, "123456");
            Application.Properties.setValue("pairing_code", "654321");
            // Equivalent or rejected edits preserve credentials and revision.
            Test.assert(SyncAndRun.CompanionOrigin.save("HTTP://MUSIC.EXAMPLE.TEST"));
            Test.assert(!SyncAndRun.CompanionOrigin.save("http://music.example.test/path"));
            Test.assertEqual("fixture-device-token", SyncAndRun.State.token());
            Test.assertEqual("fixture-revision", Application.Storage.getValue(SyncAndRun.State.APPLIED_REVISION));
            Test.assertEqual("123456", SyncAndRun.pairingCode());
            Test.assert((new SyncAndRun.Client()).validOrigin());

            // A scheme change is a different origin and requires fresh pairing.
            Test.assert(SyncAndRun.CompanionOrigin.save("https://music.example.test"));
            Test.assert(SyncAndRun.State.token() == null);
            Test.assert(Application.Storage.getValue(SyncAndRun.State.APPLIED_REVISION) == null);
            Test.assert(SyncAndRun.pairingCode() == null);

            Application.Storage.deleteValue(SyncAndRun.CompanionOrigin.STORAGE_KEY);
            Application.Properties.setValue("companion_url", "http://music.example.test/path");
            Test.assert(!(new SyncAndRun.Client()).validOrigin());
        } finally {
            for (var idx = 0; idx < keys.size(); ++idx) {
                if (previous[idx] == null) { Application.Storage.deleteValue(keys[idx]); }
                else { Application.Storage.setValue(keys[idx], previous[idx]); }
            }
            Application.Properties.setValue("companion_url", previousOrigin == null ? "" : previousOrigin);
            Application.Properties.setValue("pairing_code", previousCode == null ? "" : previousCode);
        }
        return true;
    }
}
