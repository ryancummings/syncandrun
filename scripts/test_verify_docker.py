#!/usr/bin/env python3
"""Check verifier isolation and failure cleanup without a Docker daemon."""

import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest


class DockerVerificationIsolation(unittest.TestCase):
    def run_failure(self, stage):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            docker = root / "docker"
            docker.write_text("""#!/usr/bin/env python3
import json, os, sys
with open(os.environ['VERIFY_TEST_LOG'], 'a') as log:
    log.write(json.dumps({'args': sys.argv[1:], 'env': {
        k: v for k, v in os.environ.items()
        if k.startswith(('COMPOSE_', 'SYNCANDRUN_'))}}) + '\\n')
if os.environ['VERIFY_TEST_FAIL'] in sys.argv:
    sys.exit(7)
""")
            docker.chmod(0o755)
            log = root / "calls.jsonl"
            environment = dict(os.environ, PATH=f"{root}:{os.environ['PATH']}",
                               VERIFY_TEST_LOG=str(log), VERIFY_TEST_FAIL=stage,
                               COMPOSE_FILE="production.yml",
                               COMPOSE_ENV_FILES="production.env",
                               COMPOSE_PROFILES="artwork-public",
                               COMPOSE_COMPATIBILITY="true",
                               COMPOSE_PROJECT_NAME="production",
                               SYNCANDRUN_IMAGE="production:current",
                               SYNCANDRUN_ARTWORK_BASE_URL="https://production.invalid",
                               SYNCANDRUN_SECRET="production-secret")
            result = subprocess.run(["sh", str(Path(__file__).with_name("verify-docker.sh"))],
                                    env=environment, capture_output=True, text=True)
            self.assertEqual(result.returncode, 7, result.stderr)
            return [json.loads(line) for line in log.read_text().splitlines()]

    def assert_isolated(self, calls):
        compose = [call for call in calls if call["args"][0] == "compose"]
        projects = {call["args"][call["args"].index("-p") + 1] for call in compose}
        self.assertEqual(len(projects), 1)
        project = projects.pop()
        self.assertRegex(project, r"^syncandrun-verify-[a-z0-9]{8}$")
        for call in compose:
            self.assertEqual(call["args"][1:3], ["--env-file", "/dev/null"])
            self.assertIn("-f", call["args"])
            environment = call["env"]
            for key in ("COMPOSE_PROFILES", "COMPOSE_COMPATIBILITY", "COMPOSE_FILE",
                        "COMPOSE_ENV_FILES", "COMPOSE_PROJECT_NAME"):
                self.assertNotIn(key, environment)
            self.assertEqual(environment["SYNCANDRUN_PORT"], "0")
            self.assertEqual(environment["SYNCANDRUN_BIND_ADDRESS"], "127.0.0.1")
            self.assertEqual(environment["SYNCANDRUN_IMAGE"], f"{project}:native")
            self.assertEqual(environment["SYNCANDRUN_ARTWORK_BASE_URL"], "")
            self.assertNotEqual(environment["SYNCANDRUN_SECRET"], "production-secret")
        for call in calls:
            if call["args"][:2] == ["image", "rm"]:
                self.assertEqual(call["args"][2:], [f"{project}:native", f"{project}:cross"])
        return project

    def test_config_failure_never_removes_containers_or_volumes(self):
        calls = self.run_failure("config")
        self.assert_isolated(calls)
        self.assertFalse(any("down" in call["args"] for call in calls))
        self.assertFalse(any(call["args"][0] in ("rm", "volume") for call in calls))

    def test_partial_start_cleans_only_unique_project(self):
        calls = self.run_failure("up")
        first_project = self.assert_isolated(calls)
        self.assertEqual(sum("down" in call["args"] for call in calls), 1)
        self.assertFalse(any(call["args"][0] == "rm" for call in calls))
        second_project = self.assert_isolated(self.run_failure("up"))
        self.assertNotEqual(first_project, second_project)


if __name__ == "__main__":
    unittest.main()
