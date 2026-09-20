# URLCode documentation

Start with [the framework](FRAMEWORK.md): the four packages, the ladder from
redirects to a full application, the composition contract and the rules an AI
agent must follow. [Project direction](PROJECT-DIRECTION.md) states the
boundary and the license. Use documentation pinned to your runtime revision;
`version: "1"` is the stable project-format contract for this release line.

## Author a project

| Goal | Start here |
|---|---|
| Install the CLI | [Installation](INSTALL.md) |
| Write YAML with examples | [YAML guide and recipes](YAML-GUIDE.md) |
| Look up every accepted field | [Generated field reference](YAML-REFERENCE.md), [JSON Schema](../schemas/urlcode.schema.json) |
| Let an AI build routes | [AI authoring guide](AI-AUTHORING.md), [llms.txt](../llms.txt) |
| Load authoring/operations rules into an agent | [Authoring skill](../.claude/skills/urlcode-authoring/SKILL.md), [operations skill](../.claude/skills/urlcode-operations/SKILL.md), [how they are distributed](AI-AUTHORING.md#agent-skills) |
| Run examples | [25-route cookbook](../examples/cookbook/README.md), [prerender recipe](../examples/prerender/README.md), [small starter](STARTERS.md) |
| Understand exact behavior | [Specification](SPECIFICATION.md), [routing](ROUTING.md), [HTTP](HTTP.md) |
| Run examples | [40-route cookbook](../examples/cookbook/README.md), [prerender recipe](../examples/prerender/README.md), [small starter](STARTERS.md) |
| Let an AI build routes | [The framework](FRAMEWORK.md), [AI authoring guide](AI-AUTHORING.md), [llms.txt](../llms.txt), [SDK and read-only MCP](TOOLING.md) |
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
| Add accounts, sign-in and protected routes | [urlcode-auth](https://github.com/jimhoyd-com/urlcode-auth#readme) |
| Manage users, sessions, roles and audit | [urlcode-admin](https://github.com/jimhoyd-com/urlcode-admin#readme) |
| Restyle every extension page and translate copy | [urlcode-ui](../packages/ui#readme), [ui contract](../packages/ui/CONTRACT.md) |
| Write or install a versioned extension | [Extensions](EXTENSIONS.md), [example fixture](../examples/extensions/README.md) |
| Follow implementation of the auth, admin and UI extensions | [Extension implementation sequence](archive/2026-09-19/EXTENSION-IMPLEMENTATION.md) |
| Know which core version an extension package supports, and how it says so | [Core version alignment](VERSION-ALIGNMENT.md) |
| Add host behavior in operator code | [Plugins](PLUGINS.md) |
| Use the API from TypeScript | [TypeScript: shipped declarations, exports, build and fidelity](TYPESCRIPT.md) |

## Operate and deploy

| Goal | Start here |
|---|---|
| Work locally | [Local development](LOCAL-DEVELOPMENT.md), [tunnels](TUNNELS.md) |
| Prove responses and counts | [Readiness](READINESS.md) |
| Check pull requests of a project on GitHub | [CI action, route diffs and the starter workflow](CI.md) |
| Deploy and roll back | [Operations](OPERATIONS.md) |
| Review security findings and gaps | [Internal security audit](SECURITY-AUDIT.md) |
| Assess release readiness | [Evidence and open gates](RELEASE-READINESS.md) |
| See unfinished work | [Roadmap](../ROADMAP.md) |
| Read why per-route Lambda compilation was declined | [Lambda compile spike (archived)](archive/2026-09-19/SPIKE-LAMBDA-COMPILE.md) |
| Verify a running deployment matches the project | [Deployment checks](DEPLOYMENT-CHECKS.md) |
| Inspect target support | [Capabilities and normalized representation](CAPABILITIES.md) |
| Deploy to Vercel, AWS Lambda or Cloudflare Workers | [Vercel](VERCEL.md), [AWS](AWS.md), [Cloudflare](CLOUDFLARE.md), [provider verification evidence](PROVIDER-VERIFICATION.md) |
| Watch a deployment | [Monitoring](MONITORING.md), [observability](OBSERVABILITY.md) |
| Estimate concurrency and memory | [Capacity and limits](CAPACITY.md), [measurements](PERFORMANCE.md), [load testing](LOAD-TESTING.md) |
| Prepare for overload, DDoS and recovery | [Resilience playbook](RESILIENCE.md) |

## Direction and evidence

Start with [principles and open decisions](OPEN-DECISIONS.md) for a plain-language
review and [the roadmap](../ROADMAP.md) for next work. Current behavior belongs
in the guides above and the [specification](SPECIFICATION.md).

- [Release readiness](RELEASE-READINESS.md), [security audit](SECURITY-AUDIT.md),
  [sandbox review](SANDBOX-REVIEW.md) and [provider evidence](PROVIDER-VERIFICATION.md)
  distinguish implementation from evidence still missing.
- [Version alignment](VERSION-ALIGNMENT.md) and [release security](RELEASE-SECURITY.md)
  describe peer compatibility and publication.
- Open proposals: [middleware layering](SPIKE-CORE-LAYERING.md),
  [agent benchmark](SPIKE-AI-FRAMEWORK-BENCHMARK.md), and
  [business suite](SPIKE-BUSINESS-SUITE.md). None is an implementation promise.
- [Historical plans and reviews](archive/README.md) are archived separately.

Examples are educational unless backed by runnable fixtures. Infrastructure
limits are deployment settings, not fields to invent in route YAML.
