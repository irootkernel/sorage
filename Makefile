BUN ?= bun

.PHONY: all test-prepare test-unit test-int test-contract test-e2e test-release test build package

all: test

# Installs from the lockfile and verifies the pinned toolchain before any test runs.
test-prepare:
	$(BUN) run check:toolchain
	$(BUN) run check:version
	$(BUN) install --frozen-lockfile
	$(BUN) run check:format
	$(BUN) run check:lint
	$(BUN) run check:typecheck
	$(BUN) run check:import-boundaries
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
