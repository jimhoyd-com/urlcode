.DEFAULT_GOAL := help

# Install the runtime separately, or override: URLCODE='node /path/to/urlcode/dist/cli.js'
URLCODE ?= urlcode
HOST ?= 127.0.0.1
PORT ?= 3000

.PHONY: help dev serve validate test doctor
help:
	@echo "make dev       Run this app with reload and .env.local"
	@echo "make validate  Validate this app and its local bindings"
	@echo "make test      Run this app's HTTP assertions"
	@echo "make serve     Run a fixed snapshot, without local dotenv"
	@echo "make doctor    Show runtime/platform details"
	@echo "Options: PORT=3001 HOST=127.0.0.1 URLCODE=urlcode"

dev:
	$(URLCODE) dev --project . --host "$(HOST)" --port "$(PORT)"
serve:
	$(URLCODE) serve --project . --host "$(HOST)" --port "$(PORT)"
validate:
	$(URLCODE) validate --local --project .
test:
	$(URLCODE) test --project .
doctor:
	$(URLCODE) doctor

.PHONY: routes audit benchmark
routes audit benchmark:
	$(URLCODE) $@ --project . $(ARGS)
