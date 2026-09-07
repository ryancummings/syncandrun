DEVICE ?= fr955
CIQ_HOME ?= $(shell cat "$(HOME)/Library/Application Support/Garmin/ConnectIQ/current-sdk.cfg" 2>/dev/null)
MONKEYC ?= $(CIQ_HOME)/bin/monkeyc
GARMIN_KEY ?= $(HOME)/.config/syncandrun/developer.der
WATCH_OUTPUT ?= build/watch/SyncAndRun-$(DEVICE).prg
WATCH_TEST_OUTPUT ?= build/watch/SyncAndRun-$(DEVICE)-tests.prg
WATCH_MEMORY_OUTPUT ?= build/watch/SyncAndRun-$(DEVICE)-memory-profile.prg
NODE22 ?= corepack pnpm dlx node@22

.PHONY: watch-build watch-test watch-memory-profile companion-dev companion-ui companion-build companion-test companion-e2e contract-test lint secret-scan docker-build docker-test verify

watch-build:
	@test -x "$(MONKEYC)" || { echo "Connect IQ SDK is not active" >&2; exit 1; }
	@test -f "$(GARMIN_KEY)" || { echo "Garmin developer key not found: $(GARMIN_KEY)" >&2; exit 1; }
	@mkdir -p "$(dir $(WATCH_OUTPUT))"
	@cd watch && "$(MONKEYC)" -f monkey.jungle -d "$(DEVICE)" \
		-o "../$(WATCH_OUTPUT)" -y "$(GARMIN_KEY)" -l 1

watch-test:
	@test -x "$(MONKEYC)" || { echo "Connect IQ SDK is not active" >&2; exit 1; }
	@test -f "$(GARMIN_KEY)" || { echo "Garmin developer key not found: $(GARMIN_KEY)" >&2; exit 1; }
	@mkdir -p "$(dir $(WATCH_TEST_OUTPUT))"
	@cd watch && "$(MONKEYC)" -t -f monkey.jungle -d "$(DEVICE)" \
		-o "../$(WATCH_TEST_OUTPUT)" -y "$(GARMIN_KEY)" -l 1
	@pgrep -f 'ConnectIQ.app/Contents/MacOS/simulator' >/dev/null || { \
		"$(CIQ_HOME)/bin/connectiq" >/dev/null 2>&1 & \
		for attempt in 1 2 3 4 5 6 7 8 9 10; do \
			pgrep -f 'ConnectIQ.app/Contents/MacOS/simulator' >/dev/null && break; \
			sleep 1; \
		done; \
	}
	@watch_test_output="$$("$(CIQ_HOME)/bin/monkeydo" "$(WATCH_TEST_OUTPUT)" "$(DEVICE)" -t 2>&1 || true)"; \
		printf '%s\n' "$$watch_test_output"; \
		printf '%s\n' "$$watch_test_output" | grep -q '^PASSED (passed='

