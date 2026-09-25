#!/usr/bin/env python3
"""Build a clean revision once and start a persistent, loopback-only companion."""

import argparse
import fcntl
import hashlib
import ipaddress
import json
import os
from pathlib import Path
import re
import socket
import subprocess
import sys
import tempfile
from urllib.error import HTTPError
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, ProxyHandler, build_opener


def run(*args, **kwargs):
    return subprocess.run(args, check=True, text=True, **kwargs)


def output(*args, **kwargs):
    return run(*args, capture_output=True, **kwargs).stdout.strip()


def arguments():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--origin", required=True)
    parser.add_argument("--allow-lan-http", action="store_true",
                        help="Opt into unencrypted browser and watch traffic on a private LAN IP")
    parser.add_argument("--project", required=True)
    parser.add_argument("--port", required=True, type=int)
    parser.add_argument("--state-dir", required=True, type=Path)
    parser.add_argument("--upgrade-after-backup", action="store_true",
                        help="Allow a changed source revision after taking a stopped-service backup")
    args = parser.parse_args()
    origin = urlsplit(args.origin)
    try:
        address = ipaddress.ip_address(origin.hostname or "")
        private_lan = any(address in network for network in (
            ipaddress.ip_network("10.0.0.0/8"), ipaddress.ip_network("172.16.0.0/12"),
            ipaddress.ip_network("192.168.0.0/16")))
    except ValueError:
        private_lan = False
    valid_https = (origin.scheme == "https" and not args.allow_lan_http
                   and re.fullmatch(r"[a-zA-Z0-9.-]+", origin.hostname or ""))
    valid_lan_http = origin.scheme == "http" and args.allow_lan_http and private_lan
    if (not (valid_https or valid_lan_http) or origin.netloc != origin.hostname
            or origin.path not in ("", "/") or origin.query or origin.fragment):
        parser.error("--origin must be an HTTPS DNS origin on port 443, or a private IPv4 HTTP origin on port 80 with --allow-lan-http")
    args.origin = f"{origin.scheme}://{origin.hostname}"
    if not re.fullmatch(r"[a-z][a-z0-9_-]{0,48}", args.project):
        parser.error("--project must start with a lowercase letter and use letters, digits, _ or -")
    if not 1024 <= args.port <= 65535:
        parser.error("--port must be between 1024 and 65535")
    return args


def read_environment(path):
    result = {}
    for line in path.read_text().splitlines():
        if not line or line.startswith("#"):
            continue
        key, separator, value = line.partition("=")
        if not separator or key in result or not re.fullmatch(r"[A-Z][A-Z0-9_]*", key):
            raise RuntimeError("Private environment has invalid or duplicate settings")
        result[key] = value
    return result


def save(path, contents):
    temporary = path.with_suffix(path.suffix + ".new")
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, "w") as handle:
        handle.write(contents)
    temporary.replace(path)


