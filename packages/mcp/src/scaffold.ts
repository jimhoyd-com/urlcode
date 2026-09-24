import type { ScaffoldRequest, ScaffoldResult } from '@jimhoyd/urlcode/extensions';

/**
 * Unlike `store` (no project handler code at all) or `auth`/`admin` (whose demo routes need only
 * operator-owned wiring), every `mcp` tool requires a trusted *project* handler module under
 * `app/` (`docs/EXTENSIONS.md#scaffolding-with-init---with`). `init --with` writes scaffold `files`
 * only outside the reviewed route project (`init-with.ts`'s `filePath` refuses anything under
 * `app/`), so this scaffold cannot place that handler module itself the way `ROUTES_FILE` places
 * route fragments. Declaring a demo server here anyway would ship a project that fails
 * `urlcode validate --host-file ...` on its very first run (a missing referenced file), which is
 * worse than declaring nothing. So this scaffold wires `createMcpExtension` into the generated
 * `host.mjs` (always valid: it does not require any project declaration to construct) and leaves
 * `extensions`/`routes` empty, walking the operator through adding their own server, tool and
 * handler file by hand in the generated README instead.
 */
const exampleHandler = `export default function getTime() {
  return { now: new Date().toISOString() };
}
`;
const exampleYaml = `extensions:
  mcp:
    version: "1"
    config:
      servers:
        default:
          mount: /mcp
          serverName: example-tools
          serverVersion: "1.0.0"
          tools:
            get_time:
              description: Returns the current server time.
              inputSchema: {type: object, properties: {}, additionalProperties: false}
              handler: ./mcp-tools/get-time.mjs
routes:
  /mcp/*:
    extension: mcp
    methods: [POST, HEAD]`;
const readme = `\`mcp\` is wired into \`host.mjs\` (\`createMcpExtension\`), but this scaffold declares no server: every tool needs a trusted project handler module under \`app/\`, which \`init --with\` cannot place there itself (it only ever writes reviewed files outside the route project). Add your own server and at least one tool by hand:

1. Create \`app/mcp-tools/get-time.mjs\`:

\`\`\`js
${exampleHandler}\`\`\`

2. Add this to \`app/urlcode.yaml\` (or an included file):

\`\`\`yaml
${exampleYaml}
\`\`\`

3. Re-review the project and re-pin its revision (see "Project revision" below), then run the fast checks.

See [the package README](../packages/mcp/README.md) for the full \`tools\`/\`inputSchema\`/\`handler\` contract, error behavior and what v1 does not implement.`;

/** Describes the mcp extension's contribution to a composed project without writing anything. */
export function scaffold(request: ScaffoldRequest): ScaffoldResult {
  for (const key of ['directory', 'project', 'hostFile'] as const) if (typeof request[key] !== 'string' || !request[key]) throw new Error(`Scaffold request needs an absolute ${key}`);
  return {
    name: 'mcp',
    extensions: {},
    routes: {},
    hostImports: [],
    hostBundleExports: ['createMcpExtension'],
    hostSetup: [
      'const mcpProjectSha256 = process.env.PROJECT_SHA256;',
      "if (!mcpProjectSha256 || !/^[a-f0-9]{64}$/.test(mcpProjectSha256)) throw new Error('Set the reviewed PROJECT_SHA256 revision');",
    ],
    hostEntries: ['createMcpExtension({projectSha256: mcpProjectSha256})'],
    files: [],
    readme,
    nextSteps: ['mcp is wired into host.mjs but declares no server yet: add one and a tool handler module under app/ (see the mcp extension section above), then re-review and re-pin the project revision.'],
    env: { PROJECT_SHA256: 'Reviewed project revision from inspectExtensionRevision; re-review after any project change.' },
  };
}
