.DEFAULT_GOAL := help

NPM ?= npm
NODE ?= node
PROJECT ?= starters/default
HOST ?= 127.0.0.1
PORT ?= 3000
DEST ?= ../my-links

.PHONY: help setup dev serve validate test test-project lint check verify test-package init doctor

help:
	@echo "make dev             Run the watched function/redirect demo (installs dependencies if needed)"
	@echo "make setup           Reinstall dependencies from the lockfile"
	@echo "make init            Create an independent app (DEST=../my-links)"
	@echo "make validate        Validate PROJECT with local environment loading"
	@echo "make routes / audit / benchmark  Inventory, readiness and local load checks (ARGS=...)"
	@echo "make test-project    Run PROJECT's HTTP assertions"
	@echo "make test            Run runtime unit, HTTP and security tests"
	@echo "make verify          Run lint, syntax checks and runtime tests"
	@echo "make test-package    Test an installed archive and the starter (registry access)"
	@echo "make serve           Serve a fixed snapshot; no watcher or local dotenv"
	@echo "make doctor          Show runtime/platform details"
	@echo "make tunnel          Run dev behind an already-running ngrok tunnel (see docs/TUNNELS.md)"
	@echo "Options: PROJECT=../my-links PORT=3001 HOST=127.0.0.1"

setup:
	$(NPM) ci

node_modules/.package-lock.json: package.json package-lock.json
	$(NPM) ci

dev: node_modules/.package-lock.json
	$(NODE) src/cli.js dev --project "$(PROJECT)" --host "$(HOST)" --port "$(PORT)"

serve: node_modules/.package-lock.json
	$(NODE) src/cli.js serve --project "$(PROJECT)" --host "$(HOST)" --port "$(PORT)"

validate: node_modules/.package-lock.json
	$(NODE) src/cli.js validate --local --project "$(PROJECT)"

test-project: node_modules/.package-lock.json
	$(NODE) src/cli.js test --project "$(PROJECT)"

init: node_modules/.package-lock.json
	$(NODE) src/cli.js init "$(DEST)"

doctor: node_modules/.package-lock.json
	$(NODE) src/cli.js doctor

test lint check verify: node_modules/.package-lock.json
	$(NPM) run $@

test-package: node_modules/.package-lock.json
	$(NPM) run test:package

.PHONY: tunnel
tunnel: node_modules/.package-lock.json
	PROJECT="$(PROJECT)" PORT="$(PORT)" URLCODE="$(CURDIR)/src/cli.js" examples/tunnel/dev-with-ngrok.sh

.PHONY: routes audit benchmark
routes audit benchmark: node_modules/.package-lock.json
	$(NODE) src/cli.js $@ --project "$(PROJECT)" $(ARGS)