def main():
    args = arguments()
    repo = Path(__file__).resolve().parent.parent
    os.chdir(repo)
    state_dir = args.state_dir.expanduser().resolve()
    if state_dir == repo or repo in state_dir.parents:
        raise RuntimeError("--state-dir must be outside the source checkout")
    if output("git", "status", "--porcelain", "--untracked-files=normal"):
        raise RuntimeError("Source checkout is dirty; commit or use a clean reviewed checkout")
    revision = output("git", "rev-parse", "HEAD")
    environment = {k: v for k, v in os.environ.items()
                   if not k.startswith(("COMPOSE_", "SYNCANDRUN_"))}
    environment["COMPOSE_DISABLE_ENV_FILE"] = "1"
    run("docker", "version", "--format", "{{.Server.Version}}", env=environment)
    run("docker", "compose", "version", env=environment)
    if environment.get("DOCKER_CONTEXT"):
        endpoint = output("docker", "context", "inspect", environment["DOCKER_CONTEXT"],
                          "--format", "{{.Endpoints.docker.Host}}", env=environment)
    else:
        endpoint = environment.get("DOCKER_HOST") or output(
            "docker", "context", "inspect", "--format", "{{.Endpoints.docker.Host}}", env=environment)
    if not endpoint.startswith("unix://"):
        raise RuntimeError("Use a local Docker daemon; remote endpoint health cannot be verified here")
    state_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    if state_dir.stat().st_mode & 0o077:
        raise RuntimeError("Private state directory must have mode 0700")
    with (state_dir / "deploy.lock").open("a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise RuntimeError("Another deployment is using this state directory") from None
        deploy(args, repo, state_dir, revision, environment)


def deploy(args, repo, state_dir, revision, environment):
    env_file = state_dir / "companion.env"
    receipt_file = state_dir / "deployment.json"
    containers = output("docker", "ps", "-aq", "--filter",
                        f"label=com.docker.compose.project={args.project}", env=environment)
    if not receipt_file.exists():
        volumes = output("docker", "volume", "ls", "-q", "--filter",
                         f"name=^{args.project}_syncandrun-data$", env=environment)
        networks = output("docker", "network", "ls", "-q", "--filter",
                          f"label=com.docker.compose.project={args.project}", env=environment)
        if containers or volumes or networks or env_file.exists():
            raise RuntimeError("Existing project resources or configuration found; refusing adoption/reset")
    with socket.socket() as probe:
        if not containers:
            probe.bind(("127.0.0.1", args.port))
    if not env_file.exists():
        if receipt_file.exists():
            raise RuntimeError("Saved environment is missing; restore it instead of generating a new secret")
        setup = [sys.executable, str(repo / "scripts/setup-deployment.py"), "--origin", args.origin,
                 "--project", args.project, "--port", str(args.port), "--output", str(env_file)]
        if args.allow_lan_http:
            setup.append("--allow-lan-http")
        run(*setup)
    if env_file.stat().st_mode & 0o077:
        raise RuntimeError("Private environment file must have mode 0600")
    values = read_environment(env_file)
    identity = {"project": args.project, "origin": args.origin, "port": args.port,
                "secret_sha256": hashlib.sha256(values.get("SYNCANDRUN_SECRET", "").encode()).hexdigest()}
    if (values.get("COMPOSE_PROJECT_NAME") != args.project
            or values.get("SYNCANDRUN_BASE_URL") != args.origin
            or values.get("SYNCANDRUN_ALLOW_LAN_HTTP", "false") != ("true" if args.allow_lan_http else "false")
            or values.get("SYNCANDRUN_PORT") != str(args.port)
            or values.get("SYNCANDRUN_BIND_ADDRESS") != "127.0.0.1"
            or len(values.get("SYNCANDRUN_SECRET", "")) < 32):
        raise RuntimeError("Requested identity differs from saved configuration; refusing reset")
    if receipt_file.exists():
        receipt = json.loads(receipt_file.read_text())
        if receipt.get("source_commit", revision) != revision and not args.upgrade_after_backup:
            raise RuntimeError("Source revision changed; back up first, then pass --upgrade-after-backup")
        if receipt["identity"] != identity:
            raise RuntimeError("Saved deployment identity or secret changed; refusing reset")
    else:
        save(receipt_file, json.dumps({"identity": identity}, indent=2) + "\n")
    architecture = output("docker", "info", "--format", "{{.Architecture}}", env=environment)
    image = f"syncandrun-companion:{revision}-{architecture}"
    exists = subprocess.run(["docker", "image", "inspect", image], env=environment,
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0
    if exists:
        label = output("docker", "image", "inspect", "--format",
                       '{{index .Config.Labels "org.opencontainers.image.revision"}}', image, env=environment)
        if label != revision:
            raise RuntimeError("Cached image source label differs; refusing to reuse the tag")
        print(f"Reusing source image {image}", flush=True)
    else:
        # Only committed files enter the build, regardless of ignored local files.
        with tempfile.TemporaryDirectory(prefix="syncandrun-source-") as directory:
            archive = Path(directory) / "source.tar"
            run("git", "archive", "--format=tar", "--output", str(archive), revision)
            source = Path(directory) / "source"
            source.mkdir()
            run("tar", "-xf", str(archive), "-C", str(source))
            run("docker", "build", "--label", f"org.opencontainers.image.revision={revision}",
                "-f", "companion/Dockerfile", "-t", image, ".", cwd=source, env=environment)
    image_id = output("docker", "image", "inspect", "--format", "{{.Id}}", image, env=environment)
    values["SYNCANDRUN_IMAGE"] = image
    save(env_file, "".join(f"{key}={value}\n" for key, value in values.items()))
    compose = ["docker", "compose", "--env-file", str(env_file), "-f",
               str(repo / "docker-compose.yml"), "-p", args.project]
    run(*compose, "config", "--quiet", env=environment)
    # Migrations may run before readiness. A failed upgrade must still prevent
    # an older revision from being silently restarted against its database.
    save(receipt_file, json.dumps({"identity": identity, "source_commit": revision,
                                  "image": image, "image_id": image_id, "health": "pending"}, indent=2) + "\n")
    run(*compose, "up", "-d", "--no-build", "--pull", "never", "--wait", "--wait-timeout", "120", "companion", env=environment)
    container = output(*compose, "ps", "-q", "companion", env=environment)
    running_image = output("docker", "inspect", "--format", "{{.Image}}", container, env=environment)
    if running_image != image_id:
        raise RuntimeError("Running container does not match the verified local image")

    class NoRedirect(HTTPRedirectHandler):
        def redirect_request(self, request, fp, code, message, headers, new_url):
            return None

    local_http = build_opener(ProxyHandler({}), NoRedirect())
    with local_http.open(f"http://127.0.0.1:{args.port}/health/ready", timeout=5) as response:
        if response.status != 200:
            raise RuntimeError("Readiness check failed")
    try:
        with local_http.open(f"http://127.0.0.1:{args.port}/api/v1/settings", timeout=5):
            raise RuntimeError("Anonymous management was unexpectedly allowed")
    except HTTPError as error:
        if error.code != 401:
            raise RuntimeError("Anonymous management did not return HTTP 401") from None
    save(receipt_file, json.dumps({"identity": identity, "source_commit": revision,
                                  "image": image, "image_id": image_id, "health": "passed", "anonymous_management": "denied"}, indent=2) + "\n")
    print(f"Ready on 127.0.0.1:{args.port}; anonymous management denied. Source: {revision}")
    print("Ingress, owner Plex authentication, and watch acceptance are separate operator steps.")


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, OSError, subprocess.CalledProcessError) as error:
        # Captured Docker/config output may contain credentials; never replay it.
        print(f"Deployment stopped: {error}", file=sys.stderr)
        sys.exit(1)
