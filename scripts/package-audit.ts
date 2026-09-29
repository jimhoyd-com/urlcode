import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, posix, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';
import { parsePackJson } from './pack-json.ts';
import { addons, repositoryRoot } from './workspaces.ts';
import { isArtifactFile } from '../packages/core/src/addon-install.ts';

interface PackedFile { path: string; size: number }
interface PackReport {
  name: string;
  size: number;
  unpackedSize: number;
  entryCount: number;
  files: PackedFile[];
}
export type PackageKind = 'core' | 'extension' | 'artifact';
export interface Budget {
  packed: number;
  unpacked: number;
  entries: number;
  roots: readonly string[];
  optionalPeers?: readonly string[];
}

// These are release budgets, not targets, keyed by package name. The allowlists
// keep repository-only material out; the headroom lets implementation grow
// without silently undoing the packaging boundary. Which packages are audited is
// not listed here: `--all` audits core plus every add-on scripts/workspaces.ts
// finds, and an add-on without a budget below fails rather than being skipped.
export const budgets: Record<string, Budget> = {
  '@jimhoyd/urlcode': {
    // npm's tar/gzip implementation varies slightly across its supported
    // Node releases; keep a small cross-platform allowance while retaining
    // the existing 2.3 MiB unpacked-content ceiling.
    // The feature-planning surface and its refreshed authoring catalog add
    // about 1.2 KiB of compressed package content.
    // review_project (a new opt-in, read-only static review tool: packages/core/src/review.ts,
    // its MCP/CLI wiring, no data/schema/example growth) adds a few hundred bytes
    // of genuinely new compressed content, already trimmed to a minimal
    // implementation. Measured PR #437 CI packed sizes for the identical commit
    // were 532179-532180 bytes on Node 22/26 (ubuntu) but 534333 bytes on Node 24
    // (ubuntu) -- a ~2.1 KiB swing from npm's own tar/gzip output alone, not from
    // this change, which the previous 520 KiB budget had no headroom left to
    // absorb. Raised to keep every supported Node release comfortably under
    // budget rather than chasing gzip-implementation noise byte by byte.
    // Shipping the four docs/*.md files searchDocs (urlcode docs search /
    // MCP search_docs) reads at runtime -- plus docs/README.md, which npm
    // always includes once anything under docs/ is packed -- adds about
    // 30 KiB of compressed content, 110 KiB unpacked and 5 more entries.
    // The env-binding host-override option (#258) also adds a small amount
    // of schema and llms-full.txt content. Keep 640 KiB of compressed
    // capacity: the current archive is about 553 KiB, so routine, reviewed
    // package growth and npm gzip variation do not turn into unrelated PR
    // failures. The deterministic unpacked-size, file-count and allowlist
    // boundaries below still catch unexpected package expansion.
    //
    // Raised from 2450 KiB for the fixture schema, structured error fields
    // and docs added for #581/#583/#584 (JSON 422 responses, did-you-mean
    // messages, schemas/requests.schema.json). Some of that headroom (about
    // 9.5 KiB) covered examples/cloudflare/dist/*, a gitignored build
    // artifact that `npm run test:examples:built` left behind and that
    // `npm pack` picked up whenever it sat under the wholesale-listed
    // `examples` root. #608 excludes that artifact from `files` (and this
    // script now asserts no gitignored path ships, dist/ itself excepted
    // since that is the package's deliberate, always-regenerated build
    // output), so that headroom is no longer spent on a leak.
    //
    // Raised from 2550 KiB for the onboarding-docs sweep (#591):
    // docs/YAML-REFERENCE.md is now split into per-area sections with the
    // schema's `description` fields included (about +13.5 KiB), which also
    // grows the consolidated `llms-full.txt` (about +21 KiB), both shipped
    // files. `docs/CONCEPTS.md` itself is not in `files` and does not ship.
    // Kept at 2650 KiB rather than lowered by the reclaimed 9.5 KiB: the
    // #591 growth alone needs most of that headroom back.
    //
    // Packed raised from 640 to 650 KiB: a batch of small, independent
    // features (mcp promoted to a distributed package; create-extension
    // scaffolding; the x-urlcode-context-* extension channel; shipped-skills consolidation) landed together and pushed
    // the compressed archive to about 641 KiB, a few hundred bytes over
    // the previous budget on its own even before gzip-implementation
    // variance across Node/OS combinations.
    //
    // Unpacked raised from 2650 to 2700 KiB: the capability-only installs
    // (#711, with an `example()` hook and the `--example` docs sweep), the
    // store-contributed CRUD screen (#709), text-level YAML edits for
    // `extensions add`/`remove` (#715), library-mode listing (#718) and the
    // generic add-on authoring rules (#712) together pushed the unpacked
    // content to about 2653 KiB, about 3 KiB over. The same batch leaves the
    // packed archive at about 646 KiB (661714 bytes on Node 26), under 4 KiB
    // from the 650 KiB budget and inside the ~2 KiB npm gzip variance noted
    // above, so packed is raised to 660 KiB as well.
    //
    // Entries raised from 450 to 460: the operator alias-origin list (#717)
    // adds one runtime module (dist/site-origins.js), taking the archive to
    // 451 files; the other ten keep headroom for the next small module
    // without loosening the allowlist or size checks.
    //
    // Unpacked raised from 2700 to 2720 KiB: per-record store ownership
    // (#331) adds the core request-principal contract (RIM-EXT-PRINCIPAL-001:
    // dist/extensions.js and its declarations), the "Request principal" and
    // "Per-record ownership" sections of docs/EXTENSIONS.md and docs/STORE.md,
    // and their copies in llms-full.txt, taking the unpacked content to
    // 2765326 bytes (about 2700.5 KiB, 526 bytes over). Packed stays at 660
    // KiB: the same tree packs to 674409 bytes on Node 26, about 1.4 KiB under.
    //
    // Packed raised from 660 to 680 KiB: per-record store ownership (#331)
    // and its request-principal contract take the archive to about 659 KiB
    // (674409 bytes on Node 26), within the ~2 KiB cross-Node gzip variance
    // of the old budget.
    //
    // Packed raised from 660 to 675 KiB for the public authoring tools of
    // #722 (dist/fixture-suggestions.js and dist/yaml-change.js with their
    // declarations, the CLI/MCP wiring and their TOOLING.md/llms-full.txt
    // documentation): about 11 KiB of new compressed content took the archive
    // to about 671 KiB (686681 bytes on Node 26), over the previous budget.
    // 675 KiB keeps the ~2 KiB npm gzip variance noted above. The same
    // change adds about 50 KiB unpacked (about 39 KiB of JavaScript and
    // declarations, the rest documentation), taking the content to about
    // 2739 KiB, so unpacked is raised from 2700 to 2750 KiB; entry-count and
    // allowlist checks are unchanged (four new files, 456 of 460).
    //
    // Together, #331 and #722 measure 691356 packed bytes (about 675 KiB)
    // and 2821737 unpacked bytes (about 2756 KiB) on Node 26, so the
    // combined budgets are 690 KiB packed and 2800 KiB unpacked.
    //
    // Raised to 720 KiB packed and 2900 KiB unpacked for the follow-up batch:
    // per-owner record limits (#731), include-aware authoring tools (#733),
    // the shared passkey relying-party domain (#729) and user-linked API keys
    // with store reassign (#732) measure 703205 packed and 2863298 unpacked
    // bytes on Node 26, under 4 KiB from the previous budgets and inside the
    // ~2 KiB cross-Node gzip variance.
    //
    // Raised to 740 KiB packed, 2950 KiB unpacked and 470 entries when main's
    // review report and studio (#749, #751: dist/project-report.js and
    // dist/studio.js with declarations) met this branch's extension request
    // helpers: together they measure 733793 packed and 2966469 unpacked bytes
    // in 462 entries on Node 26, each within about 3 KiB of the old budget
    // and two entries over its count.
    //
    // Unpacked raised from 2950 to 2970 KiB for #750: a description on every
    // property of schemas/urlcode.schema.json (+20 KiB) also fills the
    // Description column of docs/YAML-REFERENCE.md and its llms-full.txt copy
    // (+20 KiB each), measuring 3028789 unpacked bytes on Node 26. Packed
    // size and entry count stay inside their budgets.
    //
    // Packed raised from 740 to 746 KiB for the bounded documentation
    // search (#759: dist/docs-search.js with its declarations, the CLI/MCP
    // wiring and the "Bounded documentation search" section of
    // docs/TOOLING.md). Extension guides are read from installed add-on
    // packages, not copied into core. It measures 761737 packed bytes on
    // Node 26, 3977 over the old budget; 746 KiB keeps the ~2 KiB cross-Node
    // gzip variance noted above. The same change adds about 29 KiB unpacked
    // (dist/docs-search.js is 25 KiB with its source comments), measuring
    // 3070525 unpacked bytes, so unpacked is raised from 2970 to 3000 KiB.
    //
    // Raised to 752 KiB packed and 3040 KiB unpacked when #759 met the
    // run_tests execution-contract change (#590: honest runner descriptions
    // and annotations, the SECURITY/TOOLING/AI-AUTHORING updates and their
    // llms-full.txt copies). Together they measure 763472 packed and 3077097
    // unpacked bytes in 464 entries on Node 26, which left under 1 KiB of
    // packed headroom against the ~2 KiB cross-Node gzip variance above.
    //
    // Raised to 768 KiB packed and 3080 KiB unpacked for the dev extension-pin
    // follow (#777: RIM-EXT-PIN-001 and dist/ changes), host-file propagation into
    // context commands and MCP runners (#778), and the docs corrections of
    // #540/#103/#779-#785 with their llms-full.txt copies. Together they measure
    // 770628 packed and 3103798 unpacked bytes in 464 entries on Node 26, 580
    // bytes over the old packed budget.
    //
    // Packed raised from 768 to 772 KiB for generic streamed responses (#659:
    // dist/http-stream.js, the RIM-STREAM-001 runtime/extension/capability
    // changes, the streaming-progress recipe and the specification, extension
    // and operations sections with their llms-full.txt copies). It measures
    // 788349 packed bytes on Node 26, 1917 over the old budget; 772 KiB keeps
    // the ~2 KiB cross-Node gzip variance noted above. Unpacked it measures
    // 3163145 bytes, 9225 over, so unpacked is raised from 3080 to 3100 KiB.
    // The module, its declarations and the recipe's five files make 471
    // entries, so entries is raised from 470 to 480.
    //
    // Raised to 788 KiB packed and 3140 KiB unpacked when the streaming
    // responses change (#659) met main's studio/review-report additions
    // (#792): together they measure 795299 packed and 3185100 unpacked bytes
    // in 471 entries on Node 26, over the 772/3100 KiB budgets set for #659
    // alone.
    //
    // Raised from 788 KiB packed, 3140 KiB unpacked and 480 entries for the
    // #805-#810 batch: route-named asset reference diagnostics (#808), the
    // local agent bootstrap (dist/bootstrap.js, CLI/MCP wiring, #807), the
    // spa-shell (#809) and headless-auth-profile (#810) recipes, and the
    // TOOLING/ASSETS/RECIPES/AI-AUTHORING/skill sections with their
    // llms-full.txt copies. Measured on the merged branch (Node 26): 827444
    // packed, 3290761 unpacked, 485 entries. 812 KiB leaves about 4 KiB for
    // the ~2 KiB cross-Node gzip variance noted above.
    // Raised again for the #806/#811/#812/#814 batch: the cookie jar and
    // fixture redaction (dist/cookie-jar.js, readiness), init --adopt
    // (planInit, site-layout), the hosted-assisted skill helper shipped in the
    // package, and the READINESS/STARTERS/TOOLING/AI-AUTHORING sections with
    // their llms-full.txt copies. Measured on the merged branch (Node 26):
    // 844581 packed, 3349335 unpacked, 490 entries; 828 KiB leaves about
    // 3 KiB for the ~2 KiB cross-Node gzip variance noted above.
    // Raised for #816 (per-mount extension asset declarations, audit's
    // extension-assets probe, RIM-EXT-ASSETS-001 and the READINESS/EXTENSIONS
    // sections): measured 847255 packed and 3359276 unpacked bytes, 490
    // entries, on Node 26.
    // Raised for the #708/#821/#822/#823/#824 batch: the declarative JSON
    // error format (http-response, capabilities, schema, HTTP/SPECIFICATION/
    // SITE sections) and docs/EXTENSION-REFERENCE.md with the llms-full.txt
    // coverage note. Measured on the merged branch (Node 26): 860834 packed,
    // 3403684 unpacked, 490 entries.
    // Raised for the #825/#826/#828 batch: init --no-mcp and the EPERM/EROFS
    // diagnostics, fence-aware docs search, and the fixed-contract-adapter
    // recipe with its compatibility audit and llms-full.txt copy. Measured
    // on the merged branch (Node 26): 876609 packed, 3468112 unpacked, 493
    // entries.
    // Session identity guidance and the authenticated-handlers recipe (#832):
    // measured 882184 packed / 3510731 unpacked bytes, 499 entries on Node 26.
    // Raised for #837/#839 (RIM-EXT-CAPABILITY-001, the generic request-bound
    // capability handoff: extensions.ts/router.ts/runtime.ts/functions.ts and
    // the EXTENSIONS.md "Request-bound capabilities" section with its
    // llms-full.txt copy; no new recipe or schema field). Measured on Node 26:
    // 885375 packed / 3525136 unpacked bytes, 499 entries.
    // Raised for #843/#834: explain's provider-defined subpath and capability
    // facts, --policy on bootstrap/context/explain/review/plan-feature/mcp with
    // the MCP runner forwarding and named policy-file errors, and their
    // TOOLING/EXTENSIONS sections with llms-full.txt copies. Measured on Node
    // 26: 887241 packed / 3532433 unpacked bytes, 499 entries.
    // Unpacked raised from 3460 to 3470 KiB for #861 item 8: body schema
    // coherence refusals and pointer-based Ajv refusal diagnostics
    // (body-validation.ts) with the HTTP/RUNTIME-IMPLEMENTATION sections and
    // their llms-full.txt copies. Measured on Node 26: 887922 packed / 3543842 unpacked bytes, 489 entries.
    // Raised to 875/3490 KiB for #861 item 6: the standard body schema string
    // formats (body-formats.ts in dist) with the HTTP.md format table, the
    // RIM-BODY-SCHEMA-001 card, the schema description and their llms-full.txt
    // and YAML-REFERENCE.md copies. Measured on Node 26: 893513 packed /
    // 3561513 unpacked bytes, 491 entries.
    // Raised for #844 operation 2 (`urlcode artifacts stage` and MCP
    // stage_source_assets: source-stage.ts with its declarations,
    // RIM-SOURCE-STAGE-001, the EXTENSIONS "Staging source assets" section,
    // TOOLING/AI-AUTHORING/skill lines and their llms-full.txt copies; no
    // fixture ships). Measured on Node 26: 904925 packed / 3606184 unpacked
    // bytes, 491 entries. Unpacked raised again to 3535 KiB after merging
    // main's #866/#867 and #873 docs: measured 3612717 unpacked bytes.
    // With #861 item 6 and #844 operation 2 both merged, measured on Node 26: 911700 packed / 3630347
    // unpacked bytes, 493 entries; about 3 KiB of headroom on each.
    // Packed raised from 870 to 880 KiB for #845's OpenAPI export: dist/openapi.js with its declarations, the
    // CLI/MCP wiring, and the TOOLING/HTTP/AI-AUTHORING sections with their llms-full.txt copies. Measured on
    // Node 26: 897639 packed bytes, 6759 over the old budget; 880 KiB keeps about 3 KiB for the ~2 KiB
    // cross-Node gzip variance noted above. Unpacked measures 3572415 bytes, 19135 over, so it is raised from
    // 3470 to 3500 KiB.
    // With both #861 item 6 and #845's OpenAPI export merged, measured on Node 26: 904686 packed /
    // 3596578 unpacked bytes, 493 entries; about 3 KiB of headroom on each.
    // With #861 item 6, #845's OpenAPI export and #844 operation 2 all merged, measured on Node 26:
    // 920937 packed / 3658875 unpacked bytes, 495 entries; about 3 KiB of headroom on each.
    // Unpacked raised from 3576 to 3584 KiB for #875 (descriptor targets in explain/manifest/context/review, the
    // manifest's per-target `refused` count, and the STORE/TOOLING/CAPABILITIES operator-audit sections): measured
    // on Node 26 at 3664264 unpacked bytes, 2440 over the old budget.
    // Raised for #888: the auth: short form, OpenAPI security and review follow providesPrincipal rather than the
    // name auth (principal-provider resolution in addon-manifest.ts, the EXTENSIONS/POLICIES/TOOLING/
    // RUNTIME-IMPLEMENTATION prose and schema descriptions with their llms-full.txt and YAML-REFERENCE.md copies).
    // Measured on Node 26 against main with #875, #886 and #890 merged: 927468 packed bytes (3820 over 902 KiB)
    // and 3681030 unpacked bytes (11014 over 3584 KiB), so packed is raised to 909 KiB and unpacked to 3598 KiB,
    // about 3 KiB of headroom on each.
    // #889's embedded fetch handler: dist/embed.js and dist/host-request.js with their declarations, the
    // OPERATIONS "Hosting URLCode inside another framework" section, RIM-EMBED-001 and their llms-full.txt copies.
    // Measured on Node 26 after rebasing onto #875/#887/#890: 929130 packed bytes (5482 over 902 KiB) and 3686818
    // unpacked bytes (16802 over 3584 KiB), 499 entries. Packed raised to 911 KiB, unpacked to 3604 KiB and entries
    // to 504, each keeping about 3.7 KiB (or 5 entries) of headroom for the ~2 KiB cross-Node gzip variance above.
    // Unpacked raised from 3604 to 3614 KiB for #881 items 3-6 and 9 (OpenAPI runtime headers, the 405 and
    // site.errors scope matching in dist/openapi.js; parameter formats in router/build-cloudflare; the TOOLING/
    // HTTP/RUNTIME-IMPLEMENTATION sections and schema description with their llms-full.txt and YAML-REFERENCE.md
    // copies). Measured on Node 26 after rebasing onto #889: 3696414 unpacked bytes, 5918 over the old budget;
    // packed measures 931851 bytes, 1013 under 911 KiB, so it is unchanged.
    // With #888 (principal provider), #889 (embedding adapter) and #883 slice 1 merged, measured on Node 26:
    // Earlier: 933787 packed / 3704490 unpacked bytes, 499 entries; about 3 KiB of headroom on each.
    // With #888 and #881 both merged, measured on Node 26: 936548 packed / 3706583 unpacked bytes, 501 entries;
    // about 3 KiB of headroom on each.
    // Raised for #857 items 2, 4 and 6: dist/package-files.js (the addon-files.lock.json record, offline checks,
    // the tarball reader for verify --online) and dist/inert-yaml.js (the bounded inert-document YAML profile) with
    // their declarations, verify/outdated/upgrade in addon-install and extensions-cli, the EXTENSIONS "installed
    // file record" and "upgrading an independent package" sections, SECURITY, RIM-ADDON-001/RIM-ARTIFACT-INSPECT-001
    // and their llms-full.txt copies. Measured on Node 26: 945207 packed bytes (5175 over 918 KiB), 3740438 unpacked
    // bytes (30486 over 3623 KiB) and 505 entries (1 over 504). Packed raised to 927 KiB, unpacked to 3656 KiB and
    // entries to 510, keeping about 4 KiB, 3.3 KiB and 5 entries of headroom.
    // Re-measured on main after #900 and #901 merged together (each measured alone): Node 26 954042 packed /
    // 3768213 unpacked bytes, 507 entries; CI (Node 24) packed 954811. About 3 KiB of headroom on each.
    // With #834's context fallbacks and plan_feature list vocabulary on top of #903's main, measured on Node 26:
    // 958684 packed / 3783392 unpacked bytes, 507 entries; about 3 KiB of headroom on each.
    // With #844's extension contract on top of main after #905, measured on Node 26: 962375 packed / 3796521
    // unpacked bytes, 507 entries (CI's Node 24 packs ~800 bytes larger); about 3 KiB of headroom on each.
    // With #845 named project schemas on top of #906's main, measured on Node 26: 975469 packed / 3839342
    // unpacked bytes, 511 entries (CI's Node 24 packs ~800 bytes larger); about 3 KiB of headroom on each.
    // With #914 authenticated fixtures on top of #907's main, measured on Node 26: 978735 packed / 3850391
    // unpacked bytes, 511 entries (CI's Node 24 packs ~800 bytes larger); about 3 KiB of headroom on each.
    // With #912/#915 on top of #918's main: measured on Node 26 at 981421 packed / 3858779 unpacked bytes, 511 entries
    // (CI's Node 24 packs ~800 bytes larger); ~3 KiB headroom.
    // With the #911/#916/#917 trial fixes on top of #919's main: measured on Node 26 at 990298 packed / 3912067 unpacked bytes, 515 entries
    // (CI's Node 24 packs ~800 bytes larger); ~3 KiB headroom.
    // With #910/#913 on top of #921's main: measured on Node 26 at 1000001 packed / 3946963 unpacked bytes, 515 entries
    // (CI's Node 24 packs ~800 bytes larger); ~3 KiB headroom.
    // With #917's signal recorder on top of #920's main: measured on Node 26 at 1006712 packed / 3966838 unpacked bytes, 517 entries
    // (CI's Node 24 packs ~800 bytes larger); ~3 KiB headroom.
    // With #908 store named schemas on top of #923's main: measured on Node 26 at 1007745 packed / 3971128 unpacked bytes, 517 entries
    // (CI's Node 24 packs ~800 bytes larger); ~3 KiB headroom.
    // With #902 declared transfers (STORE.md and llms-full.txt): measured on Node 26 at 1008512 packed / 3974160
    // unpacked bytes, 517 entries (CI's Node 24 packs ~800 bytes larger); ~3 KiB headroom.
    // #931 installed-doc links: every relative link a packed Markdown file cannot follow becomes a reference
    // definition pinned to this repository's current version (README, SECURITY, the shipped docs, examples and
    // recipes, with their llms-full.txt copies): measured on Node 26 at 1013978 packed / 4010632 unpacked bytes,
    // 517 entries (CI's Node 24 packs ~800 bytes larger); ~3 KiB headroom.
    // With #927's test:multiprocess script in package.json on top: 1014165 packed / 4011284 unpacked bytes on Node 26,
    // inside these budgets with about 2.8 KiB of headroom on each once Node 24's ~800 extra packed bytes are counted.
    // #932 --local-review and the store-booking/store-credits recipes on top of #937 and #946: measured on Node 26 at 1023556 packed / 4051874 unpacked bytes, 525 entries
    // (CI's Node 24 packs ~800 bytes larger); ~3 KiB headroom.
    // #929 slots, members-gated create and projected readers on top of #942: measured on Node 26 at 1023995 packed / 4053327 unpacked bytes, 525 entries
    // (CI's Node 24 packs ~800 bytes larger); ~3 KiB headroom.
    // #938 installed strings (llms.txt pinned reference definitions, llms-full.txt on the release tag, dist/release.js)
    // on top: measured on Node 26 at 1025624 packed / 4061375 unpacked bytes, 527 entries; ~3 KiB headroom over Node 24.
    // #930 on top of #950: 1033581 packed / 4089059 unpacked bytes, 528 entries (Node 26); +800 bytes for Node 24, ~3 KiB headroom.
    packed: 1014 * 1024,
    // #940 MCP runners pass --local-review on top: 1034337 packed / 4092005 unpacked bytes, 528 entries (Node 26); packed
    // keeps ~3 KiB over Node 24's +800 bytes, unpacked raised for ~3 KiB headroom.
    unpacked: 4000 * 1024,
    entries: 529,
    roots: ['.claude', 'LICENSE', 'NOTICE', 'README.md', 'SECURITY.md', 'data', 'dist', 'docs', 'examples', 'llms-full.txt', 'llms.txt', 'package.json', 'recipes', 'schemas', 'skills', 'starters'],
    optionalPeers: ['typescript'],
  },
  // The generic audit log split out of auth. It has no runtime dependency
  // beyond core and Node built-ins. First measured at 25347/82420/24 packed
  // bytes, unpacked bytes and files.
  '@jimhoyd/urlcode-audit': {
    packed: 35 * 1024,
    unpacked: 110 * 1024,
    entries: 32,
    roots: ['LICENSE', 'NOTICE', 'README.md', 'SECURITY.md', 'dist', 'package.json', 'urlcode.json'],
  },
  '@jimhoyd/urlcode-auth': {
    // Rebuilt on Better Auth (#841, #843): the adapter, definition and CLI with their declarations and docs.
    // First measured at 13593/42819/14 packed bytes, unpacked bytes and files.
    // With #927's README note that auth alone detects no second host: 17700 packed / 54758 unpacked bytes, 14 files on
    // Node 26, 732 packed bytes under the old 18 KiB (CI's Node 24 packs larger); ~3 KiB headroom on each.
    // #930 hermetic runs and seeds on top of #946: 19307 packed / 60677 unpacked bytes, 14 entries (Node 26); +800 bytes for Node 24, ~3 KiB headroom.
    packed: 23 * 1024,
    unpacked: 63 * 1024,
    entries: 20,
    roots: ['LICENSE', 'NOTICE', 'README.md', 'SECURITY.md', 'dist', 'package.json', 'urlcode.json'],
  },
  '@jimhoyd/urlcode-store': {
    // Packed raised from 40 to 42 KiB: clearing a field with null in a partial
    // update and the records export's paginated list (#738: dist/collection.js,
    // dist/records.js and their declarations, and the README contract) take the
    // packed tarball from 40915 to 42040 bytes, just over the old 40 KiB.
    // #822 generated field reference in the README (measured 56504 packed).
    // Raised to 72 KiB packed and 285 KiB unpacked for #835's second slice:
    // declared transitions, transitionOnly fields, result-aware Idempotency-Key
    // replay and host transactions (dist/collection.js, dist/records.js,
    // dist/store.js; the transition schema appears again in collection.d.ts,
    // urlcode.json and the README field reference) measure 68802 packed and
    // 276905 unpacked bytes.
    // Raised to 80 KiB packed and 315 KiB unpacked for #863's membership gates:
    // membership collections, gated transitions and readers mounts
    // (dist/collection.js, dist/store.js), the operator addMember/removeMember/
    // listMembers (dist/membership.js with declarations), the schema again in
    // urlcode.json and the README field reference, and the SECURITY/CHANGELOG
    // contract measure 75895 packed and 308658 unpacked bytes (30 entries).
    // Raised to 86 KiB packed and 340 KiB unpacked for #866's membership follow-ups: the
    // `urlcode-store members` CLI (dist/cli.js), audited membership events and reassign moving membership
    // (dist/collection.js, dist/membership.js, dist/ownership.js with declarations), readers.showOwner and enum
    // filter refusal, the schema again in urlcode.json and the README field reference, and the SECURITY/CHANGELOG
    // contract measure 83457 packed and 334230 unpacked bytes (32 entries).
    // With #873 item 2 (may) and #875 (operator audit, bounded filters) both merged,
    // measured on Node 26: 89093 packed / 354706 unpacked bytes, 32 entries.
    // Raised to 96 KiB packed and 372 KiB unpacked for #861/#881: the JSON Schema 2020-12 record schema (its config
    // schema again in urlcode.json and the README field reference) and the OpenAPI description (dist/openapi.js and
    // its declarations), merged with #897's audit drain status, measure 95170 packed and 371009 unpacked bytes (Node 26).
    // Raised to 100 KiB packed and 375 KiB unpacked for #916/#917: the README's list and error response shapes, its
    // release-pinned reference links and the find-user pointer measure 98949 packed / 379791 unpacked bytes, 32
    // entries (Node 26), keeping about 3.4 KiB and 4.2 KiB of headroom.
    // #908 named record schemas, the collection's defaults/readOnlyProperties and the README "Named schemas" section,
    // on top of #920's main: 103298 packed / 399594 unpacked bytes, 32 entries (Node 26); ~3 KiB headroom on each.
    // #902 declared intervals (their config schema again in urlcode.json and the README field reference, the index
    // and check in dist/collection.js, the OpenAPI 409) and retry-safe host transactions (dist/records.js), with
    // the README/CHANGELOG contract: 114883 packed / 445013 unpacked bytes, 32 entries (Node 26); +3 KiB headroom.
    // #902 declared transfers (their config schema again in urlcode.json and the README field reference, the transfer
    // step in dist/collection.js, the OpenAPI path, StoreExports.transfer) with the README/CHANGELOG contract, on top
    // of the intervals slice: 123421 packed / 483179 unpacked bytes, 32 entries (Node 26); +3 KiB headroom.
    // #927 several serving processes on one host (the declaration fence in dist/collection.js and dist/records.js, the
    // schema 5 migration and drain lease in dist/database.js, dist/topology.{js,d.ts} for the network filesystem check
    // and the server lease) with the README/SECURITY/CHANGELOG contract: 131979 packed / 510186 unpacked bytes,
    // 34 entries (Node 26); +3 KiB headroom.
    // #929 interval length and step, members-gated create and projected readers (dist/collection.js, dist/store.js,
    // dist/openapi.js, the config schema again in urlcode.json and the README field reference) with the
    // README/SECURITY/CHANGELOG contract: 141531 packed / 548781 unpacked bytes, 34 entries (Node 26); +800 bytes for
    // Node 24 and about 3 KiB headroom.
    // #930 seeds on top of #929: 142861 packed / 553427 unpacked bytes, 34 entries (Node 26); +800 bytes for Node 24, ~3 KiB headroom.
    packed: 144 * 1024,
    // Unpacked raised from 120 to 140 KiB: per-record ownership (#331) adds
    // the owner scoping in dist/collection.js and dist/store.js, the operator
    // step for legacy records (dist/ownership.js, the urlcode-store bin
    // dist/cli.js, with declarations) and the ownership contract in
    // SECURITY.md and README.md, taking the unpacked content to 138043 bytes
    // (about 134.8 KiB). It still packs to 35306 bytes, under 40 KiB.
    // Raised from 140 to 150 KiB: the per-owner limit (#731) and the operator
    // `urlcode-store reassign` command (#732: reassignOwner in dist/ownership.js,
    // its CLI and declarations, and its SECURITY.md/README.md contract) take the
    // unpacked content to 150984 bytes (about 147.4 KiB).
    //
    // Raised from 140 to 150 KiB: the records export for other extensions
    // (#529: dist/records.js and its declarations, and the export's contract
    // in SECURITY.md and CHANGELOG.md) took the unpacked content to 146313
    // bytes (about 142.9 KiB).
    // Together, #731/#732 and #529 measure 158673 unpacked bytes (about
    // 155 KiB), so the store budget is 170 KiB unpacked.
    //
    // Raised to 50 KiB packed and 190 KiB unpacked for audited writes (the
    // collection outbox and its producer, with declarations and the
    // README/SECURITY contract): 46693 packed and 177677 unpacked bytes.
    // #822 generated field reference in the README (measured 220290 unpacked).
    // #835 transitions and retries, #863 membership gates: see the packed note above.
    // #866 membership follow-ups: see the packed note above.
    // #861/#881 record schema and OpenAPI description: see the packed note above.
    // With #913 authoring goals and #916 README responses together: 386402 unpacked bytes (Node 26).
    // #908 named record schemas: see the packed note above.
    // #902 intervals and host transaction retries, and declared transfers: see the packed note above.
    // #927 several serving processes on one host and #928 transfer balances kept on delete, together: 133206 packed /
    // 514563 unpacked bytes, 34 entries (Node 26), +3 KiB headroom.
    // #929: see the packed note above.
    unpacked: 544 * 1024,
    // #859 online backup (dist/backup.js and dist/backup.d.ts, CLI usage, README) on top of #863 measures
    // 78786 packed and 317431 unpacked bytes in 32 entries: inside 80/315 KiB, one more entry.
    // #927 adds dist/topology.js and dist/topology.d.ts: 34 entries.
    entries: 34,
    roots: ['LICENSE', 'NOTICE', 'README.md', 'SECURITY.md', 'dist', 'package.json', 'urlcode.json'],
  },
  // Unpacked raised from 140 KiB for the opt-in streaming transport (#659):
  // dist/sessions.{js,d.ts} and the README section took it to 151597 bytes.
  '@jimhoyd/urlcode-mcp': {
    // #822 generated field reference in the README (measured 45653 packed).
    packed: 47 * 1024,
    // #822 generated field reference in the README (measured 177930 unpacked).
    unpacked: 180 * 1024,
    entries: 31,
    roots: ['LICENSE', 'NOTICE', 'README.md', 'SECURITY.md', 'dist', 'package.json', 'urlcode.json'],
  },
  // Artifacts are inert JSON: a few KiB, and the exact file shape below.
  '@jimhoyd/urlcode-store-schema': {
    packed: 16 * 1024,
    unpacked: 64 * 1024,
    entries: 12,
    roots: ['LICENSE', 'NOTICE', 'README.md', 'SECURITY.md', 'config', 'package.json', 'schemas', 'urlcode.json'],
  },
};


