import { extensionHookReferenceSchema, loadExtensionHooks } from '@jimhoyd/urlcode/extensions';
import type { ExtensionAuthoringContract, ExtensionHookContract, ExtensionHookConfig, ExtensionInstance, ExtensionRequest, HandlerResult, RuntimeExtension } from '@jimhoyd/urlcode/extensions';
import { assertBodySchema, bodySchemaIssues, bodySchemaLine } from '@jimhoyd/urlcode/body-schema';
import type { BodySchema } from '@jimhoyd/urlcode/body-schema';

const NAME = /^[a-z][a-z0-9_-]{0,63}$/;
const MAX_BODY = 256 * 1024;
/**
 * Supported MCP protocol revisions, most preferred first. `initialize`
 * echoes the client's requested revision back when it is one of these;
 * otherwise it answers with the first (our default), exactly as the MCP
 * specification's negotiation flow expects — the client then decides whether
 * to proceed or disconnect. Behavior does not vary by negotiated revision:
 * the bounded surface here (`initialize`, `ping`, `tools/list`, `tools/call`)
 * is stable across all of them.
 */
export const SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'] as const;
export const JSONRPC_VERSION = '2.0' as const;

export type JsonRpcId = string | number | null;
interface JsonRpcMessage { id?: JsonRpcId; method: string; params?: unknown }
interface JsonRpcError { code: number; message: string; data?: unknown }

export interface McpToolSpec { description: string; inputSchema: BodySchema; handler: ExtensionHookConfig }
export interface McpServerSpec { mount: string; serverName: string; serverVersion: string; instructions?: string; tools: Record<string, McpToolSpec> }
interface McpConfig { servers: Record<string, McpServerSpec> }
export interface McpExtensionOptions {
  /** Exact project revision the operator reviewed (`inspectExtensionRevision`). */
  projectSha256: string;
  /**
   * Host-owned error observation: called when a tool handler throws, with the
   * raw error and which server/tool it came from. The caller (the MCP peer)
   * always receives only a fixed, generic message — never `error.message` or
   * a stack — inside a tool-result `isError: true` payload, matching the
   * pattern used by the other extension packages. This callback is the
   * extension's only mechanism for logging or alerting on that error; it is
   * invoked best-effort (a throwing callback is itself swallowed) and never
   * changes the response sent to the caller.
   */
  onToolError?: (error: unknown, info: { server: string; tool: string }) => void;
}
interface ActiveTool { spec: McpToolSpec; call: (input: unknown) => unknown }
interface ActiveServer { name: string; spec: McpServerSpec; tools: Map<string, ActiveTool> }

