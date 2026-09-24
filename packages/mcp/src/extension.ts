import { defineExtension } from '@jimhoyd/urlcode/extensions';
import type { ScaffoldResult } from '@jimhoyd/urlcode/extensions';
import { createMcpExtension, mcpAuthoring, mcpConfigSchema } from './mcp.ts';
import type { McpExtensionOptions } from './mcp.ts';

/** Operator choices for mcp in host.mjs; the revision pin always comes from the host. */
export type McpHostOptions = Partial<Omit<McpExtensionOptions, 'projectSha256'>>;

/**
 * Unlike `store` (no project handler code at all), every `mcp` tool needs a trusted *project* handler
 * module under `app/`. A scaffold writes operator files only outside the reviewed route project, so it
 * cannot place that module itself. Declaring a demo server anyway would ship a project that fails
 * `urlcode validate` on its first run (a missing referenced file), which is worse than declaring
 * nothing. So the scaffold leaves `config` and `routes` empty (the definition's `host()` still
 * registers `mcp`), and its notes walk the operator through adding a server, a tool and its handler.
 */
function scaffold(): ScaffoldResult {
  return {
    config: {},
    routes: {},
    notes: [
      'mcp declares no server yet: every tool needs a trusted handler module under app/, which a scaffold cannot place.',
      'Add a handler (for example app/mcp-tools/get-time.mjs), declare it under extensions.mcp.config.servers.<name>.tools with an `extension: mcp` route such as /mcp/* (POST, HEAD), then re-review and re-pin the project revision. See the @jimhoyd/urlcode-mcp README.',
      'Clients connect to the mount exactly (POST https://site.example/mcp): /mcp/* is required route syntax, and /mcp/ or any subpath answers 404.',
    ],
  };
}

export default defineExtension<McpHostOptions>({
  name: 'mcp',
  description: 'Declarative MCP (Model Context Protocol) server: tools, resources and prompts backed by trusted project handlers',
  requires: [],
  schema: mcpConfigSchema,
  authoring: mcpAuthoring,
  agent: {description: 'Local, revision-pinned references for agents configuring the MCP extension.', references: [{name: 'MCP extension guide', description: 'Configuration and deployment guidance for project-defined MCP tools.', path: 'README.md'}]},
  scaffold,
  host(context, options) {
    return { registration: createMcpExtension({ ...options, projectSha256: context.projectSha256 }) };
  },
});
