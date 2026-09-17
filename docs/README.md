# URLCode documentation

Start with [project direction](PROJECT-DIRECTION.md) for what URLCode is, what it
is not, how application projects fit, and the license.

For runtime 0.2.0. Use documentation pinned to your runtime revision.
`version: "1"` is the stable project-format contract for this release line.

| Goal | Start here |
|---|---|
| Install the CLI | [Installation](INSTALL.md) |
| Generate placeholders from YAML | [Scaffolding](SCAFFOLDING.md) |
| Write YAML with examples | [YAML guide and recipes](YAML-GUIDE.md) |
| Look up every accepted field | [Generated field reference](YAML-REFERENCE.md), [JSON Schema](../schemas/urlcode.schema.json) |
| Let an AI build routes | [AI authoring guide](AI-AUTHORING.md), [llms.txt](../llms.txt) |
| Run examples | [25-route cookbook](../examples/cookbook/README.md), [prerender recipe](../examples/prerender/README.md), [small starter](STARTERS.md) |
| Explore a standalone application | [URLCode Shortener demo](https://github.com/jimhoyd-com/urlcode-shortener), [build retrospective](https://github.com/jimhoyd-com/urlcode-shortener/blob/main/docs/BUILD-RETROSPECTIVE.md) |
| Explore a static docs-site integration | [URLCode Docs project](https://github.com/jimhoyd-com/urlcode-docs), [build retrospective](https://github.com/jimhoyd-com/urlcode-docs/blob/main/docs/BUILD-RETROSPECTIVE.md) — synced from this repository, which remains the source of truth |
| Create/update short links live | [Dynamic links, storage and management API](DYNAMIC-LINKS.md) |
| Understand exact behavior | [Specification](SPECIFICATION.md), [routing](ROUTING.md), [HTTP](HTTP.md) |
| Reuse code around routes | [Middleware](MIDDLEWARE.md) |
| Throttle, block agents, set security headers, compress or cache from YAML | [Policies](POLICIES.md): [throttle](policies/throttle.md), [agents](policies/agents.md), [security](policies/security.md), [compression](policies/compression.md), [cache](policies/cache.md) |
| Add host behavior in operator code | [Plugins](PLUGINS.md) |
| Use the API from TypeScript | [TypeScript: shipped declarations, exports, build and fidelity](TYPESCRIPT.md) |
| Check declared configuration against standards-referenced rules | [Compliance](COMPLIANCE.md) |
| See how the runtime conforms to the standards it uses | [Standards audit](STANDARDS.md) |
| Serve pages/files/downloads | [Assets](ASSETS.md) |
| Generate robots.txt, sitemap.xml, favicon, security.txt and llms.txt | [Site conventions](SITE.md) |
| Publish a site with no request-time guest code | [Prerendering helper and recipe](PRERENDER.md) |
| Keep code and YAML readable | [Organization and readability practices](BEST-PRACTICES.md) |
| Organize YAML across folders | [Organization](ORGANIZATION.md) |
| Work locally | [Local development](LOCAL-DEVELOPMENT.md) |
| Share a local project publicly | [Tunnels](TUNNELS.md) |
| Watch a deployment | [Monitoring](MONITORING.md) |
| Wire your own monitoring or scrape metrics | [Observability](OBSERVABILITY.md) |
| Load test a deployment | [Load testing](LOAD-TESTING.md) |
| Deploy to Vercel | [Vercel adapter](VERCEL.md) |
| Deploy to AWS Lambda | [AWS adapter](AWS.md) |
| Deploy to Cloudflare Workers | [Cloudflare target](CLOUDFLARE.md) |
| Handle secrets/untrusted code | [Function security](FUNCTION-SECURITY.md) |
| Prove responses and counts | [Readiness](READINESS.md) |
| Verify a running deployment matches the project | [Deployment checks](DEPLOYMENT-CHECKS.md) |
| Check pull requests of a project on GitHub | [CI action, route diffs and the starter workflow](CI.md) |
| Estimate concurrency/memory | [Capacity and limits](CAPACITY.md), [measurements](PERFORMANCE.md) |
| Prepare for overload/DDoS/recovery | [Resilience playbook](RESILIENCE.md) |
| Deploy and roll back | [Operations](OPERATIONS.md) |
| Review security findings and gaps | [Internal security audit](SECURITY-AUDIT.md) |
| Assess release readiness | [Evidence and open gates](RELEASE-READINESS.md) |
| See unfinished work | [Roadmap](../ROADMAP.md) |
| Read the design behind policies, plugins and templates | [Extensions spike](SPIKE-EXTENSIONS.md) |
| Read the design for an authentication and authorization plugin | [Auth spike](SPIKE-AUTH.md) |
| Read the design for the administration extension that manages users | [Admin spike](SPIKE-ADMIN.md) |
| Read the design for the shared template kit every extension renders with | [UI kit spike](SPIKE-UI.md) |
| Read the review of the extension model, its precedents and alignment | [Extension model review](SPIKE-EXTENSION-MODEL.md) |

Examples are educational unless backed by the runnable cookbook/fixtures.
Infrastructure limits are deployment settings, not fields to invent in route YAML.

## Security and acceptance

- [Independent sandbox review package](SANDBOX-REVIEW.md)
- [Private management credentials and atomic audit](MANAGEMENT-SECURITY.md)
- [Operational drills and deployment acceptance](OPERATIONAL-PROOF.md)
- [Candidate signing and release security](RELEASE-SECURITY.md)
