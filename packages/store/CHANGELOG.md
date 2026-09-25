# @jimhoyd/urlcode-store

## Unreleased

**Default behavior change:** `urlcode extensions add` (and `init --with`) now installs only the capability; the new `--example` flag, the same for every extension, writes the sample behavior it used to write by default (#711). A blank `extensions add store` writes an empty `collections` block, no mount and needs no acknowledgement (`collections` may now be empty); `--example` writes the `todos` collection on `/api/todos` and, with ui, its `/todos` screen, and still requires `--ack store:public-write` without auth. To reproduce the old result, add `--example`.

The store owns its CRUD screen (#709). Screens are declared under `extensions.store.config.screens` (`/todos: {collection: todos, title?, columns?}`, the shape that used to live under `extensions.ui.config.screens`), activation refuses a screen naming an undeclared collection, and the definition's optional `contributes.ui.screens` hands ui a generic description of each, so ui no longer reads `extensions.store`. The scaffold adds the `/todos` screen and its `extension: ui` route when ui is installed. `@jimhoyd/urlcode-ui` is declared an optional peer, and `urlcode.json` records the optional edge as `contributes: ["ui"]`.

## 0.5.0

Align the coordinated stable release at `0.5.0` on npm’s `latest` channel. Internal peer minimums advance to this release.

## 0.4.9

Align the coordinated stable release at `0.4.9` on npm’s `latest` channel. Internal peer minimums advance to this release.

## 0.4.6

Align the coordinated stable release at `0.4.6` on npm’s `latest` channel. Internal peer minimums advance to this release.

Versions 0.4.3, 0.4.4 and 0.4.5 were prepared but never published, so npm went from 0.4.2 straight to this release. 0.4.3's candidate failed in the release container (two checks called `git ls-files` on a checkout owned by another user); 0.4.4's publisher stopped at its preflight (the peer-floor guard held core itself to a floor it cannot have); 0.4.5 stopped at the CI gate, where the slowest runner (Windows, Node 22) took over 500 ms for a pattern the guard accepts. The `v0.4.4` tag stays where it is. This release fixes all three, and lowers the input bound for schema `pattern` from 256 to 128 characters (a schema that sets `pattern` now needs `maxLength` of at most 128), which makes the worst accepted pattern about eight times cheaper. It carries every change prepared for 0.4.3, listed in `docs/RELEASE-0.4.3.md`. Highlights: `request.body.schema` validation and `shared` blocks, multi-step fixtures and a quiet `urlcode test`, an unordered `init --with` with a generic `--ack`, store collection sorting and filtering, the data-bound CRUD screen, and the first store release line.

## 0.4.5

Align the coordinated stable release at `0.4.5` on npm’s `latest` channel. Internal peer minimums advance to this release.

Versions 0.4.3 and 0.4.4 were prepared but never published. The 0.4.3 candidate failed in the release container because two checks called `git ls-files` on a checkout owned by another user. The 0.4.4 publisher then stopped at its preflight, which held core itself to a peer floor it cannot have. Nothing was published for either version (npm went from 0.4.2 straight to this release), and the `v0.4.4` tag stays where it is. This release fixes both and carries every change prepared for 0.4.3, listed in `docs/RELEASE-0.4.3.md`. Highlights: `request.body.schema` validation and `shared` blocks, multi-step fixtures and a quiet `urlcode test`, an unordered `init --with` with a generic `--ack`, store collection sorting and filtering, the data-bound CRUD screen, and the first store release line.

## 0.4.4

Align the coordinated stable release at `0.4.4` on npm’s `latest` channel. Internal peer minimums advance to this release.

Version 0.4.3 was prepared but never published: its candidate build failed in the release container because two checks called `git ls-files` on a checkout owned by another user, which git refuses as dubious ownership. Nothing was tagged or published for 0.4.3. This release fixes those checks and carries every change prepared for 0.4.3, listed in `docs/RELEASE-0.4.3.md`, on top of 0.4.2. Highlights: `request.body.schema` validation and `shared` blocks, multi-step fixtures and a quiet `urlcode test`, an unordered `init --with` with a generic `--ack`, the store collection sorting and filtering, the data-bound CRUD screen, and the first store extension release line.

## 0.4.3

Align the coordinated stable release at `0.4.3` on npm’s `latest` channel. Internal peer minimums advance to this release.

Collections declare `sortable` and `filterable` fields; list requests take one `sort=<field>` or `sort=-<field>` and up to three equality filters with a stable id tie-break, sorted pages use an opaque cursor that cannot repeat or skip records, and undeclared or malformed names return 400 naming only the key. Unknown query parameters on a list request now return 400 instead of being ignored. The scaffold refuses a writable mount that no access-control extension protects unless `--ack store:public-write` is passed, and writes the access model into the generated README and routes. The unordered `--with` contract is supported.

The store needs a core release that has `--ack`, the unordered `--with` contract and the extension authoring contract, and its first publication peered on a core that lacks all three. This release's core peer floor is raised to the core release that has them, and release preparation and the publish preflight now refuse a floor below the core API the package uses. The README explains the unknown-option failure an older core produces.

## 0.4.2

First publication, made by hand from the source at commit `7972185` because the release scripts assume a package already exists on npm. It was not built or verified by the release pipeline, so it has no signed `train.json` and no version tag.

It assumes core changes (`--ack`, an unordered `--with`, an extension `authoring` contract) that the published core `0.4.2` does not contain, although its peer range allows that core. Use the next release of both packages; see the version alignment page.
