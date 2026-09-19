import { getCapabilities } from './capabilities.ts';
import type { CapabilityName } from './capabilities.ts';
import { registry } from './policies.ts';
import { generatedPaths } from './site.ts';
import { assert } from './errors.ts';

/** Where the packaged agent skill lives, relative to the installed @jimhoyd/urlcode package. */
export const skillPath = 'skills/urlcode/SKILL.md';
/** The MCP registration file `urlcode init` writes beside the project (Claude Code and Codex read this shape). */
export const mcpConfigFile = '.mcp.json';
/**
 * Renders `.mcp.json` registering the read-only `urlcode mcp` server for the project at `project`, relative
 * to the file. `--allow-authoring` is deliberately absent: the operator adds it by hand when they want it.
 */
export function renderMcpConfig(project = '.'): string {
  assert(/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/.test(project) && !project.split('/').includes('..'), 'MCP project path must be a relative path without ..');
  return JSON.stringify({ mcpServers: { urlcode: { command: 'urlcode', args: ['mcp', '--project', project] } } }, null, 2) + '\n';
}
const handlerNames: readonly CapabilityName[] = ['redirect','respond','page','static','download','function','link','proxy','conditional','extension'];

/**
 * The application-level AGENTS.md written by `urlcode init`. Built from the
 * installed runtime's capability catalog, so it names only the handlers,
 * policies and site keys this version implements. Under 80 lines by design.
 */
export function renderAgentsGuide({ routes }: { routes: number }): string {
  assert(Number.isInteger(routes) && routes >= 0 && routes <= 100000, 'Route count must be a non-negative integer');
  const catalog = getCapabilities('self-hosted');
  const native = new Set(catalog.capabilities.filter(row => row.targets['self-hosted']?.support === 'native').map(row => row.capability));
  const handlers = handlerNames.filter(name => native.has(name));
  const policies = Object.keys(registry).filter(name => native.has(`policies.${name}` as CapabilityName));
  const site = Object.entries(generatedPaths).map(([key, path]) => `\`${key}\` (${path})`);
  return `# Working on this project

This project uses URLCode: URL behavior is declared in \`urlcode.yaml\`, and the
installed \`@jimhoyd/urlcode\` runtime serves it. There is no framework code to
write for routing, validation, middleware wiring, policies, static serving or
authentication; the runtime provides them. Read this file before changing anything.

## Before writing code

1. Inspect \`urlcode.yaml\` first, then every file its \`includes\` list names,
   the referenced functions, middleware and \`tests/requests.json\`. Preserve the
   existing organization and every route you were not asked to change.
2. Run \`urlcode capabilities\` to see what this runtime version implements and
   which targets support it; \`urlcode capabilities --target NAME\` before
   promising any provider deployment.
3. Run \`urlcode recipes list\` and \`urlcode recipes show NAME\` before writing a
   route from scratch. If a recipe covers the need, add it with
   \`urlcode recipes add NAME --out DIR\` and adapt the copy.
4. Prefer YAML over code. Prefer native handlers over functions.

## Ask the runtime through MCP first

\`${mcpConfigFile}\` registers the read-only \`urlcode mcp\` server. When it is
available, prefer its tools over reading documents: \`get_context\`,
\`get_capability\`, \`get_schema\`, \`search_recipes\`, \`explain\`, \`get_manifest\`.
The CLI equivalents are the fallback: \`urlcode context\`, \`urlcode capabilities NAME\`,
\`urlcode schema PATH\`, \`urlcode recipes search TEXT\`, \`urlcode explain PATH\`,
\`urlcode manifest\`. \`--allow-authoring\` is an operator opt-in; never add it yourself.

## What the runtime provides (this version)

- Handlers, exactly one per route: ${handlers.map(name => `\`${name}\``).join(', ')}.
- Ordered \`middleware\` around any handler, declared in YAML, trusted by default.
- Validated inputs: \`parameters\`, \`request.body\` and \`methods\` on the route;
  functions receive validated \`args\`, never raw user input.
- Policies, host-enforced and off by default: ${policies.map(name => `\`${name}\``).join(', ')}.
- Site conventions under \`site\`, each generating one native route: ${site.join(', ')}.
- Bindings: named \`env\` and \`secrets\` references resolved by the operator, never values in YAML.

Never recreate any of these in a function; a missing one is a report, not an
invitation to reimplement it.

## Functions and middleware are trusted by default; sandbox is opt-in

A route's \`function\`/\`middleware\` code runs trusted, in-process, with full
Node/filesystem/\`fetch\` access, receiving only the declared/granted \`args\`
and \`env\`/\`secrets\`. Add \`sandbox: true\` when code warrants isolation
(untrusted input, an unreviewed contribution, an especially sensitive
secret): that route then gets a text/JSON subset only, no Node/filesystem/
outside imports — use \`proxy\`/a binding instead, and say why in \`description\`.

## Checks that count as evidence

\`\`\`sh
urlcode validate --local
urlcode test
urlcode audit --expect-routes ${routes}
\`\`\`

Run all three after every change, updating the route count deliberately and
adding \`tests/requests.json\` fixtures for every new route (positive/negative,
every active method, HEAD). No global install: use \`node /path/to/urlcode/src/cli.ts\`.

## Rules

- Report unsupported requirements instead of inventing fields. The schema is
  exact; a field the validator rejects does not exist. Say what is missing.
- Never create or approve operator grants. Request a named binding in YAML and
  stop; the operator grants it outside this project, pinned to the revision.
- Secrets stay out of the project: no keys, tokens or credentials in YAML,
  functions, fixtures, \`.env\` files that are not ignored, or commit messages.
- Authentication is host processing: declare \`auth\` on the route, never build
  login forms, sessions or password checks in functions.
- Validation, tests and the audit are the evidence. Local checks are not a
  deployment, a soak test or a security review; do not claim otherwise.

The installed package ships an agent skill with the same loop at
\`${skillPath}\` inside \`@jimhoyd/urlcode\` (for example
\`node_modules/@jimhoyd/urlcode/${skillPath}\`).
`;
}
