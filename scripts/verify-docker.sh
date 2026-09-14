#!/bin/sh
set -eu

# Keep verification independent of the caller's .env, Compose overrides and
# deployment names. The random project owns every resource cleanup can remove.
repo_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$repo_dir"
backup_dir=$(mktemp -d "${TMPDIR:-/tmp}/syncandrun-verify.XXXXXXXX")
verify_project=$(basename "$backup_dir" | tr '[:upper:]' '[:lower:]' | tr '.' '-')
verify_container=${verify_project}-companion-1
cross_container=${verify_project}-cross
verify_secret=verification-only-secret-with-32-bytes
verify_image=${verify_project}:native
cross_image=${verify_project}:cross
compose_started=false
cross_started=false

unset COMPOSE_FILE COMPOSE_ENV_FILES COMPOSE_PROFILES COMPOSE_PROJECT_NAME COMPOSE_COMPATIBILITY
export COMPOSE_DISABLE_ENV_FILE=1
export SYNCANDRUN_IMAGE="$verify_image"
export SYNCANDRUN_BASE_URL=https://music.example.test
export SYNCANDRUN_ARTWORK_BASE_URL=
export SYNCANDRUN_SECRET="$verify_secret"
export SYNCANDRUN_PORT=0
export SYNCANDRUN_BIND_ADDRESS=127.0.0.1
export SYNCANDRUN_LOG_LEVEL=info
export SYNCANDRUN_TRUST_PROXY=false
export SYNCANDRUN_ARTWORK_GATEWAY_PORT=3016
export SYNCANDRUN_CLOUDFLARED_TOKEN_FILE=/dev/null
export SYNCANDRUN_HOST_SECRET_GID=1000

compose() {
  docker compose --env-file /dev/null -f "$repo_dir/docker-compose.yml" -p "$verify_project" "$@"
}

cleanup() {
  if [ "$compose_started" = true ]; then
    compose down --volumes --remove-orphans >/dev/null 2>&1 || true
  fi
  if [ "$cross_started" = true ]; then
    docker rm -f "$cross_container" >/dev/null 2>&1 || true
  fi
  docker image rm "$verify_image" "$cross_image" >/dev/null 2>&1 || true
  rm -rf -- "$backup_dir"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

compose config --quiet
compose_started=true
compose up -d --build --wait --wait-timeout 120 companion
verify_port=$(compose port companion 3000 | sed 's/.*://')
test -n "$verify_port"

attempt=0
while [ "$attempt" -lt 30 ]; do
  status=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$verify_container" 2>/dev/null || true)
  if [ "$status" = healthy ]; then break; fi
  if [ "$status" = unhealthy ] || [ "$status" = exited ]; then
    compose logs --no-color
    exit 1
  fi
  attempt=$((attempt + 1))
  sleep 1
done
test "${status:-}" = healthy

curl --fail --silent "http://127.0.0.1:$verify_port/health/live" | grep -q '"status":"ok"'
curl --fail --silent "http://127.0.0.1:$verify_port/health/ready" | grep -q '"status":"ok"'
curl --fail --silent "http://127.0.0.1:$verify_port/" | grep -q '<title>SyncAndRun'
headers=$(curl --fail --silent --dump-header - --output /dev/null "http://127.0.0.1:$verify_port/")
printf '%s' "$headers" | grep -qi '^Content-Security-Policy:'
printf '%s' "$headers" | grep -qi '^Referrer-Policy: no-referrer'
printf '%s' "$headers" | grep -qi '^X-Content-Type-Options: nosniff'

docker exec "$verify_container" sh -c \
  'test "$(id -u)" = 1000 && test "$(node --version | cut -d. -f1)" = v22 && test -s /data/syncandrun.sqlite && test "$(awk "/VmRSS/ { print \$2 }" /proc/1/status)" -lt 262144'
docker exec "$verify_container" sh -c \
  'test ! -e /app/companion/node_modules/typescript && test ! -e /app/companion/node_modules/vite && test ! -e /app/companion/node_modules/vitest'
docker exec "$verify_container" touch /data/verification-sentinel

compose restart companion >/dev/null
attempt=0
while [ "$attempt" -lt 30 ]; do
  status=$(docker inspect --format '{{.State.Health.Status}}' "$verify_container" 2>/dev/null || true)
  [ "$status" = healthy ] && break
  attempt=$((attempt + 1))
  sleep 1
done
test "${status:-}" = healthy
docker exec "$verify_container" test -f /data/verification-sentinel

# Exercise the documented quiesced tar backup and restore into a genuinely
# empty named volume. The sentinel proves the restored service is using the
# archived data rather than a newly migrated database.
compose stop companion >/dev/null
compose run --rm --no-deps -T --entrypoint tar companion \
  -C /data -czf - . > "$backup_dir/syncandrun-data.tgz"
test -s "$backup_dir/syncandrun-data.tgz"
compose rm -f companion >/dev/null
docker volume rm "${verify_project}_syncandrun-data" >/dev/null
compose run --rm --no-deps -T --entrypoint tar companion \
  -C /data -xzf - < "$backup_dir/syncandrun-data.tgz"
compose up -d --wait --wait-timeout 120 companion
verify_port=$(compose port companion 3000 | sed 's/.*://')

attempt=0
while [ "$attempt" -lt 30 ]; do
  status=$(docker inspect --format '{{.State.Health.Status}}' "$verify_container" 2>/dev/null || true)
  [ "$status" = healthy ] && break
  attempt=$((attempt + 1))
  sleep 1
done
test "${status:-}" = healthy
docker exec "$verify_container" test -f /data/verification-sentinel
curl --fail --silent "http://127.0.0.1:$verify_port/health/ready" | grep -q '"status":"ok"'

if compose logs --no-color | grep -qE "$verify_secret|Authorization|X-Plex-Token"; then
  echo "Credential-shaped value found in container logs" >&2
  exit 1
fi

echo "Docker native clean-volume, restart persistence, and backup/restore checks passed."
if ! docker buildx version >/dev/null 2>&1; then
  echo "Docker Buildx is required; cross-architecture verification was not run." >&2
  exit 1
fi

native_arch=$(docker info --format '{{.Architecture}}')
if [ "$native_arch" = arm64 ] || [ "$native_arch" = aarch64 ]; then
  cross_platform=linux/amd64
  cross_machine=x86_64
else
  cross_platform=linux/arm64
  cross_machine=aarch64
fi

docker buildx build --platform "$cross_platform" --load \
  -f companion/Dockerfile -t "$cross_image" .
cross_started=true
docker run -d --name "$cross_container" --platform "$cross_platform" \
  -e SYNCANDRUN_BASE_URL=https://music.example.test \
  -e SYNCANDRUN_SECRET="$verify_secret" \
  -e SYNCANDRUN_DATA_DIR=/data \
  -e SYNCANDRUN_PORT=3000 \
  "$cross_image" >/dev/null

attempt=0
while [ "$attempt" -lt 30 ]; do
  status=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$cross_container" 2>/dev/null || true)
  [ "$status" = healthy ] && break
  if [ "$status" = unhealthy ] || [ "$status" = exited ]; then
    docker logs "$cross_container"
    exit 1
  fi
  attempt=$((attempt + 1))
  sleep 1
done
test "${status:-}" = healthy
test "$(docker exec "$cross_container" uname -m)" = "$cross_machine"

echo "Docker native clean-volume, backup/restore, and cross-architecture checks passed."
