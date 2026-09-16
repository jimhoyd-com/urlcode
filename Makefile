.DEFAULT_GOAL := help

NPM ?= npm
NODE ?= node
PROJECT ?= starters/dynamic
HOST ?= 127.0.0.1
PORT ?= 3000
TEMPLATE ?= dynamic
DEST ?= ../gitroll-link

.PHONY: help setup dev serve validate test test-project lint check verify test-package init doctor

help:
	@echo "make dev             Run the watched function/assets demo (installs dependencies if needed)"
	@echo "make setup           Reinstall dependencies from the lockfile"
	@echo "make init            Create an independent app (DEST=../gitroll-link TEMPLATE=dynamic)"
	@echo "make validate        Validate PROJECT with local environment loading"
	@echo "make test-project    Run PROJECT's HTTP assertions"
	@echo "make test            Run runtime unit, HTTP and security tests"
	@echo "make verify          Run lint, syntax checks and runtime tests"
	@echo "make test-package    Test an installed archive and both starters (registry access)"
	@echo "make serve           Serve a fixed snapshot; no watcher or local dotenv"
	@echo "make doctor          Show runtime/platform details"
	@echo "Options: PROJECT=../gitroll-link PORT=3001 HOST=127.0.0.1"

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
	$(NODE) src/cli.js init "$(DEST)" --template "$(TEMPLATE)"

doctor: node_modules/.package-lock.json
	$(NODE) src/cli.js doctor

test lint check verify: node_modules/.package-lock.json
	$(NPM) run $@

test-package: node_modules/.package-lock.json
	$(NPM) run test:package
