#!/usr/bin/env python3
"""Deployment orchestration checks using disposable state and fake Docker."""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import MagicMock, patch
from urllib.error import HTTPError

spec = importlib.util.spec_from_file_location("deployment", Path(__file__).with_name("deploy-local.py"))
deployment = importlib.util.module_from_spec(spec)
spec.loader.exec_module(deployment)


class DeploymentTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.args = argparse.Namespace(project="test-instance", origin="https://music.example.test",
                                       port=34318, upgrade_after_backup=False)
        self.revision = "a" * 40
        self.cached = False
        self.collisions = ""
        self.calls = []
        self.http = MagicMock()
        healthy = MagicMock()
        healthy.__enter__.return_value.status = 200
        self.http.open.side_effect = lambda url, **kwargs: healthy if url.endswith("/health/ready") else self.denied()
        socket_patch = patch.object(deployment.socket, "socket", MagicMock())
        socket_patch.start()
        self.addCleanup(socket_patch.stop)
        for name, value in (("run", self.run_command), ("output", self.command_output),
                            ("build_opener", lambda *args: self.http)):
            patcher = patch.object(deployment, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        patcher = patch.object(deployment.subprocess, "run",
                               lambda *args, **kwargs: subprocess.CompletedProcess(args, 0 if self.cached else 1))
        patcher.start()
        self.addCleanup(patcher.stop)

    def denied(self):
        raise HTTPError("http://127.0.0.1/api/v1/settings", 401, "Unauthorized", {}, None)

    def command_output(self, *args, **kwargs):
        if args[:3] == ("docker", "ps", "-aq"):
            return self.collisions
        if args[:3] in (("docker", "volume", "ls"), ("docker", "network", "ls")):
            return ""
        if args[:2] == ("docker", "info"):
            return "x86_64"
        if "org.opencontainers.image.revision" in " ".join(args):
            return self.revision
        if "{{.Id}}" in args or "{{.Image}}" in args:
            return "sha256:fixture"
        return "container-fixture"

    def run_command(self, *args, **kwargs):
        self.calls.append(args)
        if any(str(arg).endswith("setup-deployment.py") for arg in args):
            # Model the generator without invoking Docker or reading real credentials.
            path = Path(args[args.index("--output") + 1])
            path.write_text(f"COMPOSE_PROJECT_NAME={self.args.project}\n"
                            f"SYNCANDRUN_BASE_URL={self.args.origin}\n"
                            f"SYNCANDRUN_PORT={self.args.port}\n"
                            "SYNCANDRUN_BIND_ADDRESS=127.0.0.1\n"
                            f"SYNCANDRUN_SECRET={'fixture-secret-' * 4}\n")
            path.chmod(0o600)

    def deploy(self):
        deployment.deploy(self.args, Path(__file__).resolve().parent.parent,
                          self.root, self.revision, {})

    def test_first_run_and_repeat_preserve_secret_and_reuse_image(self):
        self.deploy()
        original = (self.root / "companion.env").read_text()
        self.assertEqual(sum(call[:2] == ("docker", "build") for call in self.calls), 1)
        self.cached = True
        self.deploy()
        self.assertEqual((self.root / "companion.env").read_text(), original)
        self.assertEqual(sum(call[:2] == ("docker", "build") for call in self.calls), 1)
        self.assertEqual(json.loads((self.root / "deployment.json").read_text())["image_id"], "sha256:fixture")
        self.assertTrue(any("--no-build" in call and "never" in call for call in self.calls))

    def test_existing_project_is_not_adopted(self):
        self.collisions = "unrelated-container"
        with self.assertRaisesRegex(RuntimeError, "refusing adoption"):
            self.deploy()
        self.assertFalse((self.root / "companion.env").exists())

    def test_secret_change_and_missing_environment_are_rejected(self):
        self.deploy()
        env_file = self.root / "companion.env"
        env_file.write_text(env_file.read_text().replace("fixture-secret-", "changed-secret-"))
        with self.assertRaisesRegex(RuntimeError, "secret changed"):
            self.deploy()
        env_file.unlink()
        with self.assertRaisesRegex(RuntimeError, "environment is missing"):
            self.deploy()

    def test_revision_change_requires_backup_acknowledgment(self):
        self.deploy()
        self.revision = "b" * 40
        with self.assertRaisesRegex(RuntimeError, "back up first"):
            self.deploy()
        self.args.upgrade_after_backup = True
        self.deploy()

    def test_failed_upgrade_records_attempt_before_migrations(self):
        self.deploy()
        self.revision = "b" * 40
        self.args.upgrade_after_backup = True

        def fail_start(*args, **kwargs):
            if "up" in args:
                raise RuntimeError("fixture startup failure")
            self.run_command(*args, **kwargs)

        with patch.object(deployment, "run", fail_start):
            with self.assertRaisesRegex(RuntimeError, "startup failure"):
                self.deploy()
        receipt = json.loads((self.root / "deployment.json").read_text())
        self.assertEqual(receipt["source_commit"], self.revision)
        self.assertEqual(receipt["health"], "pending")
        self.revision = "a" * 40
        self.args.upgrade_after_backup = False
        with self.assertRaisesRegex(RuntimeError, "back up first"):
            self.deploy()

    def test_remote_context_cannot_be_hidden_by_local_docker_host(self):
        self.args.state_dir = self.root
        calls = []

        def inspect(*args, **kwargs):
            calls.append(args)
            if args[:2] == ("git", "status"):
                return ""
            if args[:2] == ("git", "rev-parse"):
                return self.revision
            return "ssh://remote.invalid"

        with patch.object(deployment, "arguments", lambda: self.args), \
                patch.object(deployment, "output", inspect), \
                patch.dict(os.environ, {"DOCKER_CONTEXT": "remote", "DOCKER_HOST": "unix:///tmp/local"}, clear=True):
            with self.assertRaisesRegex(RuntimeError, "local Docker daemon"):
                deployment.main()
        self.assertTrue(any(call[:4] == ("docker", "context", "inspect", "remote") for call in calls))

    def test_dirty_source_stops_before_docker(self):
        self.args.state_dir = self.root
        with patch.object(deployment, "arguments", lambda: self.args), \
                patch.object(deployment, "output", lambda *args, **kwargs: " M companion/src/main.ts"):
            with self.assertRaisesRegex(RuntimeError, "checkout is dirty"):
                deployment.main()
        self.assertEqual(self.calls, [])


if __name__ == "__main__":
    unittest.main()