const stringSchema = { type: 'string', minLength: 1, maxLength: 512 };
const toolConfigSchema = {
  type: 'object', additionalProperties: false, required: ['description', 'inputSchema', 'handler'],
  properties: {
    description: { type: 'string', minLength: 1, maxLength: 1024 },
    // Loosely typed here (any JSON object); the bounded `request.body.schema`
    // subset itself is enforced strictly at activation via `assertBodySchema`,
    // the same rule a native route's `request.body.schema` is held to.
    inputSchema: { type: 'object' },
    handler: extensionHookReferenceSchema,
  },
};
export const mcpConfigSchema = {
  type: 'object', additionalProperties: false, required: ['servers'],
  properties: {
    servers: {
      type: 'object', minProperties: 1, maxProperties: 8, propertyNames: { pattern: NAME.source },
      additionalProperties: {
        type: 'object', additionalProperties: false, required: ['mount', 'serverName', 'serverVersion', 'tools'],
        properties: {
          mount: { type: 'string', pattern: '^/[A-Za-z0-9._~-]+(?:/[A-Za-z0-9._~-]+)*$', maxLength: 256 },
          serverName: stringSchema, serverVersion: { type: 'string', minLength: 1, maxLength: 64 },
          instructions: { type: 'string', maxLength: 4096 },
          tools: { type: 'object', minProperties: 1, maxProperties: 64, propertyNames: { pattern: NAME.source }, additionalProperties: toolConfigSchema },
        },
      },
    },
  },
} as const;
export const mcpAuthoring: ExtensionAuthoringContract = {
  description: 'Declare a bounded MCP (Model Context Protocol) tool server: named tools with a description, a request.body.schema-shaped input schema, and a trusted project handler. The extension owns JSON-RPC 2.0 framing, protocol version negotiation, request-id handling and initialize/ping/tools-list/tools-call dispatch; project YAML never carries JSON-RPC mechanics, a transport choice or provider settings.',
  surfaces: [
    { kind: 'configuration', name: 'servers', description: 'Declare one or more MCP servers, each with a mount, serverName, serverVersion, optional instructions and a bounded tools map.', path: 'urlcode.yaml#extensions.mcp.config.servers' },
    { kind: 'hook', name: 'tool handler', description: 'Each tool declares a trusted project module/export handler (source, optional export), loaded and run the same way as other extension hooks: not sandboxed, receives only the schema-validated arguments object.', path: 'urlcode.yaml#extensions.mcp.config.servers.<name>.tools.<name>.handler' },
    { kind: 'extension', name: 'mount', description: 'Mount each server at its declared path with POST (and HEAD). Add `auth: true` when tool calls require a signed-in caller.', path: 'urlcode.yaml' },
  ],
  fastChecks: ['urlcode validate --project . --host-file <host.mjs> --origin <origin>', 'urlcode test --project . --host-file <host.mjs> --origin <origin>'],
};

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
const own = (value: Record<string, unknown>, key: string): boolean => Object.prototype.hasOwnProperty.call(value, key);
function isJsonRpcId(value: unknown): value is JsonRpcId { return value === null || typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value)); }
/** Structural validation only (jsonrpc/method/id/params shape); `undefined` means the envelope itself is malformed. */
function parseEnvelope(value: unknown): JsonRpcMessage | undefined {
  if (!isRecord(value)) return undefined;
  if (value.jsonrpc !== JSONRPC_VERSION) return undefined;
  if (typeof value.method !== 'string' || value.method.length === 0 || value.method.length > 128) return undefined;
  if (own(value, 'id') && !isJsonRpcId(value.id)) return undefined;
  if (own(value, 'params') && !(isRecord(value.params) || Array.isArray(value.params))) return undefined;
  const message: JsonRpcMessage = { method: value.method };
  if (own(value, 'id')) message.id = value.id as JsonRpcId;
  if (own(value, 'params')) message.params = value.params;
  return message;
}
function textError(status: number, message: string): HandlerResult { return { status, headers: [['content-type', 'text/plain; charset=utf-8']], body: message }; }
function rpc(status: number, id: JsonRpcId, body: { result: unknown } | { error: JsonRpcError }): HandlerResult {
  const value = { jsonrpc: JSONRPC_VERSION, id, ...body };
  return { status, headers: [['content-type', 'application/json; charset=utf-8'], ['cache-control', 'no-store']], body: JSON.stringify(value) };
}
function negotiateProtocolVersion(params: unknown): string {
  const requested = isRecord(params) && typeof params.protocolVersion === 'string' ? params.protocolVersion : undefined;
  return requested && (SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(requested) ? requested : SUPPORTED_PROTOCOL_VERSIONS[0];
}
function toolContent(value: unknown): { content: [{ type: 'text'; text: string }]; isError: boolean } {
  return { content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value ?? null) }], isError: false };
}

/**
 * Dispatches one already-envelope-validated JSON-RPC message against a single
 * activated MCP server. Returns the JSON-RPC `result` or `error` payload;
 * the caller (`handle` below) decides whether a response is even sent (a
 * notification, i.e. a message with no `id`, never gets one).
 */
async function dispatch(server: ActiveServer, method: string, params: unknown, onToolError: McpExtensionOptions['onToolError']): Promise<{ result: unknown } | { error: JsonRpcError }> {
  if (method === 'initialize') {
    return { result: {
      protocolVersion: negotiateProtocolVersion(params),
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: server.spec.serverName, version: server.spec.serverVersion },
      ...(server.spec.instructions === undefined ? {} : { instructions: server.spec.instructions }),
    } };
  }
  if (method === 'ping') return { result: {} };
  if (method === 'tools/list') {
    return { result: { tools: [...server.tools.entries()].map(([name, tool]) => ({ name, description: tool.spec.description, inputSchema: tool.spec.inputSchema })) } };
  }
  if (method === 'tools/call') {
    if (!isRecord(params) || typeof params.name !== 'string') return { error: { code: -32602, message: 'Invalid params: tools/call requires a string "name"' } };
    const tool = server.tools.get(params.name);
    if (!tool) return { error: { code: -32602, message: `Unknown tool: ${params.name}` } };
    const args = own(params, 'arguments') ? params.arguments : {};
    if (!isRecord(args)) return { error: { code: -32602, message: 'Invalid params: "arguments" must be an object' } };
    const issues = bodySchemaIssues(tool.spec.inputSchema, args);
    if (issues.length) return { error: { code: -32602, message: 'Invalid params: arguments failed the declared input schema', data: { issues: issues.map(bodySchemaLine) } } };
    try {
      const value = await tool.call(args);
      return { result: toolContent(value) };
    } catch (error) {
      try { onToolError?.(error, { server: server.name, tool: params.name }); } catch { /* host callback errors are never allowed to reach the caller */ }
      return { result: { content: [{ type: 'text', text: 'The tool could not complete the request.' }], isError: true } };
    }
  }
  return { error: { code: -32601, message: `Method not found: ${method}` } };
}

