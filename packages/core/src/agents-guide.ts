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
 * `local` is for a project whose package.json pins the runtime: the server is then launched through `npx --no`,
 * which uses the installed copy and refuses to fetch anything (a bare `urlcode` is not on PATH for a local-only install,
 * and `npx urlcode` would resolve an unrelated registry package). Without a pin the bare command is kept for global installs.
 */
export function renderMcpConfig(project = '.', { local = false }: { local?: boolean } = {}): string {
  assert(/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/.test(project) && !project.split('/').includes('..'), 'MCP project path must be a relative path without ..');
  const server = local ? { command: 'npx', args: ['--no', '--package', '@jimhoyd/urlcode', 'urlcode', 'mcp', '--project', project] } : { command: 'urlcode', args: ['mcp', '--project', project] };
  return JSON.stringify({ mcpServers: { urlcode: server } }, null, 2) + '\n';
}
const handlerNames: readonly CapabilityName[] = ['redirect','respond','page','static','download','function','proxy','conditional','extension'];

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
  const auditGuidance = routes === 0
    ? 'With no active routes, this initial audit intentionally exits nonzero with `no-active-routes`. Add the first route and its fixture, then make the audit pass; remove `allow-empty-project: true` from the generated GitHub workflow at that point.'
    : 'Run all three after every change.';
  return `# Working on this project

This project uses URLCode: URL behavior is declared in \`urlcode.yaml\`, and the
installed runtime supplies routing, validation, middleware wiring, policies,
static serving and authentication. Read this file before changing anything.

## Before writing code

1. Inspect \`urlcode.yaml\` first, then every file its \`includes\` list names,
   referenced code and \`tests/requests.json\` when present. Preserve unrelated routes.
2. Make one bounded query first: MCP \`get_context\` when the \`urlcode\` server is
   registered, else \`urlcode context --project DIR\` (add \`--budget N\` to cap
   it). It returns a compact summary, constraints and exact commands.
3. Then retrieve only what the task needs: \`capabilities NAME\`/\`get_capability\`
   (limits; \`--target NAME\` before promising a provider), \`get_schema\`,
   \`recipes search TEXT\`/\`search_recipes\` then \`recipes add NAME --out DIR\`,
   \`explain\` and, with an operator host file, \`get_extensions\`. Bare
   \`capabilities\` and \`recipes list\` are complete catalogs: fallback, not step one. Do not read or grep \`llms-full.txt\` or the packaged docs for a routine task.
4. Use URLCode's highest-level declarative features whenever possible. Generate custom code only when the framework cannot express the requirement. Check supported extensions and recipes first; explain any capability gap.

## MCP

When present, \`${mcpConfigFile}\` registers the read-only \`urlcode mcp\` server; prefer its
tools (also \`get_manifest\`) to reading documents. Inspect \`get_extensions\` before
replacing extension behavior. \`--allow-authoring\` is an operator opt-in; never add it. For a committed artifact lock, use \`get_extension_artifacts\`/\`get_extension_artifact\`; they expose verified inert data and never activate an extension. [URLCode AI](https://urlcode.ai/) is a separate optional hosted service for shared skills and LLM tooling; its remote MCP never replaces this local project server, and its credential belongs only in a client secret facility, never project files. Its machine-readable entry point is \`https://urlcode.ai/llms.txt\`.

## What the runtime provides (this version)

- Handlers, exactly one per route: ${handlers.map(name => `\`${name}\``).join(', ')}.
- Ordered \`middleware\` around any handler, declared in YAML, trusted by default.
- Validated route \`parameters\`, \`request.body\`, \`methods\` and function \`args\`.
- Policies, host-enforced and off by default: ${policies.map(name => `\`${name}\``).join(', ')}.
- Site conventions under \`site\`, each generating one native route: ${site.join(', ')}.
- Bindings: named \`env\` and \`secrets\` references resolved by the operator, never values in YAML.

Never recreate these in a function; report a missing capability.

## Build one application

Treat routes, extensions and UI as one application with different owners. Use
published surfaces in order: configuration/theme/copy, smallest template, CSS,
then a declared hook. Keep auth/admin security and workflows package-owned; add
an extension only for a reusable missing capability. Use the official shadcn/ui
skill only in a React frontend with \`components.json\`; start with \`shadcn info
--json\`. Do not put React components in the server renderer.

## Functions and middleware are trusted by default; sandbox is opt-in

A \`function\`/\`middleware\` is trusted, in-process Node: its injected context holds only declared \`args\`/\`env\`/\`secrets\`,
but the code keeps Node's ambient authority (\`process.env\`, filesystem, network, installed modules); that is not confinement.
Add \`sandbox: true\` for code needing isolation, not merely untrusted input. The sandbox is text/JSON-only; use \`proxy\`/a binding and
record the reason in \`sandboxReason\`. Try \`redirect\` (relative or \`/**\`) or \`respond\` first; a function gets \`context.route.pattern\`.

## Checks that count as evidence

\`\`\`sh
urlcode validate --local
urlcode test
urlcode audit --expect-routes ${routes}
\`\`\`

${auditGuidance} \`N\` counts declared routes plus one route for each active \`site.*\` convention; an audit mismatch reports the declared/generated split. Update it deliberately and add \`tests/requests.json\` fixtures for every new route (positive/negative, every active method, HEAD). A case is \`{path, status, method?, headers?, body?, expectHeaders?, expectBody?}\` and nothing else (the runtime's \`schemas/requests.schema.json\`): send JSON as a text \`body\` with a \`content-type\` header and assert its exact text in \`expectBody\`. When \`package.json\` pins \`@jimhoyd/urlcode\` and there is no global install, run each command as \`npx --no --package @jimhoyd/urlcode urlcode …\` or use the npm scripts.

## Feedback

After a real attempt, draft evidence-backed feedback: category, sanitized YAML, observed validation/test result, expected behavior and fixture. Ignore one-off product logic; search existing URLCode issues first; never publish or comment without the user's explicit approval.

## Rules

- Report unsupported requirements; a field the exact schema rejects does not exist.
- Never create operator grants. Request a named binding; the operator grants it
  outside the project, pinned to the revision.
- Keep keys, tokens and credentials out of project files and commit messages.
- Protect a route with \`auth: true\`/\`auth: { role: admin }\` where an \`auth\`
  extension is declared; \`cache\` likewise expands to \`policies.cache\`.
- Local checks are not deployment, soak or independent security evidence.

The installed package ships the same loop at \`${skillPath}\` inside
\`@jimhoyd/urlcode\` (for example \`node_modules/@jimhoyd/urlcode/${skillPath}\`).
`;
}
