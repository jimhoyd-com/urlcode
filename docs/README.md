# URLCode documentation

Choose a starting point, then use the topic directory below when you need detail.
Use documentation from the same pinned revision as your runtime. New to the
vocabulary? Read [Concepts][docs/CONCEPTS.md] first — route, handler, middleware,
policy, extension; project vs operator; trusted vs sandbox; extension vs
artifact — before the guides below use those words without redefining them.

| I want to… | Start here |
|---|---|
| Learn the vocabulary before anything else | [Concepts][docs/CONCEPTS.md] |
| Understand what URLCode does | [Framework][docs/FRAMEWORK.md] |
| Build my first project | [Installation][docs/INSTALL.md], then [YAML guide][docs/YAML-GUIDE.md] |
| Build a redirect | [Redirects][docs/yaml/redirects.md] |
| Build a JSON API | [Functions, inputs and methods][docs/yaml/functions.md] |
| Build a static site, or deploy to S3 + CloudFront | [Static hosting][docs/STATIC.md] |
| Build a site with accounts and data | [Framework: the composition contract][docs/FRAMEWORK.md#the-composition-contract] |
| Have an AI author a project | [AI authoring](AI-AUTHORING.md), [agent index](../llms.txt), [hosted agent guide](https://urlcode.ai/llms.txt) |
| Deploy and operate a project | [Operations][docs/OPERATIONS.md] |
| Contribute to URLCode | [Contributing][CONTRIBUTING.md], [local development][docs/LOCAL-DEVELOPMENT.md] |

The [specification][docs/SPECIFICATION.md] owns implemented semantics; the
[generated field reference](YAML-REFERENCE.md) lists accepted fields.
[Project direction][docs/PROJECT-DIRECTION.md] explains the product boundary.

## Author a project

| Goal | Start here |
|---|---|
| Install the CLI | [Installation][docs/INSTALL.md] |
| Write YAML with examples | [YAML guide and recipes][docs/YAML-GUIDE.md] |
| Look up every accepted field | [Generated field reference](YAML-REFERENCE.md), [JSON Schema](../schemas/urlcode.schema.json) |
| Load authoring/operations rules into an agent | [Authoring skill](../.claude/skills/urlcode-authoring/SKILL.md), [operations skill](../.claude/skills/urlcode-operations/SKILL.md), [how they are distributed](AI-AUTHORING.md#agent-skills) |
| Understand exact behavior | [Specification][docs/SPECIFICATION.md], [routing][docs/ROUTING.md], [HTTP][docs/HTTP.md] |
| Run examples | [Executable cookbook](../examples/cookbook/README.md), [prerender recipe](../examples/prerender/README.md), [small starter][docs/STARTERS.md] |
| Let an AI build routes | [The framework][docs/FRAMEWORK.md], [AI authoring guide](AI-AUTHORING.md), [llms.txt](../llms.txt), [hosted agent guide](https://urlcode.ai/llms.txt), [SDK and read-only MCP](TOOLING.md) |
| Reuse code around routes | [Middleware][docs/MIDDLEWARE.md], [middleware examples][docs/MIDDLEWARE-EXAMPLES.md] |
| Handle secrets and decide what to sandbox | [Function security](FUNCTION-SECURITY.md) |
| Author guest functions in TypeScript | [Build-time guest transpilation][docs/TYPESCRIPT-AUTHORING.md] |
| Serve pages, files and downloads | [Assets][docs/ASSETS.md] |
| Publish a site with no request-time guest code | [Prerendering helper and recipe][docs/PRERENDER.md] |
| Select response branches | [Exact conditions][docs/CONDITIONS.md] |
| Proxy an API or emit a webhook | [Bounded egress and operator grants][docs/EGRESS.md] |
| Throttle, block agents, set security headers, compress or cache | [Policies][docs/POLICIES.md]: [throttle][docs/policies/throttle.md], [agents][docs/policies/agents.md], [security][docs/policies/security.md], [compression][docs/policies/compression.md], [cache][docs/policies/cache.md] |
| Generate robots.txt, sitemap.xml, favicon, security.txt and llms.txt | [Site conventions][docs/SITE.md] |
| Organize YAML across folders | [Organization][docs/ORGANIZATION.md], [readability practices][docs/BEST-PRACTICES.md] |
| Generate placeholders from YAML | [Scaffolding][docs/SCAFFOLDING.md] |
| Import thousands of redirects | [Bulk import and scale evidence][docs/BULK.md] |
| Reuse local project recipes | [Recipe catalog][docs/RECIPES.md] |
| Check declared configuration against standards-referenced rules | [Compliance][docs/COMPLIANCE.md] |
| Review a project or an agent's change in a browser | [Review report and studio](TOOLING.md#review-report) |

## Extend the runtime

| Goal | Start here |
|---|---|
| Add accounts, sign-in and protected routes | [urlcode-auth][packages/auth#readme], [auth security][packages/auth/SECURITY.md] |
| Keep an audit log | [urlcode-audit][packages/audit#readme] |
| Accept a form, rate-limit it and send email | [contact-form recipe](../recipes/contact-form/README.md), [`policies.throttle`][docs/policies/throttle.md] |
| Build the frontend over store collections | [store: a frontend for the collection][docs/STORE.md#a-frontend-for-the-collection], [private-requests client][proofs/private-requests/client/main.js] |
| Serve a declared collection as a CRUD API (`store` extension) | [Data store][docs/STORE.md] |
| Add, remove or write an extension | [Extensions][docs/EXTENSIONS.md], [add-ons][docs/EXTENSIONS.md#add-ons-extensions-and-artifacts], [example fixture](../examples/extensions/README.md) |
| Install inert extension schemas for tools or agents | [Artifacts][docs/EXTENSIONS.md#artifacts], [tooling and MCP](TOOLING.md) |
| Know which core version an extension package supports, and how it says so | [Core version alignment][docs/VERSION-ALIGNMENT.md] |
| Add host behavior in operator code | [Plugins][docs/PLUGINS.md] |
| Use the API from TypeScript | [TypeScript: shipped declarations, exports, build and fidelity][docs/TYPESCRIPT.md] |
| Implement URLCode behavior in another runtime | [Runtime implementation guide][docs/RUNTIME-IMPLEMENTATION.md] |

## Operate and deploy

| Goal | Start here |
|---|---|
| Work locally | [Local development][docs/LOCAL-DEVELOPMENT.md], [tunnels][docs/TUNNELS.md] |
| Prove responses and counts | [Readiness][docs/READINESS.md] |
| Check pull requests of a project on GitHub | [CI action, route diffs and the starter workflow][docs/CI.md] |
| Deploy and roll back | [Operations][docs/OPERATIONS.md] |
| Review security boundaries and reporting | [Security](../SECURITY.md), [sandbox review][docs/SANDBOX-REVIEW.md] |
| Assess production readiness | [Evidence and open gates][docs/RELEASE-OPERATIONS.md#production-readiness] |
| See unfinished work | [Roadmap][ROADMAP.md] |
| Verify a running deployment matches the project | [Deployment checks][docs/DEPLOYMENT-CHECKS.md] |
| Inspect target support | [Capabilities and normalized representation][docs/CAPABILITIES.md] |
| Deploy to Vercel, AWS Lambda or Cloudflare Workers | [Vercel][docs/VERCEL.md], [AWS][docs/AWS.md], [Cloudflare][docs/CLOUDFLARE.md], [provider verification evidence][docs/PROVIDER-VERIFICATION.md] |
| Watch a deployment | [Monitoring][docs/MONITORING.md], [observability][docs/OBSERVABILITY.md] |
| Estimate concurrency and memory | [Capacity and limits][docs/CAPACITY.md], [load testing][docs/LOAD-TESTING.md] |
| Prepare for overload, DDoS and recovery | [Resilience playbook][docs/RESILIENCE.md] |

## Direction and evidence

Start with [principles and open decisions][docs/OPEN-DECISIONS.md] for a plain-language
review and [the roadmap][ROADMAP.md] for next work. Current behavior belongs
in the guides above and the [specification][docs/SPECIFICATION.md].

- [Production readiness][docs/RELEASE-OPERATIONS.md#production-readiness], [sandbox review][docs/SANDBOX-REVIEW.md]
  and [provider evidence][docs/PROVIDER-VERIFICATION.md]
  distinguish implementation from evidence still missing.
- [Version alignment][docs/VERSION-ALIGNMENT.md] and [release security][docs/RELEASE-SECURITY.md]
  describe peer compatibility and publication.
- Framework-comparison research and evidence are kept in a private maintainer
  repository; they are not implementation promises or public evidence.
- Historical maintainer planning and review records are maintained privately; current roadmap, open decisions, and public contracts are authoritative.

Examples are educational unless backed by runnable fixtures. Infrastructure
limits are deployment settings, not fields to invent in route YAML.

<!-- urlcode-current-version:start -->
[docs/CONCEPTS.md]: https://github.com/jimhoyd-com/urlcode/blob/v0.6.5/docs/CONCEPTS.md
[docs/FRAMEWORK.md]: https://github.com/jimhoyd-com/urlcode/blob/v0.6.5/docs/FRAMEWORK.md
[docs/INSTALL.md]: https://github.com/jimhoyd-com/urlcode/blob/v0.6.5/docs/INSTALL.md
[docs/YAML-GUIDE.md]: https://github.com/jimhoyd-com/urlcode/blob/v0.6.5/docs/YAML-GUIDE.md
[docs/yaml/redirects.md]: https://github.com/jimhoyd-com/urlcode/blob/v0.6.5/docs/yaml/redirects.md
[docs/yaml/functions.md]: https://github.com/jimhoyd-com/urlcode/blob/v0.6.5/docs/yaml/functions.md
[docs/STATIC.md]: https://github.com/jimhoyd-com/urlcode/blob/v0.6.5/docs/STATIC.md
[docs/FRAMEWORK.md#the-composition-contract]: https://github.com/jimhoyd-com/urlcode/blob/v0.6.5/docs/FRAMEWORK.md#the-composition-contract
[docs/OPERATIONS.md]: https://github.com/jimhoyd-com/urlcode/blob/v0.6.5/docs/OPERATIONS.md
[CONTRIBUTING.md]: https://github.com/jimhoyd-com/urlcode/blob/v0.6.5/CONTRIBUTING.md
[docs/LOCAL-DEVELOPMENT.md]: https://github.com/jimhoyd-com/urlcode/blob/v0.6.5/docs/LOCAL-DEVELOPMENT.md
[docs/SPECIFICATION.md]: https://github.com/jimhoyd-com/urlcode/blob/v0.6.5/docs/SPECIFICATION.md
[docs/PROJECT-DIRECTION.md]: https://github.com/jimhoyd-com/urlcode/blob/v0.6.5/docs/PROJECT-DIRECTION.md
[docs/ROUTING.md]: https://github.com/jimhoyd-com/urlcode/blob/v0.6.5/docs/ROUTING.md
[docs/HTTP.md]: https://github.com/jimhoyd-com/urlcode/blob/v0.6.5/docs/HTTP.md
[docs/STARTERS.md]: https://github.com/jimhoyd-com/urlcode/blob/v0.6.5/docs/STARTERS.md
[docs/MIDDLEWARE.md]: https://github.com/jimhoyd-com/urlcode/blob/v0.6.5/docs/MIDDLEWARE.md
[docs/MIDDLEWARE-EXAMPLES.md]: https://github.com/jimhoyd-com/urlcode/blob/v0.6.5/docs/MIDDLEWARE-EXAMPLES.md
[docs/TYPESCRIPT-AUTHORING.md]: https://github.com/jimhoyd-com/urlcode/blob/v0.6.5/docs/TYPESCRIPT-AUTHORING.md
[docs/ASSETS.md]: https://github.com/jimhoyd-com/urlcode/blob/v0.6.5/docs/ASSETS.md
[docs/PRERENDER.md]: https://github.com/jimhoyd-com/urlcode/blob/v0.6.5/docs/PRERENDER.md
[docs/CONDITIONS.md]: https://github.com/jimhoyd-com/urlcode/blob/v0.6.5/docs/CONDITIONS.md
[docs/EGRESS.md]: https://github.com/jimhoyd-com/urlcode/blob/v0.6.5/docs/EGRESS.md
[docs/POLICIES.md]: https://github.com/jimhoyd-com/urlcode/blob/v0.6.5/docs/POLICIES.md
[docs/policies/throttle.md]: https://github.com/jimhoyd-com/urlcode/blob/v0.6.5/docs/policies/throttle.md
[docs/policies/agents.md]: https://github.com/jimhoyd-com/urlcode/blob/v0.6.5/docs/policies/agents.md
[docs/policies/security.md]: https://github.com/jimhoyd-com/urlcode/blob/v0.6.5/docs/policies/security.md
[docs/policies/compression.md]: https://github.com/jimhoyd-com/urlcode/blob/v0.6.5/docs/policies/compression.md
[docs/policies/cache.md]: https://github.com/jimhoyd-com/urlcode/blob/v0.6.5/docs/policies/cache.md
[docs/SITE.md]: https://github.com/jimhoyd-com/urlcode/blob/v0.6.5/docs/SITE.md
[docs/ORGANIZATION.md]: https://github.com/jimhoyd-com/urlcode/blob/v0.6.5/docs/ORGANIZATION.md
[docs/BEST-PRACTICES.md]: https://github.com/jimhoyd-com/urlcode/blob/v0.6.5/docs/BEST-PRACTICES.md
[docs/SCAFFOLDING.md]: https://github.com/jimhoyd-com/urlcode/blob/v0.6.5/docs/SCAFFOLDING.md
[docs/BULK.md]: https://github.com/jimhoyd-com/urlcode/blob/v0.6.5/docs/BULK.md
[docs/RECIPES.md]: https://github.com/jimhoyd-com/urlcode/blob/v0.6.5/docs/RECIPES.md
[docs/COMPLIANCE.md]: https://github.com/jimhoyd-com/urlcode/blob/v0.6.5/docs/COMPLIANCE.md
[packages/auth#readme]: https://github.com/jimhoyd-com/urlcode/tree/v0.6.5/packages/auth#readme
[packages/auth/SECURITY.md]: https://github.com/jimhoyd-com/urlcode/blob/v0.6.5/packages/auth/SECURITY.md
[packages/audit#readme]: https://github.com/jimhoyd-com/urlcode/tree/v0.6.5/packages/audit#readme
[docs/STORE.md#a-frontend-for-the-collection]: https://github.com/jimhoyd-com/urlcode/blob/v0.6.5/docs/STORE.md#a-frontend-for-the-collection
[proofs/private-requests/client/main.js]: https://github.com/jimhoyd-com/urlcode/blob/v0.6.5/proofs/private-requests/client/main.js
[docs/STORE.md]: https://github.com/jimhoyd-com/urlcode/blob/v0.6.5/docs/STORE.md
[docs/EXTENSIONS.md]: https://github.com/jimhoyd-com/urlcode/blob/v0.6.5/docs/EXTENSIONS.md
[docs/EXTENSIONS.md#add-ons-extensions-and-artifacts]: https://github.com/jimhoyd-com/urlcode/blob/v0.6.5/docs/EXTENSIONS.md#add-ons-extensions-and-artifacts
[docs/EXTENSIONS.md#artifacts]: https://github.com/jimhoyd-com/urlcode/blob/v0.6.5/docs/EXTENSIONS.md#artifacts
[docs/VERSION-ALIGNMENT.md]: https://github.com/jimhoyd-com/urlcode/blob/v0.6.5/docs/VERSION-ALIGNMENT.md
[docs/PLUGINS.md]: https://github.com/jimhoyd-com/urlcode/blob/v0.6.5/docs/PLUGINS.md
[docs/TYPESCRIPT.md]: https://github.com/jimhoyd-com/urlcode/blob/v0.6.5/docs/TYPESCRIPT.md
[docs/RUNTIME-IMPLEMENTATION.md]: https://github.com/jimhoyd-com/urlcode/blob/v0.6.5/docs/RUNTIME-IMPLEMENTATION.md
[docs/TUNNELS.md]: https://github.com/jimhoyd-com/urlcode/blob/v0.6.5/docs/TUNNELS.md
[docs/READINESS.md]: https://github.com/jimhoyd-com/urlcode/blob/v0.6.5/docs/READINESS.md
[docs/CI.md]: https://github.com/jimhoyd-com/urlcode/blob/v0.6.5/docs/CI.md
[docs/SANDBOX-REVIEW.md]: https://github.com/jimhoyd-com/urlcode/blob/v0.6.5/docs/SANDBOX-REVIEW.md
[docs/RELEASE-OPERATIONS.md#production-readiness]: https://github.com/jimhoyd-com/urlcode/blob/v0.6.5/docs/RELEASE-OPERATIONS.md#production-readiness
[ROADMAP.md]: https://github.com/jimhoyd-com/urlcode/blob/v0.6.5/ROADMAP.md
[docs/DEPLOYMENT-CHECKS.md]: https://github.com/jimhoyd-com/urlcode/blob/v0.6.5/docs/DEPLOYMENT-CHECKS.md
[docs/CAPABILITIES.md]: https://github.com/jimhoyd-com/urlcode/blob/v0.6.5/docs/CAPABILITIES.md
[docs/VERCEL.md]: https://github.com/jimhoyd-com/urlcode/blob/v0.6.5/docs/VERCEL.md
[docs/AWS.md]: https://github.com/jimhoyd-com/urlcode/blob/v0.6.5/docs/AWS.md
[docs/CLOUDFLARE.md]: https://github.com/jimhoyd-com/urlcode/blob/v0.6.5/docs/CLOUDFLARE.md
[docs/PROVIDER-VERIFICATION.md]: https://github.com/jimhoyd-com/urlcode/blob/v0.6.5/docs/PROVIDER-VERIFICATION.md
[docs/MONITORING.md]: https://github.com/jimhoyd-com/urlcode/blob/v0.6.5/docs/MONITORING.md
[docs/OBSERVABILITY.md]: https://github.com/jimhoyd-com/urlcode/blob/v0.6.5/docs/OBSERVABILITY.md
[docs/CAPACITY.md]: https://github.com/jimhoyd-com/urlcode/blob/v0.6.5/docs/CAPACITY.md
[docs/LOAD-TESTING.md]: https://github.com/jimhoyd-com/urlcode/blob/v0.6.5/docs/LOAD-TESTING.md
[docs/RESILIENCE.md]: https://github.com/jimhoyd-com/urlcode/blob/v0.6.5/docs/RESILIENCE.md
[docs/OPEN-DECISIONS.md]: https://github.com/jimhoyd-com/urlcode/blob/v0.6.5/docs/OPEN-DECISIONS.md
[docs/RELEASE-SECURITY.md]: https://github.com/jimhoyd-com/urlcode/blob/v0.6.5/docs/RELEASE-SECURITY.md
<!-- urlcode-current-version:end -->