/** Creates the MCP registration. See docs/EXTENSIONS.md and packages/mcp/README.md. */
export function createMcpExtension(options: McpExtensionOptions): RuntimeExtension {
  if (!/^[a-f0-9]{64}$/.test(options.projectSha256)) throw new Error('mcp extension requires an explicit operator revision pin');
  return {
    name: 'mcp', version: '1', projectSha256: options.projectSha256, targets: ['node', 'aws', 'vercel'],
    schema: mcpConfigSchema, authoring: mcpAuthoring,
    async activate(raw, context): Promise<ExtensionInstance> {
      const config = raw as unknown as McpConfig;
      const byMount = new Map<string, ActiveServer>();
      for (const [name, spec] of Object.entries(config.servers)) {
        if (!context.mounts.includes(spec.mount)) throw new Error(`MCP server ${name}: route ${spec.mount} with extension: mcp is not declared`);
        const clash = byMount.get(spec.mount);
        if (clash) throw new Error(`MCP servers ${clash.name} and ${name} share mount ${spec.mount}`);
        const contracts: ExtensionHookContract[] = [];
        const hooksConfig: Record<string, ExtensionHookConfig> = {};
        for (const [toolName, tool] of Object.entries(spec.tools)) {
          try { assertBodySchema(tool.inputSchema); }
          catch (error) { throw new Error(`MCP server ${name}: tool ${toolName} inputSchema: ${(error as Error).message}`, { cause: error }); }
          if (tool.inputSchema.type !== 'object') throw new Error(`MCP server ${name}: tool ${toolName} inputSchema must declare type: object (MCP tool arguments are always an object)`);
          // The Ajv input schema loadExtensionHooks compiles against is deliberately permissive
          // (any object): the real, bounded validation of a call's arguments happens per-request via
          // bodySchemaIssues against the tool's own declared inputSchema, with structured JSON-RPC
          // -32602 detail — reusing the same request.body.schema machinery a native route uses,
          // rather than a second, less precise validator here.
          contracts.push({ name: toolName, kind: 'action', description: tool.description, inputSchema: { type: 'object' } });
          hooksConfig[toolName] = tool.handler;
        }
        const handlers = await loadExtensionHooks(hooksConfig, contracts, context);
        const tools = new Map<string, ActiveTool>(Object.entries(spec.tools).map(([toolName, tool]) => [toolName, { spec: tool, call: handlers[toolName]! }]));
        byMount.set(spec.mount, { name, spec, tools });
      }
      for (const mount of context.mounts) if (!byMount.has(mount)) throw new Error(`MCP mount ${mount} has no server declared`);
      return {
        async handle(request: ExtensionRequest): Promise<HandlerResult> {
          const server = request.mount === null ? undefined : byMount.get(request.mount);
          if (!server || request.path !== request.mount) return textError(404, 'Not found');
          if (request.method === 'HEAD') return { status: 200, headers: [] };
          // The Streamable HTTP transport also defines a GET stream for server-initiated messages;
          // this extension does not implement it (see README "Not implemented"), and the
          // specification's own guidance for that case is exactly this: refuse with 405.
          if (request.method !== 'POST') return { status: 405, headers: [['allow', 'POST']], body: 'Method not allowed' };
          const type = request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
          if (type !== 'application/json') return textError(415, 'MCP requests require application/json');
          if (request.body.byteLength > MAX_BODY) return textError(413, 'Request body is too large');
          let parsed: unknown;
          try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(request.body)); }
          catch { return rpc(200, null, { error: { code: -32700, message: 'Parse error' } }); }
          if (Array.isArray(parsed)) return rpc(200, null, { error: { code: -32600, message: 'JSON-RPC batching is not supported' } });
          const message = parseEnvelope(parsed);
          if (!message) return rpc(200, null, { error: { code: -32600, message: 'Invalid Request' } });
          const isNotification = !own(message as unknown as Record<string, unknown>, 'id');
          if (isNotification) return { status: 202, headers: [] };
          const id = message.id as JsonRpcId;
          const outcome = await dispatch(server, message.method, message.params, options.onToolError);
          return rpc(200, id, outcome);
        },
      };
    },
  };
}
