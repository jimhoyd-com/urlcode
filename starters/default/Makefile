.DEFAULT_GOAL := help

# Uses the site's own install (npm install) when present, else `urlcode` on PATH.
# Override for anything else: URLCODE='node /path/to/urlcode/dist/cli.js'
URLCODE ?= $(if $(wildcard node_modules/.bin/urlcode),node_modules/.bin/urlcode,urlcode)
HOST ?= 127.0.0.1
PORT ?= 3000
# app/ is the route project; host.mjs is the trusted operator host that wires installed extensions.
SITE := --project app --host-file host.mjs

.PHONY: help dev serve validate test doctor
help:
	@echo "make dev       Run this app with reload and .env.local"
	@echo "make validate  Validate this app and its local bindings"
	@echo "make test      Run this app's HTTP assertions"
	@echo "make serve     Run a fixed snapshot, without local dotenv"
	@echo "make doctor    Show runtime/platform details"
	@echo "Options: PORT=3001 HOST=127.0.0.1 URLCODE=urlcode"

dev:
	$(URLCODE) dev $(SITE) --host "$(HOST)" --port "$(PORT)"
serve:
	$(URLCODE) serve $(SITE) --host "$(HOST)" --port "$(PORT)"
validate:
	$(URLCODE) validate --local $(SITE)
test:
	$(URLCODE) test $(SITE)
doctor:
	$(URLCODE) doctor

.PHONY: routes audit benchmark
routes audit benchmark:
	$(URLCODE) $@ $(SITE) $(ARGS)
