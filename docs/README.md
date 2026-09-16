# URLCode documentation

For runtime 0.1.0-alpha.8. Use documentation pinned to your runtime revision;
`version: "1"` is an alpha contract, not a stable release declaration.

| Goal | Start here |
|---|---|
| Generate placeholders from YAML | [Scaffolding](SCAFFOLDING.md) |
| Write YAML with examples | [YAML guide and recipes](YAML-GUIDE.md) |
| Look up every accepted field | [Generated field reference](YAML-REFERENCE.md), [JSON Schema](../schemas/urlcode.schema.json) |
| Let an AI build routes | [AI authoring guide](AI-AUTHORING.md), [llms.txt](../llms.txt) |
| Run examples | [17-route cookbook](../examples/cookbook/README.md), [small starter](STARTERS.md) |
| Create/update short links live | [Dynamic links, storage and management API](DYNAMIC-LINKS.md) |
| Understand exact behavior | [Specification](SPECIFICATION.md), [routing](ROUTING.md), [HTTP](HTTP.md) |
| Reuse code around routes | [Middleware](MIDDLEWARE.md) |
| Serve pages/files/downloads | [Assets](ASSETS.md) |
| Keep code and YAML readable | [Organization and readability practices](BEST-PRACTICES.md) |
| Organize YAML across folders | [Organization](ORGANIZATION.md) |
| Work locally | [Local development](LOCAL-DEVELOPMENT.md) |
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
