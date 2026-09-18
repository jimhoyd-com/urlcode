# Dynamic short links without reloads

Define a stable route once and create, update and delete short-code records
while `serve` keeps running, from optional SQLite storage on one host. Each
section below lives on its own page; the headings here keep existing links working.

## Node build requirement

SQLite 3.51.3+ (or 3.50.7 / 3.44.6) bundled with Node; `urlcode doctor` reports it. Read [setup](links/setup.md#node-build-requirement).

## Behavior in YAML, data outside Git

The `link` handler and the operator store binding. Read [setup](links/setup.md#behavior-in-yaml-data-outside-git).

## Run the included example

`links init`, `links create` and `serve --link-store` against a private data directory. Read [setup](links/setup.md#run-the-included-example).

## Update, disable, expire, list and delete

`links get/list/update/delete` and the optimistic version rules. Read [cli](links/cli.md#update-disable-expire-list-and-delete).

## Consistent operator export and restore

`links export` holds one read transaction; `links import` refuses occupied collections. Read [cli](links/cli.md#consistent-operator-export-and-restore).

## A separate authenticated management API

`links api`: bearer token, endpoints, status codes and scope. Read [management-api](links/management-api.md#a-separate-authenticated-management-api).

## Persistence, bounds and recovery

Pools, deadlines, worker replacement with backoff, record caps and backups. Read [limits](links/limits.md#persistence-bounds-and-recovery).

## Middleware, sandbox and tests

What guest code can and cannot see; fixtures for `test` and `audit`. Read [setup](links/setup.md#middleware-sandbox-and-tests).

## Opt-in completed-redirect events

The `linkEvents` observer: outcomes, redaction, bounded delivery. Read [limits](links/limits.md#opt-in-completed-redirect-events).

## Shutdown and management defaults

Loopback defaults, drain on close, unknown outcomes after a timeout. Read [pools](links/pools.md#shutdown-and-management-defaults).

## Explicit project opt-in

`dynamicLinks: true` in the entry file only; what enabling changes. Read [setup](links/setup.md#explicit-project-opt-in).

## Separate reader and writer pools

`--link-readers`, `--link-read-limit`, `--link-write-limit` and `stats()`. Read [pools](links/pools.md#separate-reader-and-writer-pools).

## Management HTTP and audit safeguards

Admission, socket timeout and `management_request` events. Read [management-api](links/management-api.md#management-http-and-audit-safeguards).

## Management hardening baseline

Loopback only, `--auth-file` credentials, durable audit rows. Read [management-api](links/management-api.md#management-hardening-baseline).
