using Toybox.Application;
using Toybox.Lang;
using Toybox.Test;

(:test)
module SetupTests {
    const KEYS = [SyncAndRun.CompanionOrigin.STORAGE_KEY, SyncAndRun.State.DEVICE_TOKEN,
        SyncAndRun.State.COMPANION_ID, SyncAndRun.State.DESIRED_REVISION,
        SyncAndRun.State.APPLIED_REVISION, SyncAndRun.PAIRING_CODE_KEY];

    function snapshot() {
        var values = [];
        for (var idx = 0; idx < KEYS.size(); ++idx) { values.add(Application.Storage.getValue(KEYS[idx])); }
        values.add(Application.Properties.getValue("companion_url"));
        values.add(Application.Properties.getValue("pairing_code"));
        values.add(Application.Properties.getValue(SyncAndRun.Report.PAIRING));
        values.add(Application.Properties.getValue(SyncAndRun.Report.LAST_SYNC));
        values.add(Application.Properties.getValue("debug"));
        return values;
    }

    function restore(values) {
        for (var idx = 0; idx < KEYS.size(); ++idx) {
            if (values[idx] == null) { Application.Storage.deleteValue(KEYS[idx]); }
            else { Application.Storage.setValue(KEYS[idx], values[idx]); }
        }
        Application.Properties.setValue("companion_url", values[KEYS.size()] == null ? "" : values[KEYS.size()]);
        Application.Properties.setValue("pairing_code", values[KEYS.size() + 1] == null ? "" : values[KEYS.size() + 1]);
        Application.Properties.setValue(SyncAndRun.Report.PAIRING, values[KEYS.size() + 2]);
        Application.Properties.setValue(SyncAndRun.Report.LAST_SYNC, values[KEYS.size() + 3]);
        Application.Properties.setValue("debug", values[KEYS.size() + 4]);
    }

    (:test)
    function stagesFollowAddressCodeAndPairing(logger) {
        var previous = snapshot();
        try {
            for (var idx = 0; idx < KEYS.size(); ++idx) { Application.Storage.deleteValue(KEYS[idx]); }
            Application.Properties.setValue("companion_url", "");
            Application.Properties.setValue("pairing_code", "");
            Test.assertEqual(SyncAndRun.Setup.NEEDS_ADDRESS, SyncAndRun.Setup.stage());
            Test.assertEqual(0, SyncAndRun.Menu.Playback.layout());

            Test.assert(SyncAndRun.CompanionOrigin.save("http://10.4.13.186"));
            Test.assertEqual(SyncAndRun.Setup.NEEDS_CODE, SyncAndRun.Setup.stage());

            Application.Storage.setValue(SyncAndRun.PAIRING_CODE_KEY, "099366");
            Test.assertEqual(SyncAndRun.Setup.NEEDS_SYNC, SyncAndRun.Setup.stage());
            Test.assertEqual(0, SyncAndRun.Menu.Playback.layout());

            Application.Storage.setValue(SyncAndRun.State.DEVICE_TOKEN, "fixture-device-token");
            Test.assert(SyncAndRun.Setup.isReady());
            Test.assert(SyncAndRun.Menu.Playback.layout() > 0);
        } finally {
            restore(previous);
        }
        return true;
    }

    (:test)
    function resetClearsStoredAndSettingsSetupState(logger) {
        var previous = snapshot();
        try {
            Application.Storage.setValue(SyncAndRun.CompanionOrigin.STORAGE_KEY, "http://192.0.2.20");
            Application.Storage.setValue(SyncAndRun.State.DEVICE_TOKEN, "fixture-device-token");
            Application.Storage.setValue(SyncAndRun.PAIRING_CODE_KEY, "123456");
            Application.Properties.setValue("companion_url", "http://192.0.2.21");
            Application.Properties.setValue("pairing_code", "654321");
            Application.Properties.setValue(SyncAndRun.Report.PAIRING, "Paired");
            Application.Properties.setValue(SyncAndRun.Report.LAST_SYNC, "2026-01-02 03:04");
            Application.Properties.setValue("debug", true);
            Test.assertEqual(SyncAndRun.Setup.READY, SyncAndRun.Setup.stage());

            (new SyncAndRun.Menu.Storage()).clearAppData();

            Test.assert(Application.Storage.getValue(SyncAndRun.CompanionOrigin.STORAGE_KEY) == null);
            Test.assert(Application.Storage.getValue(SyncAndRun.State.DEVICE_TOKEN) == null);
            Test.assert(Application.Storage.getValue(SyncAndRun.PAIRING_CODE_KEY) == null);
            Test.assertEqual("", Application.Properties.getValue("companion_url"));
            Test.assertEqual("", Application.Properties.getValue("pairing_code"));
            Test.assertEqual("Not paired", Application.Properties.getValue(SyncAndRun.Report.PAIRING));
            Test.assertEqual("Never", Application.Properties.getValue(SyncAndRun.Report.LAST_SYNC));
            Test.assertEqual(true, Application.Properties.getValue("debug"));
            Test.assertEqual(SyncAndRun.Setup.NEEDS_ADDRESS, SyncAndRun.Setup.stage());
            Test.assertEqual("Step 1 of 2: address", SyncAndRun.Setup.stepLabel());
        } finally {
            restore(previous);
        }
        return true;
    }

