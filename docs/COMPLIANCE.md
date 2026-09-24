# Compliance rules

A compliance rule is a standards-referenced check over what a project declares
and what the runtime knows about it: the parsed YAML, the route inventory and
policy table from `testPlan()`, the effective policy per route, the public
origin and the logging settings the operator states for the deployment. The
runtime ships three built-in profiles; an operator adds, overrides or disables
rules with code kept outside the project, the same trust boundary as
[plugins](PLUGINS.md) and the `--policy` binding grant; `urlcode audit` prints
every finding with the reference it rests on and sets the exit code.

## What it is and is not

- It checks **declared configuration and runtime facts**. No rule sends a
  request, reads a binding, runs guest code or inspects a running deployment.
  `oshp/hsts-origin` cannot know your TLS terminator; it knows the origin you
  declared with `--origin`, so declare it truthfully.
- A passing run is **not a certification**, an audit opinion or evidence that
  a deployment is secure or lawful. It says the declared configuration matches
  a rule set whose references are listed beside each finding. Deployment,
  soak and recovery proof live in [production readiness](RELEASE-OPERATIONS.md#production-readiness).
- Rules never change behavior. The runtime serves the same responses whether a
  finding exists or not; a rule set is an operator's review checklist in code.
- The built-in rules only check what the runtime can see. Anything a rule
  cannot verify (an undeclared log level, an unknown origin) is reported as an
  `info` finding saying so, never assumed to pass.

## The rule contract

```js
export const rules = [{
  id: 'acme/redirect-hosts',        // ^[a-z][a-z0-9-]{0,31}/[a-z][a-z0-9-]{0,63}$, unique per run
  title: 'Redirects only leave for approved hosts',
  standard: { name: 'ACME link policy', reference: 'https://example.com/policies/links', section: 'Outbound' },
  severity: 'high',                 // high | medium | low | info
  appliesTo: 'route',               // project | route
  check(context) { return []; },    // findings[]; may be async
}];
```

`standard.reference` is a URL, an RFC number (`RFC 9110`) or a path under
`docs/`. `check` returns an array of findings (an empty array, `undefined`,
a single finding or an array); a thrown error fails the run with the rule
named, so a rule cannot silently pass by crashing.

A **project** rule runs once with:

| Field | Value |
|---|---|
| `document` | The parsed and validated `urlcode.yaml` (includes are merged into `routes`) |
| `routes` | Route configuration by pattern, as written in YAML |
| `plan` | `testPlan()`: `inventory[]` (`path`, `handler`, `methods`, `middleware`, `policies`, `state`), `policies` (the per-route describe map) |
| `policies` | `effectivePolicies(document, route)` by pattern: the merged configuration of every policy on each route |
| `origin` | The declared public origin, or `null` |
| `target` | `node` unless the caller states another |
| `host` | `{ requestLog }` as declared for the deployment; `null` where undeclared |

A **route** rule runs once per inventory entry and additionally receives
`route` (the inventory entry), `config` (that route's YAML), `policy` (the
runtime's describe map for the route: `security.emits`, `agents.deny[].revision`,
`cache.cacheControl`, …) and `effective` (the merged policy configuration).

A **finding** is `{ rule, severity, route?, message, remediation, standard }`.
`severity` defaults to the rule's own; a check may lower or raise it for one
finding (the privacy rules report an undeclared setting as `info`). The
runtime fills `rule` and `standard` and the route pattern for route rules.

## Built-in profiles

`strict` contains every `baseline` rule plus its own; `privacy` stands alone;
`none` runs only operator rules. Check derivations reference the runtime's
own code: the security profile tables in `packages/core/src/policies/security.ts`, the
cache and compression secrets handling in `packages/core/src/policies/cache.ts` and
`packages/core/src/policies/compression.ts`, the `no-store` default in
`packages/core/src/http-response.ts`, the 16 KiB header cap in `packages/core/src/http-policy.ts`.

### `baseline`

| Rule | Standard | Severity | Checks | Remediation |
|---|---|---|---|---|
| `oshp/security-headers` | [OWASP Secure Headers Project](https://owasp.org/www-project-secure-headers/) | medium | Every active route has an effective `policies.security` | Declare `policies.security: { headers: oshp }` on the project or the route |
| `oshp/hsts-origin` | OWASP Secure Headers Project, Strict-Transport-Security | low | When any active route's security profile emits HSTS, the declared origin is `https:`; the runtime emits HSTS only then | Serve behind TLS and declare `--origin https://…` |
| `breach/secrets-compression` | [BREACH](https://www.breachattack.com/) | high | No route binding `secrets` sets `policies.compression.allowWithSecrets` | Remove `allowWithSecrets` (the runtime then skips compression on secret routes) |
| `rfc9111/secrets-no-store` | [RFC 9111](https://www.rfc-editor.org/rfc/rfc9111) §5.2.2.5, §5.2.2.7 | medium | A route binding `secrets` declares no cache strategy, Cache-Control or handler `cacheControl` other than `no-store`/`private` | Use `no-store` or `private` on secret routes |
| `rfc9111/cache-control-declared` | RFC 9111 §5.2 | low | `respond` and `redirect` routes declare a `Cache-Control` header or a cache policy; asset handlers declare `cacheControl` (otherwise the runtime defaults `no-store` / assets `no-cache`) | State the intent in `response.headers`, the handler or `policies.cache` |
| `rfc6585/throttle-functions` | [RFC 6585](https://www.rfc-editor.org/rfc/rfc6585) §4 | medium | Every active function or middleware route has an effective `policies.throttle` | Declare a throttle on the route or the project |
| `rfc9309/robots` | [RFC 9309](https://www.rfc-editor.org/rfc/rfc9309) | low | Some active route declares `policies.agents`, or an active `/robots.txt` `respond` route exists | Add a `/robots.txt` route or an agents deny list |
| `rfc9110/expired-routes` | [RFC 9110](https://www.rfc-editor.org/rfc/rfc9110) §15.5.11 | info | Lists routes past `expires` that still answer 410 | Remove them once the 410 window has served its purpose |

### `strict` (baseline plus)

| Rule | Standard | Severity | Checks | Remediation |
|---|---|---|---|---|
| `oshp/csp` | OWASP Secure Headers Project, Content-Security-Policy | medium | Every active route emits `Content-Security-Policy` (security profile minus `unset`, plus `set`, or a YAML response header) | Use the `oshp` profile or set the header |
| `rfc6585/throttle-all` | RFC 6585 §4 | medium | Every active non-function route has an effective throttle (function routes are covered by `throttle-functions`) | Declare `policies.throttle` at the project level |
| `agents/lists-pinned` | [Bundled agent lists](policies/agents.md) | low | Every agents deny/allow list is a bundled list that carries an upstream revision; project `.json` list files report `revision: project` | Prefer bundled lists or record the revision a list was built from |
| `rfc9110/redirect-https` | RFC 9110 §15.4 | medium | No active `redirect.url` starts with `http:` | Redirect to https |
| `http/header-budget` | RFC 9110 §5.4 | low | YAML `response.headers` bytes plus the security profile's static bytes stay at or under 8192, half the runtime's 16 KiB response header cap | Trim headers or the security set |

### `privacy`

These rules check deployment settings, so `audit` takes `--request-log` to
declare the level the deployment uses (the audit process itself always logs
nothing); embedders pass `host` themselves. The references are the runtime's
own [logging guarantees](MONITORING.md): records carry no URL, query, header,
body or binding, and `detailed` adds only the method and route pattern.

| Rule | Standard | Severity | Checks | Remediation |
|---|---|---|---|---|
| `privacy/request-log-minimal` | [Monitoring](MONITORING.md), Log records | medium (`info` when undeclared) | `host.requestLog` is `minimal` | Use the default log unless per-route rates are required |
| `privacy/detailed-log-parameters` | [Monitoring](MONITORING.md), Log records | low | With `detailed` logging, no active route takes parameters (records name the pattern and method, never values) | Keep `minimal` on parameterised deployments |

## Writing custom rules

[`examples/compliance/rules.mjs`](../examples/compliance/rules.mjs) is a
complete operator module; it runs against the cookbook:

```sh
node packages/core/src/cli.ts audit --project examples/cookbook \
  --compliance baseline --compliance-rules "$PWD/examples/compliance/rules.mjs" --compliance-warn
```

A module exports up to three names:

```js
export const rules = [ /* rules to add; an id already in the profile is an error */ ];
export const disable = ['rfc9110/expired-routes'];               // remove built-in or added rules by id
export const override = { 'oshp/security-headers': { severity: 'high' } }; // shallow-merge fields of an existing rule
```

Order is fixed: profile rules, then `rules` added, then `override` applied,
then `disable` removed, then `--compliance-ignore`. The result is validated
as one set, so an override cannot produce an invalid rule.

The module must be an absolute path to an `.mjs`/`.js` file **outside** the
audited project, checked the way `--policy` is (`realpath` of both, the file
may not resolve inside the project root). It is imported as trusted operator
code with the host's privileges, the same standing as a plugin: a project
cannot ship its own rule set and grade itself. Rules read the context they
are given; a rule that reaches for the filesystem or the network is a plugin
in the wrong place.

## CLI

```
urlcode audit [--project dir] [--compliance baseline|strict|privacy|none]
              [--compliance-rules /absolute/rules.mjs] [--compliance-ignore id,id]
              [--compliance-warn] [--origin https://links.example] [--request-log minimal|detailed]
```

Without any compliance flag the audit report is unchanged apart from
`compliance: null`. With one, the report gains a `compliance` section:

```json
{ "profile": "baseline", "rules": 9, "ruleIds": ["oshp/security-headers", "…"], "ignored": [],
  "findings": [{ "rule": "rfc6585/throttle-functions", "severity": "medium", "route": "/hello/{name}",
                 "message": "…", "remediation": "…", "standard": { "name": "RFC 6585 …", "reference": "…", "section": "…" } }],
  "counts": { "high": 0, "medium": 4, "low": 11, "info": 1 }, "pass": true,
  "evidence": { "routes": 21, "active": 19, "policies": ["agents", "cache", "security", "throttle"],
                "files": ["urlcode.yaml", "routes/code.yaml"], "origin": null, "target": "node",
                "host": { "requestLog": "minimal" },
                "scope": "declared configuration and runtime facts; not a deployment or certification" } }
```

`--compliance-rules` alone implies `--compliance baseline`. `--origin` and
`--request-log` describe the deployment under review and are echoed in
`evidence`. Findings are sorted by severity, rule and route.

### Exit codes

| Condition | Exit |
|---|---|
| Readiness failed (`ready: false`) | 1, as before |
| A `high` finding and no `--compliance-warn` | 1 |
| `--compliance-warn`: findings are printed, `pass` is still `false` | 0 unless readiness failed |
| Unknown profile, rules file inside the project, malformed rule or ignore id | 1 with an `error` event on stderr |

## Programmatic API

```js
import { runCompliance, builtinProfiles, validateRules, resolveRules, loadComplianceRules } from '@jimhoyd/urlcode/compliance';
import { createRuntime } from '@jimhoyd/urlcode';

const runtime = await createRuntime('./site');
const report = await runCompliance(runtime, {
  profile: 'strict',                                  // baseline | strict | privacy | none
  rules: [], override: {}, disable: [],               // as a rules module would export them
  ignore: ['rfc9110/expired-routes'],
  origin: 'https://links.example',
  host: { requestLog: 'minimal' }, // what the deployment is configured with
});
await runtime.close();
```

The declarations ship with the package: `ComplianceRule` (with `ProjectRule`
and `RouteRule`, and `ProjectContext`/`RouteContext` for what `check`
receives), `RawFinding` and `Finding`, `ComplianceOptions`, `ComplianceReport`
and `ComplianceProfileName` are all exported from `@jimhoyd/urlcode/compliance`, so a
rules module written in TypeScript is checked against the same contract the
runtime validates at load time:

```ts
import type { ComplianceRule, ComplianceReport } from '@jimhoyd/urlcode/compliance';
import { runCompliance } from '@jimhoyd/urlcode/compliance';

export const rules: ComplianceRule[] = [{
  id: 'acme/redirect-hosts',
  title: 'Redirects only leave for approved hosts',
  standard: { name: 'ACME link policy', reference: 'https://example.com/policies/links', section: 'Outbound' },
  severity: 'high',
  appliesTo: 'route',
  check(context) {
    if (context.config.redirect?.url.startsWith('https://acme.example/')) return [];
    return [{ message: `${context.route.path} redirects outside the approved hosts`, remediation: 'Point the redirect at an approved host' }];
  },
}];
const report: ComplianceReport = await runCompliance(runtime, { profile: 'strict', rules });
```

`runCompliance` accepts a started server from `startServer` or a runtime from
`createRuntime`; it re-reads the YAML from the runtime's `root` and takes the
plan from `testPlan()`, so rules see what the runtime compiled.
`auditProject(app, { compliance })` runs the same and attaches the report
under `compliance`. `builtinProfiles` maps profile names to their frozen rule
arrays for reuse or inspection; `validateRules` checks a rule array;
`resolveRules` builds the final set from a profile and operator additions.

## Extending with a plugin-style workflow

Keep rule modules where you keep plugins: in the operator application, under
version control, reviewed like code, outside every audited project. A shared
module can export rules that read the same policy tables a plugin's
`onActivate(runtime)` sees through `testPlan()`, so one review of "what does
this runtime enforce" serves both. Compose organisation rules on top of a
built-in profile with `override` for stricter severities and `disable` for
rules that a documented decision replaces, and run `urlcode audit
--compliance strict --compliance-rules …` in CI with the exit code as the
gate. Record the report beside the readiness and benchmark evidence for the
revision; a report proves what was declared at that commit, nothing more.