watch-memory-profile:
	@test -x "$(MONKEYC)" || { echo "Connect IQ SDK is not active" >&2; exit 1; }
	@test -f "$(GARMIN_KEY)" || { echo "Garmin developer key not found: $(GARMIN_KEY)" >&2; exit 1; }
	@mkdir -p "$(dir $(WATCH_MEMORY_OUTPUT))"
	@cd watch && "$(MONKEYC)" -t -f memory-profile.jungle -d "$(DEVICE)" \
		-o "../$(WATCH_MEMORY_OUTPUT)" -y "$(GARMIN_KEY)" -l 1
	@pgrep -f 'ConnectIQ.app/Contents/MacOS/simulator' >/dev/null || { \
		"$(CIQ_HOME)/bin/connectiq" >/dev/null 2>&1 & \
		for attempt in 1 2 3 4 5 6 7 8 9 10; do \
			pgrep -f 'ConnectIQ.app/Contents/MacOS/simulator' >/dev/null && break; \
			sleep 1; \
		done; \
	}
	@manifest_output="$$("$(CIQ_HOME)/bin/monkeydo" "$(WATCH_MEMORY_OUTPUT)" "$(DEVICE)" -t MemoryProfileTests.manifestTraversal 2>&1 || true)"; \
		audio_output="$$("$(CIQ_HOME)/bin/monkeydo" "$(WATCH_MEMORY_OUTPUT)" "$(DEVICE)" -t MemoryProfileTests.audioDownloadCompletion 2>&1 || true)"; \
		startup_output="$$("$(CIQ_HOME)/bin/monkeydo" "$(WATCH_MEMORY_OUTPUT)" "$(DEVICE)" -t MemoryProfileTests.playbackStartup 2>&1 || true)"; \
		reused_output="$$("$(CIQ_HOME)/bin/monkeydo" "$(WATCH_MEMORY_OUTPUT)" "$(DEVICE)" -t MemoryProfileTests.reusedAudioPlanning 2>&1 || true)"; \
		reconcile_output="$$("$(CIQ_HOME)/bin/monkeydo" "$(WATCH_MEMORY_OUTPUT)" "$(DEVICE)" -t MemoryProfileTests.reusedAudioReconciliation 2>&1 || true)"; \
		printf '%s\n' "$$manifest_output" "$$audio_output" "$$startup_output" "$$reused_output" "$$reconcile_output"; \
		printf '%s\n' "$$manifest_output" | grep -q 'MEMORY_PROFILE manifest-traversal-500-tracks'; \
		printf '%s\n' "$$audio_output" | grep -q 'MEMORY_PROFILE audio-download-completion-500-tracks'; \
		printf '%s\n' "$$startup_output" | grep -q 'STARTUP_PROFILE playlist-500-tracks elapsed-ms='; \
		printf '%s\n' "$$reused_output" | grep -q 'SYNC_PROFILE reused-audio-500-tracks'; \
		printf '%s\n' "$$reconcile_output" | grep -q 'SYNC_PROFILE reused-reconciliation-500-tracks'; \
		printf '%s\n' "$$manifest_output" | grep -q '^PASSED (passed=1, failed=0, errors=0)'; \
		printf '%s\n' "$$audio_output" | grep -q '^PASSED (passed=1, failed=0, errors=0)'; \
		printf '%s\n' "$$startup_output" | grep -q '^PASSED (passed=1, failed=0, errors=0)'; \
		printf '%s\n' "$$reused_output" | grep -q '^PASSED (passed=1, failed=0, errors=0)'; \
		printf '%s\n' "$$reconcile_output" | grep -q '^PASSED (passed=1, failed=0, errors=0)'

companion-dev:
	@$(NODE22) companion/node_modules/tsx/dist/cli.mjs watch companion/src/main.ts

companion-ui:
	@$(NODE22) companion/node_modules/typescript/bin/tsc --noEmit --project companion/ui/tsconfig.json
	@$(NODE22) companion/node_modules/vite/bin/vite.js build --config companion/vite.config.ts

companion-test: companion-ui
	@$(NODE22) companion/node_modules/vitest/vitest.mjs run --config companion/vitest.config.ts

companion-e2e: companion-ui
	@$(NODE22) companion/node_modules/@playwright/test/cli.js test --config companion/playwright.config.ts

companion-build: companion-ui
	@$(NODE22) companion/node_modules/typescript/bin/tsc --noEmit --project companion/tsconfig.json
	@$(NODE22) companion/node_modules/typescript/bin/tsc --project companion/tsconfig.build.json

contract-test:
	@$(NODE22) scripts/validate-protocol.mjs

lint:
	@git diff --check
	@sh -n scripts/*.sh
	@$(NODE22) companion/node_modules/typescript/bin/tsc --noEmit --project companion/tsconfig.json
	@$(NODE22) companion/node_modules/typescript/bin/tsc --noEmit --project companion/ui/tsconfig.json

secret-scan:
	@sh scripts/scan-secrets.sh

docker-build:
	@docker build -f companion/Dockerfile -t syncandrun-companion:local .

docker-test:
	@sh scripts/verify-docker.sh

verify: lint secret-scan contract-test companion-build companion-test companion-e2e watch-test watch-memory-profile watch-build docker-test
