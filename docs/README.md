# URLCode documentation

Choose a starting point, then use the topic directory below when you need detail.
Use documentation from the same pinned revision as your runtime.

| I want to… | Start here |
|---|---|
| Understand what URLCode does | [Framework](FRAMEWORK.md) |
| Build my first project | [Installation](INSTALL.md), then [YAML guide](YAML-GUIDE.md) |
| Build a site with UI, accounts and admin | [Composing a site](COMPOSING-A-SITE.md) |
| Have an AI author a project | [AI authoring](AI-AUTHORING.md), [agent index](../llms.txt), [hosted agent guide](https://urlcode.ai/llms.txt) |
| Deploy and operate a project | [Operations](OPERATIONS.md) |
| Contribute to URLCode | [Contributing](../CONTRIBUTING.md), [local development](LOCAL-DEVELOPMENT.md) |

The [specification](SPECIFICATION.md) owns implemented semantics; the
[generated field reference](YAML-REFERENCE.md) lists accepted fields.
[Project direction](PROJECT-DIRECTION.md) explains the product boundary.

## Author a project

| Goal | Start here |
|---|---|
| Install the CLI | [Installation](INSTALL.md) |
| Write YAML with examples | [YAML guide and recipes](YAML-GUIDE.md) |
| Look up every accepted field | [Generated field reference](YAML-REFERENCE.md), [JSON Schema](../schemas/urlcode.schema.json) |
| Load authoring/operations rules into an agent | [Authoring skill](../.claude/skills/urlcode-authoring/SKILL.md), [operations skill](../.claude/skills/urlcode-operations/SKILL.md), [how they are distributed](AI-AUTHORING.md#agent-skills) |
| Understand exact behavior | [Specification](SPECIFICATION.md), [routing](ROUTING.md), [HTTP](HTTP.md) |
| Run examples | [Executable cookbook](../examples/cookbook/README.md), [prerender recipe](../examples/prerender/README.md), [small starter](STARTERS.md) |
| Let an AI build routes | [The framework](FRAMEWORK.md), [AI authoring guide](AI-AUTHORING.md), [llms.txt](../llms.txt), [hosted agent guide](https://urlcode.ai/llms.txt), [SDK and read-only MCP](TOOLING.md) |
| Reuse code around routes | [Middleware](MIDDLEWARE.md), [middleware examples](MIDDLEWARE-EXAMPLES.md) |
| Handle secrets and decide what to sandbox | [Function security](FUNCTION-SECURITY.md) |
| Author guest functions in TypeScript | [Build-time guest transpilation](TYPESCRIPT-AUTHORING.md) |
| Serve pages, files and downloads | [Assets](ASSETS.md) |
| Publish a site with no request-time guest code | [Prerendering helper and recipe](PRERENDER.md) |
| Select response branches | [Exact conditions](CONDITIONS.md) |
| Proxy an API or emit a webhook | [Bounded egress and operator grants](EGRESS.md) |
| Throttle, block agents, set security headers, compress or cache | [Policies](POLICIES.md): [throttle](policies/throttle.md), [agents](policies/agents.md), [security](policies/security.md), [compression](policies/compression.md), [cache](policies/cache.md) |
| Generate robots.txt, sitemap.xml, favicon, security.txt and llms.txt | [Site conventions](SITE.md) |
| Organize YAML across folders | [Organization](ORGANIZATION.md), [readability practices](BEST-PRACTICES.md) |
| Generate placeholders from YAML | [Scaffolding](SCAFFOLDING.md) |
| Convert provider redirect files | [Strict interchange and conversion reports](INTERCHANGE.md) |
| Import thousands of redirects | [Bulk import and scale evidence](BULK.md) |
| Reuse local project recipes | [Recipe catalog](RECIPES.md) |
| Check declared configuration against standards-referenced rules | [Compliance](COMPLIANCE.md) |

## Extend the runtime

| Goal | Start here |
|---|---|
| Add accounts, sign-in and protected routes | [urlcode-auth](../packages/auth#readme), [auth security](../packages/auth/SECURITY.md) |
| Manage users, sessions, roles and audit | [urlcode-admin](../packages/admin#readme) |
| Restyle every extension page and translate copy | [urlcode-ui](../packages/ui#readme), [ui contract](../packages/ui/CONTRACT.md) |
| Serve a declared collection as a CRUD API (`store` extension) | [Data store](STORE.md) |
| Write or install a versioned extension | [Extensions](EXTENSIONS.md), [example fixture](../examples/extensions/README.md) |
| Pin verified data-only extension schemas for tools or agents | [Signed declarative artifacts](EXTENSIONS.md#signed-declarative-artifacts), [tooling and MCP](TOOLING.md) |
| Know which core version an extension package supports, and how it says so | [Core version alignment](VERSION-ALIGNMENT.md) |
| Add host behavior in operator code | [Plugins](PLUGINS.md) |
| Use the API from TypeScript | [TypeScript: shipped declarations, exports, build and fidelity](TYPESCRIPT.md) |
| Implement URLCode behavior in another runtime | [Runtime implementation guide](RUNTIME-IMPLEMENTATION.md) |

## Operate and deploy

| Goal | Start here |
|---|---|
| Work locally | [Local development](LOCAL-DEVELOPMENT.md), [tunnels](TUNNELS.md) |
| Prove responses and counts | [Readiness](READINESS.md) |
| Check pull requests of a project on GitHub | [CI action, route diffs and the starter workflow](CI.md) |
| Deploy and roll back | [Operations](OPERATIONS.md) |
| Review security boundaries and reporting | [Security](../SECURITY.md), [sandbox review](SANDBOX-REVIEW.md) |
| Assess release readiness | [Evidence and open gates](RELEASE-READINESS.md) |
| See unfinished work | [Roadmap](../ROADMAP.md) |
| Verify a running deployment matches the project | [Deployment checks](DEPLOYMENT-CHECKS.md) |
| Inspect target support | [Capabilities and normalized representation](CAPABILITIES.md) |
| Deploy to Vercel, AWS Lambda or Cloudflare Workers | [Vercel](VERCEL.md), [AWS](AWS.md), [Cloudflare](CLOUDFLARE.md), [provider verification evidence](PROVIDER-VERIFICATION.md) |
| Watch a deployment | [Monitoring](MONITORING.md), [observability](OBSERVABILITY.md) |
| Estimate concurrency and memory | [Capacity and limits](CAPACITY.md), [load testing](LOAD-TESTING.md) |
| Prepare for overload, DDoS and recovery | [Resilience playbook](RESILIENCE.md) |

## Direction and evidence

Start with [principles and open decisions](OPEN-DECISIONS.md) for a plain-language
review and [the roadmap](../ROADMAP.md) for next work. Current behavior belongs
in the guides above and the [specification](SPECIFICATION.md).

- [Release readiness](RELEASE-READINESS.md), [sandbox review](SANDBOX-REVIEW.md)
  and [provider evidence](PROVIDER-VERIFICATION.md)
  distinguish implementation from evidence still missing.
- [Version alignment](VERSION-ALIGNMENT.md) and [release security](RELEASE-SECURITY.md)
  describe peer compatibility and publication.
- Framework-comparison research and evidence are kept in a private maintainer
  repository; they are not implementation promises or public evidence.
- Historical maintainer planning and review records are maintained privately; current roadmap, open decisions, and public contracts are authoritative.

Examples are educational unless backed by runnable fixtures. Infrastructure
limits are deployment settings, not fields to invent in route YAML.
