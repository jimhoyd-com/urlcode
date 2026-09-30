# Bulk redirect projects

Bulk import converts CSV, JSON or YAML redirect rows into an ordinary Git-owned
URLCode project. Only literal paths and absolute HTTP(S) redirect destinations
are accepted; unsupported behavior and duplicate paths fail rather than being
discarded or overwritten.

```sh
urlcode bulk-import csv redirects.csv --out ./imported --dry-run
urlcode bulk-import csv redirects.csv --out ./imported
urlcode validate --local --project ./imported
```

| Format | Rows |
| --- | --- |
| `csv` | Header exactly `path,url,status`; an empty status means 302; quoted fields, commas and escaped quotes |
| `json` | Array of `{path, url, status?}`; status must be a number |
| `yaml` | The same row array in strict URLCode YAML syntax; not a project file |

Statuses are restricted to 301, 302, 303, 307 and 308. Paths must be literal
ASCII; destination placeholders, wildcards, extra fields and duplicate paths
fail. The normal schema and route compiler validate the result, so a
destination with credentials, a non-HTTP(S) scheme or a reserved path is
refused too. Input is limited to 32 MiB and 100,000 routes, and diagnostic
collection stops after 100 invalid rows. Diagnostics name the source label, the
physical CSV row or JSON/YAML array index and the path, never the destination.
This command is for data import; URLCode does not convert provider
configuration files.

The SDK provides
`importBulkProject(text, format, output, {dryRun, source})`. `format` is `csv`,
`json` or `yaml`. The report includes `ok`, `routeCount`, source/row diagnostics,
a SHA-256 fingerprint of the exact input text, and a bounded output-file plan.
Invalid input returns `ok: false` without writing files. Filesystem/output
refusals throw. `source` is a caller-supplied provenance label, not a file to read.

Routes are sorted by literal path and divided into include files with at most
1,000 routes each. At 100,000 routes this produces 100 include files. The entry
`urlcode.yaml` holds the include list and empty `routes`. `provenance.json`
records the source label, input fingerprint, counts and each shard's first/last
path. It does not embed the original input or claim exact source line mappings
for successful output rows; retain the original file in version control if that
traceability is needed. Invalid row diagnostics preserve their source positions.

Dry-run performs conversion and output planning without writing the requested
destination. Import requires a new output directory under an existing parent;
there is no implicit merge or overwrite mode. As with recipes, dependencies are
written first and a rename publishes the completed entry YAML last. Failed
writes clean up the directory created by that invocation. Source data is never
interpreted as shell code. The caller must control the output parent while
publishing.

## Local scale evidence

Run each dataset in a fresh process, sequentially, without concurrent builds:

```sh
node benchmarks/bulk.ts 1000
node benchmarks/bulk.ts 10000
node benchmarks/bulk.ts 100000
```

Observed on 2026-09-17 against the final integrated next-phase working tree,
with the merged TypeScript 6.0.3 dependency lock, Node v26.8.2, macOS arm64,
Apple M4 Pro and 48 GiB system memory. These measurements include the final
capability, revision-pin and egress activation paths. Synthetic routes redirect `/rN` to `https://example.com/items/N`.
Conversion includes input validation, semantic compilation and sharded output
publication; activation uses the normal `createRuntime` loader and compiler.
Lookup measures 5,000 `Runtime.handle` requests at concurrency one after 100
warm-up requests, validating each status and Location. It excludes socket/TLS
transport. Memory is sampled process RSS/heap after phases, not peak memory or
an isolated worker measurement.

| Routes | Includes | Conversion ms | Activation ms | RSS after activation MiB | Heap MiB | Lookup p95 ms |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1,000 | 1 | 56 | 139 | 180 | 27 | 0.002292 |
| 10,000 | 10 | 272 | 373 | 288 | 46 | 0.002916 |
| 100,000 | 100 | 5,530 | 8,838 | 537 | 214 | 0.003791 |

All three sequential fresh-process datasets activated and returned the expected
redirects. These are single observations, not a repeated-run statistical study;
background host load can change startup and memory measurements. Unlike the
previous single-document 100,000-route routing benchmark, the sharded project
fits the existing configuration worker's 256 MiB heap and 10-second deadline.
No loader, route-count, compiler deadline or runtime safety limit was increased.
This local result does not establish cross-platform capacity, provider
performance, peak-memory bounds, concurrency/soak behavior or production SLOs.
The benchmark reports failure phase and error if a limit is reached on another
machine; it does not retry with relaxed limits.