    (:test)
    function connectionCheckRunsOnceWithoutReplacingANormalSync(logger) {
        var key = SyncAndRun.CompanionConnectionTest.REQUEST_KEY;
        var previous = Application.Storage.getValue(key);
        var resultKey = SyncAndRun.CompanionConnectionTest.RESULT_KEY;
        var previousResult = Application.Storage.getValue(resultKey);
        try {
            Application.Storage.setValue(key, true);
            Test.assert(SyncAndRun.CompanionConnectionTest.takeRequest());
            Test.assert(!SyncAndRun.CompanionConnectionTest.takeRequest());
            SyncAndRun.CompanionConnectionTest.saveResult("Ready on Wi-Fi");
            Test.assertEqual("Ready on Wi-Fi", (new SyncAndRun.Menu.Settings()).connectionStatus());
            SyncAndRun.CompanionConnectionTest.clearResult();
            Test.assert(SyncAndRun.CompanionConnectionTest.result() == null);
        } finally {
            if (previous == null) { Application.Storage.deleteValue(key); }
            else { Application.Storage.setValue(key, previous); }
            if (previousResult == null) { Application.Storage.deleteValue(resultKey); }
            else { Application.Storage.setValue(resultKey, previousResult); }
        }
        return true;
    }

    (:test)
    function addressPickerStartsFromHomePrefixAndResumesSavedAddress(logger) {
        var picker = new SyncAndRun.AddressPicker(null, true);
        Test.assertEqual("http://192.168.1.0", picker.origin());
        // A saved LAN address, including its port, comes back for editing.
        Test.assertEqual("http://10.4.13.186:3000",
            (new SyncAndRun.AddressPicker("http://10.4.13.186:3000", false)).origin());
        // Names and HTTPS belong to Other address; the picker ignores them.
        Test.assertEqual("http://192.168.1.0",
            (new SyncAndRun.AddressPicker("https://music.example.test", false)).origin());
        return true;
    }

    (:test)
    function addressPickerDigitsStayWithinRangeAndReachReview(logger) {
        var picker = new SyncAndRun.AddressPicker(null, true);
        // First digit of 192: up from 1 would give 292, over 255, so it wraps to 0.
        picker.adjust(1);
        Test.assertEqual("http://92.168.1.0", picker.origin());
        picker.adjust(-1);
        Test.assertEqual("http://192.168.1.0", picker.origin());
        picker.adjust(-1);
        Test.assertEqual("http://92.168.1.0", picker.origin());

        for (var idx = 0; idx < SyncAndRun.ADDRESS_DIGITS; ++idx) {
            Test.assertEqual(0, picker.advance());
        }
        Test.assert(picker.isReview());
        Test.assertEqual(SyncAndRun.ADDRESS_SAVE, picker.advance());

        // Changing the port: five digits, then back to review.
        picker.editPort();
        Test.assert(picker.isPort());
        picker.advance();			// 0
        picker.adjust(-7);			// 3 (thousands)
        for (var idx = 0; idx < 3; ++idx) { picker.advance(); }
        Test.assert(picker.isPort());
        picker.advance();
        Test.assert(picker.isReview());
        Test.assertEqual("http://92.168.1.0:3080", picker.origin());

        Test.assert(picker.retreat());
        Test.assertEqual(SyncAndRun.ADDRESS_DIGITS - 1, picker.position());
        return true;
    }
}