/**
 * Checks a package's `npm pack --dry-run` file list beyond its root allowlist: no installed dependency tree
 * (a `node_modules/` path) and no copy of core (`@jimhoyd/urlcode`) may ship inside any package, and an artifact
 * carries only the files core's `isArtifactFile` accepts. Returns one line per offending path.
 */
export function packFileProblems(kind: PackageKind, paths: readonly string[]): string[] {
  const problems: string[] = [];
  for (const path of paths) {
    if (/(?:^|\/)node_modules(?:\/|$)/.test(path)) problems.push(`${path}: node_modules/ must never ship`);
    else if (/(?:^|\/)@jimhoyd\/urlcode(?:[/-]|$)/.test(path)) problems.push(`${path}: a copy of @jimhoyd/urlcode (core or a sibling add-on) must never ship inside a package`);
    else if (kind === 'artifact' && !isArtifactFile(path)) problems.push(`${path}: an artifact carries only package.json, notices, and JSON, YAML or Markdown data`);
  }
  return problems;
}

const INLINE_LINK = /\[[^\]]*\]\(([^()\s]+)\)/g;
const REFERENCE_LINK = /^ {0,3}\[[^\]]+\]:\s+(\S+)/;

/** Whether a packed path is documentation an installed reader follows links in: Markdown and the llms indexes. */
export const isPackedDocument = (path: string): boolean => path.endsWith('.md') || path === 'llms.txt' || path === 'llms-full.txt';
/** This repository's main branch, which may already describe a later release than the one installed (#916, #938). */
const MAIN_BRANCH = /https:\/\/github\.com\/jimhoyd-com\/urlcode\/(?:blob|tree)\/main(?=[/)\s]|$)[^\s)]*/g;

