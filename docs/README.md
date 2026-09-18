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
| Understand exact behavior | [Specification](SPECIFICATION.md), [routing](ROUTING.md), [HTTP](HTTP.md) |
| Run examples | [40-route cookbook](../examples/cookbook/README.md), [prerender recipe](../examples/prerender/README.md), [small starter](STARTERS.md) |
| Let an AI build routes | [The framework](FRAMEWORK.md), [AI authoring guide](AI-AUTHORING.md), [llms.txt](../llms.txt), [SDK and read-only MCP](TOOLING.md) |
| Reuse code around routes | [Middleware](MIDDLEWARE.md), [middleware examples](MIDDLEWARE-EXAMPLES.md) |
| Handle secrets and untrusted code | [Function security](FUNCTION-SECURITY.md) |
| Author guest functions in TypeScript | [Build-time guest transpilation](TYPESCRIPT-AUTHORING.md) |
| Serve pages, files and downloads | [Assets](ASSETS.md) |
| Publish a site with no request-time guest code | [Prerendering helper and recipe](PRERENDER.md) |
| Create and update short links live | [Dynamic links, storage and management API](DYNAMIC-LINKS.md) |
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
| Restyle every extension page and translate copy | [urlcode-ui](https://github.com/jimhoyd-com/urlcode-ui#readme), [ui contract](https://github.com/jimhoyd-com/urlcode-ui/blob/main/CONTRACT.md) |
| Write or install a versioned extension | [Extensions](EXTENSIONS.md), [example fixture](../examples/extensions/README.md) |
| Add host behavior in operator code | [Plugins](PLUGINS.md) |
| Use the API from TypeScript | [TypeScript: shipped declarations, exports, build and fidelity](TYPESCRIPT.md) |

## Operate and deploy

| Goal | Start here |
|---|---|
| Work locally | [Local development](LOCAL-DEVELOPMENT.md), [tunnels](TUNNELS.md) |
| Prove responses and counts | [Readiness](READINESS.md) |
| Check pull requests of a project on GitHub | [CI action, route diffs and the starter workflow](CI.md) |
| Deploy and roll back | [Operations](OPERATIONS.md) |
| Verify a running deployment matches the project | [Deployment checks](DEPLOYMENT-CHECKS.md) |
| Inspect target support | [Capabilities and normalized representation](CAPABILITIES.md) |
| Deploy to Vercel, AWS Lambda or Cloudflare Workers | [Vercel](VERCEL.md), [AWS](AWS.md), [Cloudflare](CLOUDFLARE.md), [provider verification evidence](PROVIDER-VERIFICATION.md) |
| Watch a deployment | [Monitoring](MONITORING.md), [observability](OBSERVABILITY.md) |
| Estimate concurrency and memory | [Capacity and limits](CAPACITY.md), [measurements](PERFORMANCE.md), [load testing](LOAD-TESTING.md) |
| Prepare for overload, DDoS and recovery | [Resilience playbook](RESILIENCE.md) |
| Manage private credentials and audit | [Management security](MANAGEMENT-SECURITY.md) |

## Evidence, reviews and design records

These are dated records, not guides. They say what has been checked and what
has not, and why the design is the way it is.

| Record | What it is |
|---|---|
| [Release readiness](RELEASE-READINESS.md) | Verified safeguards, open gates, supported scope |
| [Usability review](USABILITY-REVIEW.md) | Where the framework is easier or harder than the tools it replaces, and ranked changes |
| [Next steps](NEXT-STEPS.md) | The phased plan: agent discovery, context compression, retrieval, the ladder, benchmarks and the remaining proof gaps |
| [Next-phase implementation status](NEXT-PHASE-PLAN.md) | Source additions after 0.3.0 shipped in 0.4.0-alpha.1, and their evidence limits |
| [Security review](SECURITY-AUDIT.md) | Internal findings and fixes; not an independent test |
| [Standards audit](STANDARDS.md) | How the runtime conforms to the RFCs it touches |
| [Sandbox review package](SANDBOX-REVIEW.md) | What an independent reviewer needs; assessment not yet performed |
| [Operational drills](OPERATIONAL-PROOF.md) | Deployment acceptance drills CI runs |
| [Release security](RELEASE-SECURITY.md) | Candidate signing and publication process |
| [Extension model review](SPIKE-EXTENSION-MODEL.md) | Why extensions are shaped this way, with framework precedents |
| [Extensions spike](SPIKE-EXTENSIONS.md) | The design behind policies and plugins; implemented |
| [Lambda compile spike](SPIKE-LAMBDA-COMPILE.md) | Proposal: per-route Lambdas for functions; not implemented |
| Auth, admin and UI spikes | Live in their repositories: [auth](https://github.com/jimhoyd-com/urlcode-auth/blob/main/docs/SPIKE-AUTH.md), [admin](https://github.com/jimhoyd-com/urlcode-admin/blob/main/docs/SPIKE-ADMIN.md), [ui](https://github.com/jimhoyd-com/urlcode-ui/blob/main/docs/SPIKE-UI.md) |
| [Roadmap](../ROADMAP.md) | Implemented versus planned |

Examples are educational unless backed by the runnable cookbook and fixtures.
Infrastructure limits are deployment settings, not fields to invent in route YAML.
