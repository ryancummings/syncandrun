.PHONY: build test e2e desktop-test pack-linux pack-mac pack-win secret-scan verify

build:
	corepack pnpm --dir companion build

test:
	corepack pnpm --dir companion test

e2e: build
	corepack pnpm --dir companion e2e

desktop-test:
	corepack pnpm --dir desktop test

pack-linux: build
	corepack pnpm --dir desktop pack:linux

pack-mac: build
	corepack pnpm --dir desktop pack:mac

pack-win: build
	corepack pnpm --dir desktop pack:win

secret-scan:
	sh scripts/scan-secrets.sh

verify: build test e2e desktop-test secret-scan