/**
 * Relative link targets in one packed document (`path`, its `source`) that name nothing in the packed file list
 * (#931). An installed copy holds only what `npm pack` ships, so a link that resolves in this checkout but not in
 * the tarball is dead there: ship the target, or link this repository's `blob/v<current version>/...` inside a
 * urlcode-current-version block. Absolute, protocol-relative, mail and bare `#fragment` links are not checked, nor
 * links inside fenced code blocks or code spans. A directory link resolves when anything under it ships. Any mention
 * of this repository's `blob/main` or `tree/main` outside a fence is a problem too, link or not (#938).
 */
export function packedLinkProblems(path: string, source: string, packed: ReadonlySet<string>): string[] {
  const directories = new Set<string>();
  for (const file of packed) for (let index = file.indexOf('/'); index > 0; index = file.indexOf('/', index + 1)) directories.add(file.slice(0, index));
  const problems: string[] = [];
  let fence: string | undefined;
  for (const [index, line] of source.split('\n').entries()) {
    const trimmed = line.trim();
    if (fence) { if (trimmed.startsWith(fence) && /^(`+|~+)$/.test(trimmed)) fence = undefined; continue; }
    const opening = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (opening) { fence = opening[1]; continue; }
    const text = line.replace(/(`+)[^`]*?\1/g, '');
    for (const match of line.matchAll(MAIN_BRANCH)) problems.push(`${path}:${index + 1} names \`${match[0]}\`, this repository's main branch; link blob/v<current version>/... instead`);
    const targets = [...text.matchAll(INLINE_LINK)].map(match => match[1] ?? '');
    const reference = REFERENCE_LINK.exec(line)?.[1];
    if (reference) targets.push(reference);
    for (const target of targets) {
      if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(target)) continue;
      const relativeTarget = target.replace(/[#?].*$/, '');
      if (relativeTarget === '') continue;
      let decoded = relativeTarget;
      try { decoded = decodeURIComponent(relativeTarget); } catch { /* keep the raw target */ }
      const resolved = posix.normalize(posix.join(posix.dirname(path), decoded)).replace(/\/$/, '');
      if (!packed.has(resolved) && !directories.has(resolved)) problems.push(`${path}:${index + 1} links \`${target}\`, but \`${resolved}\` is not in the package`);
    }
  }
  return problems;
}

/** Whether a packed path is code whose string literals reach an installed reader (CLI output, reasons, generated documents). */
export const isPackedCode = (path: string): boolean => /\.[cm]?js$/.test(path);
/** A repository-relative docs page: `docs/X.md` not preceded by a path or URL (a pinned `.../blob/v<version>/docs/X.md` is fine). */
const DOCS_PAGE = /(?<![\w/.-])docs\/[\w./-]+?\.md\b/g;

/**
 * String and template literals in one packed script (`path`, its `source`) that name a `docs/*.md` page the package
 * does not ship (#938). They are printed by the CLI or written into generated output such as an OpenAPI document, so
 * an installed reader meets a path that exists only in this checkout. Name a page that ships, a `urlcode docs search`
 * query, or this release's copy through `docsUrl` (packages/core/src/release.ts). Comments are not read: type
 * stripping keeps source comments in `dist/`, and those address maintainers, not installed readers.
 */
export function packedStringProblems(path: string, source: string, packed: ReadonlySet<string>): string[] {
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const problems: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteralLike(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
      for (const match of node.text.matchAll(DOCS_PAGE)) {
        if (packed.has(match[0])) continue;
        const line = file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;
        problems.push(`${path}:${line} names \`${match[0]}\`, which the package does not ship`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return problems;
}

/** Core (`.`) plus every add-on, in dependency order, as directories relative to `root`. */
export async function auditedPackages(root = repositoryRoot): Promise<{ directory: string; kind: PackageKind }[]> {
  return [{ directory: '.', kind: 'core' }, ...(await addons(root)).map(addon => ({ directory: relative(root, addon.directory), kind: addon.kind }))];
}

function targets(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  return Object.values(value).flatMap(targets);
}

async function auditAll(): Promise<void> {
  // Every add-on is private (so a stray `npm publish` refuses), but its tarball is still a release asset that
  // core's addons.json pins, so `private` is never a reason to skip its package boundary.
  for (const { directory } of await auditedPackages()) {
    const result = spawnSync(process.execPath, [fileURLToPath(import.meta.url), directory], { cwd: repositoryRoot, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr || result.stdout || result.error?.message || `Package audit failed for ${directory}`);
    process.stdout.write(result.stdout);
  }
}

async function auditOne(target: string): Promise<void> {
  const directory = resolve(target);
  const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8')) as {
    name?: string;
    exports?: unknown;
    bin?: Record<string, string>;
    dependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
    peerDependenciesMeta?: Record<string, { optional?: boolean }>;
  };
  const budget = manifest.name ? budgets[manifest.name] : undefined;
  assert(budget, `No package audit policy for ${manifest.name ?? directory}: add a budget for it in scripts/package-audit.ts`);
  const kind: PackageKind = resolve(directory) === resolve(repositoryRoot) ? 'core' : (await auditedPackages()).find(item => resolve(repositoryRoot, item.directory) === resolve(directory))?.kind ?? 'extension';
  const cache = await mkdtemp(join(tmpdir(), 'urlcode-pack-audit-'));
  try {
    const npm = process.env.npm_execpath;
    assert(npm, 'Run the package audit through npm');
    const result = spawnSync(process.execPath, [npm, 'pack', '--dry-run', '--ignore-scripts', '--json'], {
      cwd: directory,
      encoding: 'utf8',
      env: { ...process.env, npm_config_cache: cache },
      timeout: 120_000,
    });
    assert.equal(result.status, 0, result.stderr || result.stdout || result.error?.message || 'npm pack failed');
    const [pack] = parsePackJson<PackReport>(result.stdout, result.stderr);
    assert(pack, 'npm pack reported no package');
    assert.equal(pack.name, manifest.name);

    const allowed = new Set(budget.roots);
    const unexpected = pack.files.map(file => file.path).filter(path => !allowed.has(path.split('/')[0]!));
    assert.deepEqual(unexpected, [], `Unexpected release files:\n${unexpected.join('\n')}`);
    const unsafe = pack.files.map(file => file.path).filter(path =>
      /(?:^|\/)(?:src|test|node_modules)(?:\/|$)/.test(path) ||
      /(?:\.map|\.tsbuildinfo|package-lock\.json|(?:^|\/)\.env(?:\.|$))$/.test(path));
    assert.deepEqual(unsafe, [], `Development or sensitive files in release:\n${unsafe.join('\n')}`);
    const shapeProblems = packFileProblems(kind, pack.files.map(file => file.path));
    assert.deepEqual(shapeProblems, [], `Files that must not ship in ${pack.name}:\n${shapeProblems.join('\n')}`);

    // A path the working tree happens to have locally (an uncommitted build
    // artifact under a wholesale-listed `files` root, e.g. examples/*/dist/)
    // must never ship just because it exists on disk when `npm pack` runs:
    // that makes the tarball's contents depend on build order/history instead
    // of the committed source (see #608). Reject any packed path git would
    // ignore, except the package's own `dist` root: that build output is
    // deliberately gitignored (never committed) yet always the intended
    // shipped content, generated fresh by `npm run build` right before
    // packing.
    const candidates = pack.files.map(file => file.path).filter(path => path.split('/')[0] !== 'dist');
    const repoPaths = candidates.map(path => join(directory, path));
    const ignoreCheck = repoPaths.length > 0
      ? spawnSync('git', ['check-ignore', '--stdin', '-z'], {
        cwd: directory,
        input: repoPaths.join('\0') + '\0',
        encoding: 'utf8',
      })
      : undefined;
    // git check-ignore exits 1 when none of the paths are ignored, which is
    // the expected case; only treat spawn failure (missing git) as fatal.
    assert(!ignoreCheck || ignoreCheck.error === undefined, `Failed to run git check-ignore: ${ignoreCheck?.error?.message}`);
    const ignored = ignoreCheck ? ignoreCheck.stdout.split('\0').map(entry => entry.trim()).filter(Boolean) : [];
    assert.deepEqual(ignored, [], `Gitignored paths present in packed release (nondeterministic local build artifacts, see #608):\n${ignored.join('\n')}`);

    const shipped = new Set(pack.files.map(file => file.path));
    const deadLinks: string[] = [];
    for (const path of [...shipped].filter(isPackedDocument).sort()) deadLinks.push(...packedLinkProblems(path, await readFile(join(directory, path), 'utf8'), shipped));
    assert.deepEqual(deadLinks, [], `Shipped documents link files ${pack.name} does not ship (#931); ship the target, or link this repository's blob/v<current version>/... inside a urlcode-current-version block:\n${deadLinks.join('\n')}`);
    const deadStrings: string[] = [];
    for (const path of [...shipped].filter(isPackedCode).sort()) deadStrings.push(...packedStringProblems(path, await readFile(join(directory, path), 'utf8'), shipped));
    assert.deepEqual(deadStrings, [], `Shipped code names docs pages ${pack.name} does not ship (#938); link this release's copy with docsUrl() from packages/core/src/release.ts, name a shipped page, or a urlcode docs search query:\n${deadStrings.join('\n')}`);
    // Core also carries its add-on pins and the release-wide add-on agent catalog beside them (#721).
    const required = [...targets(manifest.exports), ...Object.values(manifest.bin ?? {}), ...(kind === 'core' ? ['dist/addons.json', 'dist/addon-catalog.json'] : [])]
      .map(path => path.replace(/^\.\//, ''));
    const missing = required.filter(path => !shipped.has(path));
    assert.deepEqual(missing, [], `Package exports or required files are missing:\n${missing.join('\n')}`);
    for (const peer of budget.optionalPeers ?? []) {
      assert(!manifest.dependencies?.[peer], `${peer} must not be a default dependency`);
      assert(manifest.peerDependencies?.[peer], `${peer} needs a declared compatibility range`);
      assert.equal(manifest.peerDependenciesMeta?.[peer]?.optional, true, `${peer} must be an optional peer`);
    }

    if (pack.size > budget.packed) {
      const largest = [...pack.files].sort((a, b) => b.size - a.size).slice(0, 10)
        .map(file => `  ${String(file.size).padStart(9)}  ${file.path}`).join('\n');
      assert.fail([
        `Packed size ${pack.size} exceeds ${budget.packed} bytes for ${pack.name}.`,
        `Budget: ${budget.packed}; actual: ${pack.size}; over by ${pack.size - budget.packed} bytes.`,
        `The budget is the "packed" value for '${pack.name}' in the budgets table in scripts/package-audit.ts; raise it there deliberately, with justification in the PR, only if the growth is intended.`,
        'Otherwise find what grew (compare against main, e.g. git diff --stat main -- dist starters skills schemas recipes examples). Largest uncompressed files in the tarball:',
        largest,
      ].join('\n'));
    }
    assert(pack.unpackedSize <= budget.unpacked, `Unpacked size ${pack.unpackedSize} exceeds ${budget.unpacked} bytes`);
    assert(pack.entryCount <= budget.entries, `Entry count ${pack.entryCount} exceeds ${budget.entries}`);
    console.log(`${pack.name}: ${pack.size} packed bytes, ${pack.unpackedSize} unpacked bytes, ${pack.entryCount} files`);
  } finally {
    await rm(cache, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv[2] === '--all') await auditAll();
  else await auditOne(process.argv[2] ?? '.');
}
