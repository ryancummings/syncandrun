#!/usr/bin/env python3
"""Test Make's failure propagation with fake tools; this does not test a watch."""

import os
from pathlib import Path
import subprocess
import tempfile
import unittest


class WatchCheckFailurePropagation(unittest.TestCase):
    def test_earlier_memory_failure_cannot_be_hidden_by_final_success(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "bin").mkdir()
            (root / "developer.der").touch()
            (root / "bin/pgrep").write_text("#!/bin/sh\nexit 0\n")
            (root / "bin/monkeydo").write_text("""#!/usr/bin/env python3
import os, sys
name = sys.argv[-1].split('.')[-1]
markers = {
 'manifestTraversal': 'MEMORY_PROFILE manifest-traversal-500-tracks',
 'audioDownloadCompletion': 'MEMORY_PROFILE audio-download-completion-500-tracks',
 'playbackStartup': 'STARTUP_PROFILE playlist-500-tracks elapsed-ms=1',
 'reusedAudioPlanning': 'SYNC_PROFILE reused-audio-500-tracks',
 'reusedAudioReconciliation': 'SYNC_PROFILE reused-reconciliation-500-tracks',
}
print(markers[name])
if name == os.environ.get('VERIFY_TEST_FAILED_PROFILE'):
    print('FAILED (passed=0, failed=1, errors=0)')
    sys.exit(1)
print('PASSED (passed=1, failed=0, errors=0)')
if os.environ.get('VERIFY_TEST_CRASH') == '1':
    sys.exit(1)
""")
            for tool in (root / "bin").iterdir():
                tool.chmod(0o755)
            env = dict(os.environ, PATH=f"{root / 'bin'}:{os.environ['PATH']}")
            command = ["make", "watch-memory-profile", f"CIQ_HOME={root}",
                       "MONKEYC=/bin/true", f"GARMIN_KEY={root / 'developer.der'}",
                       f"WATCH_MEMORY_OUTPUT={root / 'profile.prg'}"]
            crashed = subprocess.run(command, cwd=Path(__file__).resolve().parent.parent,
                                     env=dict(env, VERIFY_TEST_CRASH="1"),
                                     capture_output=True, text=True)
            self.assertNotEqual(crashed.returncode, 0, crashed.stdout)
            for failed in ("", "manifestTraversal", "audioDownloadCompletion",
                           "playbackStartup", "reusedAudioPlanning",
                           "reusedAudioReconciliation"):
                with self.subTest(failed_profile=failed):
                    result = subprocess.run(command,
                                            cwd=Path(__file__).resolve().parent.parent,
                                            env=dict(env, VERIFY_TEST_FAILED_PROFILE=failed),
                                            capture_output=True, text=True)
                    if failed:
                        self.assertNotEqual(result.returncode, 0, result.stdout)
                    else:
                        self.assertEqual(result.returncode, 0, result.stderr)

    def test_watch_summary_and_process_status(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "bin").mkdir()
            (root / "developer.der").touch()
            (root / "bin/pgrep").write_text("#!/bin/sh\nexit 0\n")
            (root / "bin/monkeydo").write_text(
                '#!/bin/sh\nprintf "%s\\n" "$VERIFY_TEST_SUMMARY"\n'
                'exit "$VERIFY_TEST_STATUS"\n')
            for tool in (root / "bin").iterdir():
                tool.chmod(0o755)
            command = ["make", "watch-test", f"CIQ_HOME={root}",
                       "MONKEYC=/bin/true", f"GARMIN_KEY={root / 'developer.der'}",
                       f"WATCH_TEST_OUTPUT={root / 'tests.prg'}"]
            for passed, failed, errors, status, accepted in (
                    (1, 0, 0, 0, True), (12, 0, 0, 0, True),
                    (0, 0, 0, 0, False), (1, 1, 0, 0, False),
                    (1, 0, 1, 0, False), (1, 0, 0, 1, False)):
                with self.subTest(passed=passed, failed=failed, errors=errors, status=status):
                    environment = dict(os.environ,
                        PATH=f"{root / 'bin'}:{os.environ['PATH']}",
                        VERIFY_TEST_SUMMARY=f"PASSED (passed={passed}, failed={failed}, errors={errors})",
                        VERIFY_TEST_STATUS=str(status))
                    result = subprocess.run(command,
                        cwd=Path(__file__).resolve().parent.parent, env=environment,
                        capture_output=True, text=True)
                    self.assertEqual(result.returncode == 0, accepted, result.stdout + result.stderr)


if __name__ == "__main__":
    unittest.main()
