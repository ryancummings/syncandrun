using Toybox.Application;
using Toybox.Lang;

module SyncAndRun {
    // All callers share the origin policy, including request readiness.
    module CompanionOrigin {
        const STORAGE_KEY = "syncandrun.companion_origin";

        function validCompanionPort(port) {
            if (!(port instanceof Lang.String) || (port.length() == 0) || (port.length() > 5)) { return false; }
            var value = 0;
            for (var idx = 0; idx < port.length(); ++idx) {
                var digit = "0123456789".find(port.substring(idx, idx + 1));
                if (digit == null) { return false; }
                value = (value * 10) + digit;
            }
            return (value >= 1) && (value <= 65535);
        }

        function validCompanionIpv4(host) {
            var separators = 0;
            var digits = 0;
            var octet = 0;
            for (var idx = 0; idx < host.length(); ++idx) {
                var character = host.substring(idx, idx + 1);
                if (character.equals(".")) {
                    if ((digits == 0) || (octet > 255)) { return false; }
                    separators += 1;
                    digits = 0;
                    octet = 0;
                } else {
                    var digit = "0123456789".find(character);
                    if (digit == null) { return false; }
                    octet = (octet * 10) + digit;
                    digits += 1;
                }
            }
            return (separators == 3) && (digits > 0) && (octet <= 255);
        }

        function validCompanionHost(host) {
            if (!(host instanceof Lang.String) || (host.length() == 0) || (host.length() > 245)) { return false; }
            if (host.substring(0, 1).equals(".") || host.substring(0, 1).equals("-")) { return false; }
            if (host.substring(host.length() - 1, null).equals(".")
                || host.substring(host.length() - 1, null).equals("-")) { return false; }
            if ((host.find("..") != null) || (host.find(".-") != null) || (host.find("-.") != null)) {
                return false;
            }

            var allowed = "abcdefghijklmnopqrstuvwxyz0123456789.-";
            var ipv4Candidate = host.find(".") != null;
            for (var idx = 0; idx < host.length(); ++idx) {
                var character = host.substring(idx, idx + 1);
                if (allowed.find(character) == null) { return false; }
                if (("0123456789.".find(character)) == null) { ipv4Candidate = false; }
            }
            if (ipv4Candidate) { return validCompanionIpv4(host); }
            return true;
        }

        // Accept a hostname or IPv4 address, with an optional explicit HTTP(S)
        // scheme and port. Hostname-only input defaults to HTTPS. Paths and other
        // URL features remain unsupported so every saved value is an origin.
        function normalize(value) {
            if (!(value instanceof Lang.String)) { return null; }
            var candidate = value.toLower();
            if (candidate.length() > 253) { return null; }
            var scheme = "https://";
            var authority = candidate;
            if ((candidate.length() >= 8) && candidate.substring(0, 8).equals("https://")) {
                authority = candidate.substring(8, null);
            } else if ((candidate.length() >= 7) && candidate.substring(0, 7).equals("http://")) {
                scheme = "http://";
                authority = candidate.substring(7, null);
            } else if (candidate.find("://") != null) {
                return null;
            }

            if ((authority.length() == 0) || (authority.find("/") != null)
                || (authority.find("?") != null) || (authority.find("#") != null)
                || (authority.find("@") != null)) { return null; }

            var host = authority;
            var colon = authority.find(":");
            if (colon != null) {
                host = authority.substring(0, colon);
                var port = authority.substring(colon + 1, null);
                if ((port.find(":") != null) || !validCompanionPort(port)) { return null; }
            }
            if (!validCompanionHost(host)) { return null; }
            return scheme + authority;
        }

        // The watch-local value is authoritative. Connect IQ settings remain a
        // fallback for existing installs and a convenient optional desktop entry
        // path, but are no longer required for setup.
        function current() {
            var origin = normalize(Application.Storage.getValue(STORAGE_KEY));
            if (origin instanceof Lang.String) { return origin; }
            return normalize(Application.Properties.getValue("companion_url"));
        }

        function save(value) {
            var origin = normalize(value);
            if (!(origin instanceof Lang.String)) { return false; }
            var previous = current();
            Application.Storage.setValue(STORAGE_KEY, origin);
            Application.Properties.setValue("companion_url", origin);
            if (!(previous instanceof Lang.String) || !previous.equals(origin)) {
                // Credentials belong to one companion. Preserve cached audio, but
                // require a fresh claim before the new server can change it.
                State.clearPairing();
                clearPairingCode();
            }
            return true;
        }

    }
}
