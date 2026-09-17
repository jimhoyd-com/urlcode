# URLCode documentation

Start with [project direction](PROJECT-DIRECTION.md) for what URLCode is, what it
is not, how application projects and a future managed Cloud fit, and why the
runtime uses the Apache-2.0 license.

For runtime 0.1.0. Use documentation pinned to your runtime revision.
`version: "1"` is the stable project-format contract for this release line.

| Goal | Start here |
|---|---|
| Install the CLI | [Installation](INSTALL.md) |
| Generate placeholders from YAML | [Scaffolding](SCAFFOLDING.md) |
| Write YAML with examples | [YAML guide and recipes](YAML-GUIDE.md) |
| Look up every accepted field | [Generated field reference](YAML-REFERENCE.md), [JSON Schema](../schemas/urlcode.schema.json) |
| Let an AI build routes | [AI authoring guide](AI-AUTHORING.md), [llms.txt](../llms.txt) |
| Run examples | [17-route cookbook](../examples/cookbook/README.md), [prerender recipe](../examples/prerender/README.md), [small starter](STARTERS.md) |
| Explore a standalone application | [URLCode Shortener demo](https://github.com/jimhoyd-com/urlcode-shortener), [build retrospective](https://github.com/jimhoyd-com/urlcode-shortener/blob/main/docs/BUILD-RETROSPECTIVE.md) |
| Explore a static docs-site integration | [URLCode Docs project](https://github.com/jimhoyd-com/urlcode-docs), [build retrospective](https://github.com/jimhoyd-com/urlcode-docs/blob/main/docs/BUILD-RETROSPECTIVE.md) — synced from this repository, which remains the source of truth |
| Create/update short links live | [Dynamic links, storage and management API](DYNAMIC-LINKS.md) |
| Understand exact behavior | [Specification](SPECIFICATION.md), [routing](ROUTING.md), [HTTP](HTTP.md) |
| Reuse code around routes | [Middleware](MIDDLEWARE.md) |
| Serve pages/files/downloads | [Assets](ASSETS.md) |
| Publish a site with no request-time guest code | [Prerendering helper and recipe](PRERENDER.md) |
| Keep code and YAML readable | [Organization and readability practices](BEST-PRACTICES.md) |
| Organize YAML across folders | [Organization](ORGANIZATION.md) |
| Work locally | [Local development](LOCAL-DEVELOPMENT.md) |
| Share a local project publicly | [Tunnels](TUNNELS.md) |
| Watch a deployment | [Monitoring](MONITORING.md) |
| Load test a deployment | [Load testing](LOAD-TESTING.md) |
| Handle secrets/untrusted code | [Function security](FUNCTION-SECURITY.md) |
| Prove responses and counts | [Readiness](READINESS.md) |
| Estimate concurrency/memory | [Capacity and limits](CAPACITY.md), [measurements](PERFORMANCE.md) |
| Prepare for overload/DDoS/recovery | [Resilience playbook](RESILIENCE.md) |
| Deploy and roll back | [Operations](OPERATIONS.md) |
| Review security findings and gaps | [Internal security audit](SECURITY-AUDIT.md) |
| Assess release readiness | [Evidence and open gates](RELEASE-READINESS.md) |
| See unfinished work | [Roadmap](../ROADMAP.md) |

Examples are educational unless backed by the runnable cookbook/fixtures.
Infrastructure limits are deployment settings, not fields to invent in route YAML.

## Security and acceptance

- [Independent sandbox review package](SANDBOX-REVIEW.md)
- [Private management credentials and atomic audit](MANAGEMENT-SECURITY.md)
- [Operational drills and deployment acceptance](OPERATIONAL-PROOF.md)
- [Candidate signing and release security](RELEASE-SECURITY.md)
