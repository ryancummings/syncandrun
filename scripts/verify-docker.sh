#!/bin/sh
set -eu

verify_project=syncandrun-verify
verify_container=${verify_project}-companion-1
cross_container=syncandrun-cross-verify
verify_port=33118
verify_secret=verification-only-secret-with-32-bytes
backup_dir=

export SYNCANDRUN_BASE_URL=https://music.example.test
export SYNCANDRUN_SECRET="$verify_secret"
export SYNCANDRUN_PORT="$verify_port"
export SYNCANDRUN_BIND_ADDRESS=127.0.0.1
export SYNCANDRUN_LOG_LEVEL=info
export SYNCANDRUN_TRUST_PROXY=false

cleanup() {
  docker compose -p "$verify_project" down --volumes --remove-orphans >/dev/null 2>&1 || true
  docker stop "$cross_container" >/dev/null 2>&1 || true
  docker rm "$cross_container" >/dev/null 2>&1 || true
  if [ -n "$backup_dir" ] && [ -d "$backup_dir" ]; then
    rm -rf -- "$backup_dir"
  fi
}
trap cleanup EXIT INT TERM
cleanup

docker compose -p "$verify_project" up -d --build

attempt=0
while [ "$attempt" -lt 30 ]; do
  status=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$verify_container" 2>/dev/null || true)
  if [ "$status" = healthy ]; then break; fi
  if [ "$status" = unhealthy ] || [ "$status" = exited ]; then
    docker compose -p "$verify_project" logs --no-color
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

docker compose -p "$verify_project" restart companion >/dev/null
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
backup_dir=$(mktemp -d "${TMPDIR:-/tmp}/syncandrun-verify-backup.XXXXXX")
docker compose -p "$verify_project" stop companion >/dev/null
docker compose -p "$verify_project" run --rm --no-deps -T --entrypoint tar companion \
  -C /data -czf - . > "$backup_dir/syncandrun-data.tgz"
test -s "$backup_dir/syncandrun-data.tgz"
docker compose -p "$verify_project" rm -f companion >/dev/null
docker volume rm "${verify_project}_syncandrun-data" >/dev/null
docker compose -p "$verify_project" run --rm --no-deps -T --entrypoint tar companion \
  -C /data -xzf - < "$backup_dir/syncandrun-data.tgz"
docker compose -p "$verify_project" up -d companion

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

if docker compose -p "$verify_project" logs --no-color | grep -E "$verify_secret|Authorization|X-Plex-Token"; then
  echo "Credential-shaped value found in container logs" >&2
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
  -f companion/Dockerfile -t syncandrun-companion:cross-test .
docker run -d --name "$cross_container" --platform "$cross_platform" \
  -e SYNCANDRUN_BASE_URL=https://music.example.test \
  -e SYNCANDRUN_SECRET="$verify_secret" \
  -e SYNCANDRUN_DATA_DIR=/data \
  -e SYNCANDRUN_PORT=3000 \
  syncandrun-companion:cross-test >/dev/null

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
