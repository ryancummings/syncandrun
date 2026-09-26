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
        return values;
    }

    function restore(values) {
        for (var idx = 0; idx < KEYS.size(); ++idx) {
            if (values[idx] == null) { Application.Storage.deleteValue(KEYS[idx]); }
            else { Application.Storage.setValue(KEYS[idx], values[idx]); }
        }
        Application.Properties.setValue("companion_url", values[KEYS.size()] == null ? "" : values[KEYS.size()]);
        Application.Properties.setValue("pairing_code", values[KEYS.size() + 1] == null ? "" : values[KEYS.size() + 1]);
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
