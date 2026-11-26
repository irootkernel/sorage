override BUN := /bin/sh scripts/toolchain.sh bun
.DEFAULT_GOAL := all

.PHONY: help toolchain-install toolchain-sync toolchain-check deps deps-lock
help:
	@echo 'Setup: make toolchain-install toolchain-sync deps toolchain-check'
	@echo 'Develop: make test-prepare test-unit test-int test-contract test-e2e build package'
	@echo 'Verify: make test (complete gate); make test-release (package and AJ-16)'
	@echo 'Upgrade: edit .bun-version/.node-version; make toolchain-install toolchain-sync'
	@echo 'Dependencies: edit package.json; make deps-lock deps'

toolchain-install:
	/bin/sh scripts/toolchain.sh install

toolchain-sync:
	/bin/sh scripts/toolchain.sh sync

toolchain-check:
	/bin/sh scripts/toolchain.sh check

deps:
	$(BUN) install --frozen-lockfile

deps-lock:
	$(BUN) install --lockfile-only

.PHONY: all test-prepare test-unit test-int test-contract test-e2e test-release test build package

all: test

# Installs from the lockfile and verifies the pinned toolchain before any test runs.
test-prepare:
	$(MAKE) deps
	$(BUN) run check:toolchain
	$(BUN) run check:version
	$(BUN) run format
	$(BUN) run build:web -- --check
	$(BUN) run check:lint
	$(BUN) run check:typecheck
	$(BUN) run check:import-boundaries
	$(BUN) run check:cycles
	$(BUN) run check:dependency-boundaries
	$(BUN) run check:sot

test-unit:
	$(BUN) run test:unit

test-int: build
	$(BUN) run test:int

test-contract:
	$(BUN) run test:contract

test-e2e: build
	$(BUN) run test:e2e

test-release: package
	$(BUN) run test:release

# Recursive targets keep the gate ordered even when the caller uses make -j.
test:
	$(MAKE) test-prepare
	$(MAKE) test-unit
	$(MAKE) package
	$(BUN) run test:int
	$(MAKE) test-contract
	$(BUN) run test:e2e
	$(BUN) run test:release

build:
	$(BUN) run build:cli

package:
	$(BUN) run package
