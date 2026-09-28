.PHONY: build test lint smoke package-mac package-linux secret-scan verify

build:
	cargo build --locked --workspace

test:
	cargo test --locked --workspace

lint:
	cargo fmt --all -- --check
	cargo clippy --locked --workspace --all-targets -- -D warnings

smoke: build
	python3 scripts/native-smoke.py

package-linux:
	python3 scripts/package-linux.py

package-mac:
	python3 scripts/package-macos.py

secret-scan:
	sh scripts/scan-secrets.sh

verify: lint test smoke secret-scan
