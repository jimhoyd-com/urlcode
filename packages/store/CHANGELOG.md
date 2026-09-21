# @jimhoyd/urlcode-store

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
