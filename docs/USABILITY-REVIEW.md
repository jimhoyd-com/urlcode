# Usability review: URLCode against the tools people reach for instead

Status: an honest assessment written 2026-09-18 against the source in the four
repositories at that date. It is opinion grounded in the code and docs, not a
benchmark. Its purpose is to name the friction a first-time user or an AI
agent meets, compare it with what competing tools do, and rank the changes
that would matter most. It does not change any contract by itself.

## 1. Who the competitors are, by rung

URLCode is not one product; it competes with a different tool on each rung
of [the ladder](FRAMEWORK.md#the-ladder).

| Rung | What people use today | Where URLCode is better | Where it is worse today |
|---|---|---|---|
| Redirects, responses | Netlify `_redirects`, Cloudflare `_redirects`/Rules, Vercel `vercel.json`, nginx | One portable file that validates before deploy, tests with fixtures, counts routes, converts from those formats and refuses lossy conversions | Those files are two columns; `urlcode.yaml` needs `version`, a route key and a handler object. Nobody needs a validator for ten redirects |
| Pages, files | Any static host, Astro, Hugo | Same file, no build step, native ranges/ETags, `site` conventions | No content pipeline, no templating for pages outside the extension kit |
| Functions, middleware | Cloudflare Workers, Vercel Functions, Hono, Express | Real isolation with a fresh heap per call; typed args from YAML; secrets only by revision-pinned grant; runs the same on a laptop | No `fetch`, no timers, no streaming, no npm packages in guests. Every framework above lets you call an API from a function; here you declare a `proxy` or stop |
| Live links | Bitly, Dub, Short.io, a Postgres table | Records without reloads, versioned writes, private management API, no account system to run | Single host SQLite that needs a patched Node build; no dashboard until you install admin |
| Accounts | Clerk, Auth0, Auth.js, Better Auth, Lucia, Supabase Auth, Devise | Everything is operator-owned and reviewable: no vendor, no callback URLs on someone else's dashboard, no per-MAU bill; passkeys, OIDC, TOTP, recovery and an account page in one package | Install is a reviewed-tarball ritual, a host file, a SHA-256 pin and a JSON-on-stdin bootstrap. Clerk is `npm i` and one env var. Better Auth is a config object and a CLI migration |
| Administration | Django admin, Rails Administrate, Retool, Forest Admin, Supabase Studio | Built on the same service with two-person cases and audited reveal, which none of the generic admins give you | Only manages auth's entities; there is no way to expose the project's own data. Django admin is one line per model |
| Full app in one place | Rails, Django, Laravel, Next.js + Clerk + Prisma, Supabase | The whole thing is declarative and portable; an agent can generate and validate it without a build; the trust boundary between generated code and the operator is explicit | Everything that is not a route, a function or an account is out of scope: no data model, no ORM, no forms for your own tables, no client bundle, no email templates for your app |

The honest summary: URLCode wins on portability, validation, isolation and
operator ownership, and loses on the first fifteen minutes and on anything
that needs application data.

## 2. The first fifteen minutes

What a new person does today, compared with the fastest competitor at each
step. Times are what the docs imply, not measurements.

| Step | URLCode today | Fastest competitor | Gap |
|---|---|---|---|
| Install | `npm i -g @jimhoyd/urlcode` or brew or a checksum script; three channels documented at equal weight | `npx create-next-app` | Too many equal choices on the first screen. Pick one, put the rest in the install guide |
| First project | `urlcode init` writes a function route, a redirect and fixtures | `wrangler init` | Equal |
| First redirect | 5 lines of YAML for one redirect | 1 line in `_redirects` | Acceptable once, heavy for 200. `bulk-import` exists but a person starting small never learns it |
| First function | Must know: `parameters` with `schema`, `args` with `from: path`, the Request/Response subset, that `fetch` is absent | Hono: `app.get('/x', c => c.json(...))` | The typed-args design is right but needs a two-line minimal form. Today the smallest function route is 10 lines |
| Add accounts | Clone two private repos, build tarballs with `pack-sources.mjs --core --auth --ui --admin --core-revision SHA`, install four tarballs, `urlcode-auth init`, compute `inspectExtensionRevision`, paste the SHA into an env var, `bootstrap` with JSON on stdin, `serve --host-file --origin` | Clerk: `npm i @clerk/nextjs`, one env var, wrap the app | This is the largest gap in the framework. Most of it is a consequence of the packages being unpublished and of the revision pin, and it is the step the README leads with |
| Add admin | `urlcode-admin init` writes everything | Django `admin.site.register(Model)` | Comparable once installed |
| Deploy | Container, Node process, or an adapter that refuses functions, links and extensions | `vercel deploy` | The refusals are correct but the person learns them at deploy time. `urlcode capabilities` exists and is not in the quick start |

## 3. What an AI agent meets

The framework's claim is that an agent should build from a handful of
redirects to a full application without rebuilding the core. Measured
against that claim:

- **Strong:** one JSON Schema, a generated field reference, fixtures the agent
  must write, `validate`, `test` and `audit` that give exact failures with the
  route named, an MCP server for read-only inspection, and a capability
  matrix that lists what does not exist. Few frameworks tell an agent what it
  cannot do. This is the right foundation.
- **Weak:** the documentation was organized by feature history rather than by
  task. Before this review, `llms.txt` listed 40 documents at equal weight,
  three of them status logs, and the README opened with release history and
  "unreleased source" caveats. An agent reading it spent its context on
  provenance rather than on the shape of a project. The framework page and the
  reorganized index in this change address that; the remaining cost is the
  size of the reference documents themselves (the YAML guide, policies and
  dynamic links are each over 400 lines).
- **Missing:** an agent cannot yet discover the extension packages' YAML from
  the core schema. `extensions.auth.config` is validated by auth's schema at
  activation, but there is no way to ask the installed runtime "what config
  does `auth` accept" without the host file. A `urlcode extensions --schema`
  command that reads the host file and prints each extension's configuration
  and policy schemas would close this, and would let `urlcode mcp` serve them.
- **Missing:** no single command creates the whole layered project. Today it
  is `urlcode init`, then `urlcode-auth init`, then `urlcode-admin init`, each
  with its own directory conventions. One `urlcode init --with auth,admin`
  that delegates to the installed extension packages' scaffolds would make
  the ladder real for an agent.

## 4. Ranked recommendations

Ordered by how much each would change the experience per unit of work, and
whether it touches a contract.

1. **Publish the three extension packages** (even as `0.1.0-alpha` with the
   caveats their status files carry). Every install step in section 2's
   "add accounts" row except the revision pin existed because they were
   unpublished. This was a decision, not code; the repositories already had
   the release checks. No contract change. Done 2026-09-18: all three are on
   npm as `0.1.0-alpha.1` (review still pending, issue 58).
2. **`urlcode init --with auth,admin,ui`.** Delegate to each installed
   package's existing scaffold; write one host file and one README. No contract
   change; a CLI addition in core that calls into optional peers.
3. **Print extension schemas.** `urlcode extensions --host-file … --json`
   listing each registered extension's name, version, configuration schema and
   policy schema, and expose it through `urlcode mcp`. No contract change.
4. **A short form for the common function route.** Allow `function:
   functions/hello.mjs` as a string with path parameters inferred as required
   strings of bounded length, expanding to today's long form. This is a schema
   addition (`version: "1"` stays valid) and the single largest cut in YAML
   for first-time users and agents. Needs the usual generated-reference and
   cookbook updates.
5. **Lead the README with the ladder, not the release history.** Done in this
   change; keep it that way. Move status caveats to the readiness register.
6. **One install channel on the first screen.** npm first; brew, script and
   container in the install guide.
7. **Fold the `presentation`/`ui` split.** Auth and admin still render through
   the primitives while the kit is the documented way to restyle. Finishing
   kit adoption (already listed in the ui status file) removes the one place
   where the framework's story and its code differ.
8. **Later, and a real contract question:** application data. The thing every
   competitor on the last rung has and URLCode does not is a place for the
   project's own records with an admin view. The runtime already has one
   bounded store (links) and one admin surface (auth's entities). Whether a
   declared `collection` handler with operator-owned SQLite and an admin
   registration belongs in the framework is the next spike worth writing.
   Without it, "full-fledged application" means "site with accounts".

## 5. What is fine and should stay

- The operator host file. It is the reason the project can be untrusted and
  portable at the same time; Clerk's convenience is bought with a vendor in
  the loop. Keep the boundary, make the file generated.
- The revision pin. It is unusual and it is what makes "an agent changed the
  YAML" a reviewable event rather than a silent grant. Keep it, print it
  loudly, and make `init` write it.
- Refusing instead of degrading on every target. The failure names the route.
- The capability matrix in the AI guide. Extend it to the extension packages
  rather than softening it.
