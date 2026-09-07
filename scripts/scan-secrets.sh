#!/bin/sh
set -eu

if ! command -v gitleaks >/dev/null 2>&1; then
  echo "gitleaks is required for secret scanning" >&2
  exit 1
fi

report_dir=$(mktemp -d "${TMPDIR:-/tmp}/syncandrun-gitleaks.XXXXXX")
trap 'rm -rf "$report_dir"' EXIT INT TERM

gitleaks git --no-banner --redact --report-format json \
  --report-path "$report_dir/history.json" .
gitleaks dir --no-banner --redact --report-format json \
  --report-path "$report_dir/tree.json" .

if [ -d build ]; then
  gitleaks dir --no-banner --redact --report-format json \
    --report-path "$report_dir/build.json" build
fi

echo "Secret scan passed for git history, working tree, and generated build artifacts."
