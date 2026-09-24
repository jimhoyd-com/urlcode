import { extensionHookContext, extensionHookReferenceSchema, loadExtensionHooks } from '@jimhoyd/urlcode/extensions';
import type { ExtensionAuthoringContract, ExtensionHookContext, ExtensionHookContract, ExtensionHookConfig, ExtensionInstance, ExtensionRequest, HandlerResult, RuntimeExtension } from '@jimhoyd/urlcode/extensions';
import { assertBodySchema, bodySchemaIssues, bodySchemaLine } from '@jimhoyd/urlcode/body-schema';
import type { BodySchema } from '@jimhoyd/urlcode/body-schema';

const NAME = /^[a-z][a-z0-9_-]{0,63}$/;
const ARG_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const MAX_BODY = 256 * 1024;
/** Page size for `tools/list`, `resources/list` and `prompts/list` cursor pagination. */
const PAGE_SIZE = 20;
/**
 * Supported MCP protocol revisions, most preferred first. `initialize`
 * echoes the client's requested revision back when it is one of these;
 * otherwise it answers with the first (our default), exactly as the MCP
 * specification's negotiation flow expects — the client then decides whether
 * to proceed or disconnect. Behavior does not vary by negotiated revision:
 * the bounded surface here (`initialize`, `ping`, `tools/list`, `tools/call`,
 * `resources/list`, `resources/read`, `prompts/list`, `prompts/get`) is
 * stable across all of them. JSON-RPC batching (arrays of requests) is
 * refused for every supported revision, including the two that predate the
 * 2025-06-18 revision's removal of batching from the specification: the
 * bounded declarative surface this extension serves has no use for a client
 * that requires batched delivery, so this is a confirmed scope decision, not
 * an unaddressed gap.
 */
export const SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'] as const;
export const JSONRPC_VERSION = '2.0' as const;

export type JsonRpcId = string | number | null;
interface JsonRpcMessage { id?: JsonRpcId; method: string; params?: unknown }
interface JsonRpcError { code: number; message: string; data?: unknown }

/**
 * MCP tool behavior hints, echoed verbatim in `tools/list`. They are advisory
 * metadata a client may use (for example to decide whether a call needs user
 * confirmation); this server never enforces or derives behavior from them.
 */
export interface McpToolAnnotations { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean }
export interface McpToolSpec {
  description: string; inputSchema: BodySchema; handler: ExtensionHookConfig;
  /** Optional human-readable display name, echoed in `tools/list`. */
  title?: string;
  /** Optional behavior hints, echoed in `tools/list`. */
  annotations?: McpToolAnnotations;
  /**
   * Optional JSON Schema (the same bounded `request.body.schema` subset as
   * `inputSchema`) a tool result's `structuredContent` must conform to. When
   * declared, the handler's return value must be an object satisfying this
   * schema; `tools/call` then returns both a serialized-JSON text content
   * block (for backward compatibility) and `structuredContent` carrying the
   * value itself, per the MCP tools specification's "Output Schema" section.
   * A handler result that does not conform is a server-side contract
   * violation: the caller gets the same generic `isError: true` failure a
   * thrown handler produces, and `onToolError` observes the real mismatch.
   */
  outputSchema?: BodySchema;
}
export interface McpResourceSpec { uri: string; name: string; title?: string; description?: string; mimeType?: string; handler: ExtensionHookConfig }
export interface McpPromptArgumentSpec { name: string; description?: string; required?: boolean }
export interface McpPromptSpec { title?: string; description?: string; arguments?: McpPromptArgumentSpec[]; handler: ExtensionHookConfig }
export interface McpServerSpec {
  mount: string; serverName: string; serverVersion: string; instructions?: string;
  tools: Record<string, McpToolSpec>;
  /** Declarative MCP `resources` primitive: a bounded, named, URI-addressed content map (`resources/list`, `resources/read`). */
  resources?: Record<string, McpResourceSpec>;
  /** Declarative MCP `prompts` primitive: a bounded, named prompt-template map (`prompts/list`, `prompts/get`). */
  prompts?: Record<string, McpPromptSpec>;
}
interface McpConfig { servers?: Record<string, McpServerSpec> }
export interface McpExtensionOptions {
  /** Exact project revision the operator reviewed (`inspectExtensionRevision`). */
  projectSha256: string;
  /**
   * Host-owned error observation: called when a tool/resource/prompt handler
   * throws, or a tool's result fails its own declared `outputSchema`, with
   * the raw error and which server/hook it came from. The caller (the MCP
   * peer) always receives only a fixed, generic message — never
   * `error.message` or a stack — inside the failure shape appropriate to
   * that primitive (a tool result with `isError: true`, or a JSON-RPC
   * `-32603` error for a resource/prompt). This callback is the extension's
   * only mechanism for logging or alerting on that error; it is invoked
   * best-effort (a throwing callback is itself swallowed) and never changes
   * the response sent to the caller.
   */
  onToolError?: (error: unknown, info: { server: string; tool: string; kind: McpHandlerKind }) => void;
  /**
   * Host-owned usage observation: called once for every tool/resource/prompt
   * handler invocation, after it settles, with `outcome: 'success'` or
   * `'error'` (the same failures `onToolError` sees), the wall-clock
   * duration and the request id the response carries in `X-Request-Id`.
   * Requests refused before a handler runs (unknown name, invalid arguments)
   * are not reported. Best-effort: a throwing callback is swallowed and never
   * changes the response.
   */
  onToolCall?: (info: McpToolCallInfo) => void;
}
export type McpHandlerKind = 'tool' | 'resource' | 'prompt';
export interface McpToolCallInfo { server: string; tool: string; kind: McpHandlerKind; outcome: 'success' | 'error'; durationMs: number; requestId: string }
/**
 * The second argument every tool/resource/prompt handler receives: core's
 * generic hook context (the mount route's granted `env` and the request id)
 * plus the server key, the tool/resource/prompt key and which kind it is.
 */
export interface McpHandlerContext extends ExtensionHookContext { server: string; tool: string; kind: McpHandlerKind }
type McpHandler = (input: unknown, context: McpHandlerContext) => unknown;
interface ActiveTool { spec: McpToolSpec; call: McpHandler }
interface ActiveResource { spec: McpResourceSpec; call: McpHandler }
interface ActivePrompt { spec: McpPromptSpec; call: McpHandler; argumentsSchema: BodySchema }
interface ActiveServer {
  name: string; spec: McpServerSpec;
  tools: Map<string, ActiveTool>;
  resources: Map<string, ActiveResource>; resourcesByUri: Map<string, string>;
  prompts: Map<string, ActivePrompt>;
}

const stringSchema = { type: 'string', minLength: 1, maxLength: 512 };
/** Optional human-readable display name on a tool, resource or prompt (the MCP `title` field). */
const titleSchema = { type: 'string', minLength: 1, maxLength: 256 };
/** The four MCP tool behavior hints, closed: an unknown hint or a non-boolean value is refused at validation. */
const toolAnnotationsSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    readOnlyHint: { type: 'boolean' }, destructiveHint: { type: 'boolean' },
    idempotentHint: { type: 'boolean' }, openWorldHint: { type: 'boolean' },
  },
};
const toolConfigSchema = {
  type: 'object', additionalProperties: false, required: ['description', 'inputSchema', 'handler'],
  properties: {
    title: titleSchema,
    description: { type: 'string', minLength: 1, maxLength: 1024 },
    annotations: toolAnnotationsSchema,
    // Loosely typed here (any JSON object); the bounded `request.body.schema`
    // subset itself is enforced strictly at activation via `assertBodySchema`,
    // the same rule a native route's `request.body.schema` is held to.
    inputSchema: { type: 'object' },
    outputSchema: { type: 'object' },
    handler: extensionHookReferenceSchema,
  },
};
const resourceConfigSchema = {
  type: 'object', additionalProperties: false, required: ['uri', 'name', 'handler'],
  properties: {
    uri: { type: 'string', minLength: 1, maxLength: 2048 },
    name: stringSchema,
    title: titleSchema,
    description: { type: 'string', maxLength: 1024 },
    mimeType: { type: 'string', minLength: 1, maxLength: 255 },
    handler: extensionHookReferenceSchema,
  },
};
const promptArgumentConfigSchema = {
  type: 'object', additionalProperties: false, required: ['name'],
  properties: {
    name: { type: 'string', pattern: ARG_NAME.source },
    description: { type: 'string', maxLength: 1024 },
    required: { type: 'boolean' },
  },
};
const promptConfigSchema = {
  type: 'object', additionalProperties: false, required: ['handler'],
  properties: {
    title: titleSchema,
    description: { type: 'string', maxLength: 1024 },
    arguments: { type: 'array', maxItems: 32, items: promptArgumentConfigSchema },
    handler: extensionHookReferenceSchema,
  },
};
/**
 * `servers` may be omitted: `urlcode extensions add mcp` declares the extension with an empty config, because
 * every tool needs a project handler module the scaffold cannot place under `app/`. An mcp declaration with no
 * servers mounts nothing until the author adds one.
 */
export const mcpConfigSchema = {
  type: 'object', additionalProperties: false,
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
          resources: { type: 'object', maxProperties: 64, propertyNames: { pattern: NAME.source }, additionalProperties: resourceConfigSchema },
          prompts: { type: 'object', maxProperties: 64, propertyNames: { pattern: NAME.source }, additionalProperties: promptConfigSchema },
        },
      },
    },
  },
} as const;
export const mcpAuthoring: ExtensionAuthoringContract = {
  description: 'Declare a bounded MCP (Model Context Protocol) tool/resource/prompt server: named tools with a description, a request.body.schema-shaped input (and optional output) schema, an optional title and optional behavior annotations (readOnlyHint, destructiveHint, idempotentHint, openWorldHint), named URI-addressed resources, and named prompt templates (resources and prompts also take an optional title), each backed by a trusted project handler. The extension owns JSON-RPC 2.0 framing, protocol version negotiation, request-id handling, cursor pagination and initialize/ping/tools-*/resources-*/prompts-* dispatch; project YAML never carries JSON-RPC mechanics, a transport choice or provider settings.',
  surfaces: [
    { kind: 'configuration', name: 'servers', description: 'Declare one or more MCP servers, each with a mount, serverName, serverVersion, optional instructions and bounded tools/resources/prompts maps.', path: 'urlcode.yaml#extensions.mcp.config.servers' },
    { kind: 'hook', name: 'tool handler', description: 'Each tool declares a trusted project module/export handler (source, optional export), loaded and run the same way as other extension hooks: not sandboxed, receives the schema-validated arguments object and a context carrying the granted env of the mount route, the request id and the server/tool names.', path: 'urlcode.yaml#extensions.mcp.config.servers.<name>.tools.<name>.handler' },
    { kind: 'hook', name: 'resource handler', description: 'Each resource declares a trusted project module/export handler returning that resource’s content (a string, or {text|blob, mimeType}), served over resources/read.', path: 'urlcode.yaml#extensions.mcp.config.servers.<name>.resources.<name>.handler' },
    { kind: 'hook', name: 'prompt handler', description: 'Each prompt declares a trusted project module/export handler receiving the schema-validated string arguments and returning prompt message content, served over prompts/get.', path: 'urlcode.yaml#extensions.mcp.config.servers.<name>.prompts.<name>.handler' },
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
/**
 * The revision the Streamable HTTP transport says a server assumes when a
 * non-`initialize` request carries no `MCP-Protocol-Version` header (for
 * clients that predate the header). It is itself one of the supported
 * revisions, so a missing header is always accepted.
 */
const DEFAULT_HEADER_PROTOCOL_VERSION = '2025-03-26';
/** `true` when a non-`initialize` request's `MCP-Protocol-Version` header (missing: the transport's assumed default) is a supported revision. */
function supportedProtocolVersionHeader(request: ExtensionRequest): boolean {
  const version = request.headers.get('mcp-protocol-version') ?? DEFAULT_HEADER_PROTOCOL_VERSION;
  return (SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(version);
}
function negotiateProtocolVersion(params: unknown): string {
  const requested = isRecord(params) && typeof params.protocolVersion === 'string' ? params.protocolVersion : undefined;
  return requested && (SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(requested) ? requested : SUPPORTED_PROTOCOL_VERSIONS[0];
}
function toolContent(value: unknown): { content: [{ type: 'text'; text: string }]; isError: boolean } {
  return { content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value ?? null) }], isError: false };
}

// --- Cursor pagination (tools/list, resources/list, prompts/list) ---------
// `cursor`/`nextCursor` are spec-opaque strings: a client must treat them as
// tokens, never construct or parse one itself. This bounded implementation
// encodes "resume at this entry's sort key" as base64url; entries are sorted
// by name so the page boundary is stable across requests even though the
// underlying config is an unordered object.
function encodeCursor(key: string): string { return Buffer.from(key, 'utf8').toString('base64url'); }
function decodeCursor(cursor: string): string | undefined {
  try { return Buffer.from(cursor, 'base64url').toString('utf8'); } catch { return undefined; }
}
function sortedEntries<T>(map: Map<string, T>): [string, T][] { return [...map.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)); }
interface Page<T> { page: [string, T][]; nextCursor?: string }
/** Slices a sorted entry list into one page starting at `cursor` (if given); `undefined` cursor starts at the top. */
function paginate<T>(sorted: [string, T][], cursor: unknown): Page<T> | { error: JsonRpcError } {
  let startIndex = 0;
  if (cursor !== undefined) {
    if (typeof cursor !== 'string') return { error: { code: -32602, message: 'Invalid params: cursor must be a string' } };
    const decoded = decodeCursor(cursor);
    const index = decoded === undefined ? -1 : sorted.findIndex(([key]) => key === decoded);
    if (index === -1) return { error: { code: -32602, message: 'Invalid params: cursor is invalid or expired' } };
    startIndex = index;
  }
  const page = sorted.slice(startIndex, startIndex + PAGE_SIZE);
  const nextIndex = startIndex + PAGE_SIZE;
  return nextIndex < sorted.length ? { page, nextCursor: encodeCursor(sorted[nextIndex]![0]) } : { page };
}

function resourceContent(uri: string, defaultMimeType: string | undefined, value: unknown): { uri: string; mimeType?: string; text?: string; blob?: string } {
  const mimeTypeOf = (candidate: unknown): string | undefined => (typeof candidate === 'string' ? candidate : defaultMimeType);
  if (typeof value === 'string') return { uri, ...(defaultMimeType ? { mimeType: defaultMimeType } : {}), text: value };
  if (isRecord(value) && typeof value.text === 'string') { const mimeType = mimeTypeOf(value.mimeType); return { uri, ...(mimeType ? { mimeType } : {}), text: value.text }; }
  if (isRecord(value) && typeof value.blob === 'string') { const mimeType = mimeTypeOf(value.mimeType); return { uri, ...(mimeType ? { mimeType } : {}), blob: value.blob }; }
  return { uri, mimeType: mimeTypeOf(undefined) ?? 'application/json', text: JSON.stringify(value ?? null) };
}

type PromptMessage = { role: 'user' | 'assistant'; content: { type: 'text'; text: string } };
/**
 * Accepts a prompt handler's return value in either the full MCP message
 * shape (`{role, content: {type: 'text', text}}[]`) or a convenience shape
 * (`{role, text}[]`, or a bare string for a single user-role message) and
 * normalizes it to the wire shape `prompts/get` returns. Anything else is
 * serialized as a single user-role text message rather than rejected, so a
 * handler always produces a valid result.
 */
function promptMessages(value: unknown): PromptMessage[] {
  const textMessage = (role: 'user' | 'assistant', text: string): PromptMessage => ({ role, content: { type: 'text', text } });
  if (typeof value === 'string') return [textMessage('user', value)];
  if (Array.isArray(value)) {
    return value.map(entry => {
      if (isRecord(entry) && (entry.role === 'user' || entry.role === 'assistant')) {
        if (typeof entry.text === 'string') return textMessage(entry.role, entry.text);
        if (isRecord(entry.content) && entry.content.type === 'text' && typeof entry.content.text === 'string') return textMessage(entry.role, entry.content.text);
      }
      return textMessage('user', typeof entry === 'string' ? entry : JSON.stringify(entry ?? null));
    });
  }
  return [textMessage('user', JSON.stringify(value ?? null))];
}
function promptArgumentsSchema(args: readonly McpPromptArgumentSpec[] | undefined): BodySchema {
  const properties: Record<string, BodySchema> = {};
  const required: string[] = [];
  for (const arg of args ?? []) { properties[arg.name] = { type: 'string', maxLength: 8192 }; if (arg.required) required.push(arg.name); }
  return { type: 'object', properties, ...(required.length ? { required } : {}), additionalProperties: false };
}

/**
 * Dispatches one already-envelope-validated JSON-RPC message against a single
 * activated MCP server. Returns the JSON-RPC `result` or `error` payload;
 * the caller (`handle` below) decides whether a response is even sent (a
 * notification, i.e. a message with no `id`, never gets one).
 */
async function dispatch(server: ActiveServer, method: string, params: unknown, options: McpExtensionOptions, request: ExtensionRequest): Promise<{ result: unknown } | { error: JsonRpcError }> {
  const { onToolError, onToolCall } = options;
  /** Starts one handler invocation: the context it receives and the `onToolCall` report for its outcome. */
  const invocation = (kind: McpHandlerKind, tool: string) => {
    const started = performance.now();
    const context: McpHandlerContext = { ...extensionHookContext(request), server: server.name, tool, kind };
    const report = (outcome: 'success' | 'error'): void => {
      try { onToolCall?.({ server: server.name, tool, kind, outcome, durationMs: Math.round((performance.now() - started) * 100) / 100, requestId: request.requestId }); } catch { /* host callback errors are never allowed to reach the caller */ }
    };
    return { context, report };
  };
  if (method === 'initialize') {
    return { result: {
      protocolVersion: negotiateProtocolVersion(params),
      capabilities: {
        tools: { listChanged: false },
        ...(server.resources.size > 0 ? { resources: { listChanged: false } } : {}),
        ...(server.prompts.size > 0 ? { prompts: { listChanged: false } } : {}),
      },
      serverInfo: { name: server.spec.serverName, version: server.spec.serverVersion },
      ...(server.spec.instructions === undefined ? {} : { instructions: server.spec.instructions }),
    } };
  }
  if (method === 'ping') return { result: {} };

  if (method === 'tools/list') {
    const paged = paginate(sortedEntries(server.tools), isRecord(params) ? params.cursor : undefined);
    if ('error' in paged) return paged;
    const tools = paged.page.map(([name, tool]) => ({
      name, ...(tool.spec.title ? { title: tool.spec.title } : {}),
      description: tool.spec.description, inputSchema: tool.spec.inputSchema,
      ...(tool.spec.outputSchema ? { outputSchema: tool.spec.outputSchema } : {}),
      ...(tool.spec.annotations ? { annotations: tool.spec.annotations } : {}),
    }));
    return { result: { tools, ...(paged.nextCursor ? { nextCursor: paged.nextCursor } : {}) } };
  }
  if (method === 'tools/call') {
    if (!isRecord(params) || typeof params.name !== 'string') return { error: { code: -32602, message: 'Invalid params: tools/call requires a string "name"' } };
    const tool = server.tools.get(params.name);
    if (!tool) return { error: { code: -32602, message: `Unknown tool: ${params.name}` } };
    const args = own(params, 'arguments') ? params.arguments : {};
    if (!isRecord(args)) return { error: { code: -32602, message: 'Invalid params: "arguments" must be an object' } };
    const issues = bodySchemaIssues(tool.spec.inputSchema, args);
    if (issues.length) return { error: { code: -32602, message: 'Invalid params: arguments failed the declared input schema', data: { issues: issues.map(bodySchemaLine) } } };
    const { context, report } = invocation('tool', params.name);
    const fail = (error: unknown): { result: unknown } => {
      try { onToolError?.(error, { server: server.name, tool: params.name as string, kind: 'tool' }); } catch { /* host callback errors are never allowed to reach the caller */ }
      report('error');
      return { result: { content: [{ type: 'text', text: 'The tool could not complete the request.' }], isError: true } };
    };
    try {
      const value = await tool.call(args, context);
      if (!tool.spec.outputSchema) { const result = toolContent(value); report('success'); return { result }; }
      // Output schema declared: the MCP tools specification requires the server to provide
      // structuredContent conforming to it; a non-conforming handler result is a server-side
      // contract violation, reported to the caller exactly like a thrown handler error.
      if (!isRecord(value)) return fail(new Error('tool handler result is not an object, but the tool declares an outputSchema'));
      const outputIssues = bodySchemaIssues(tool.spec.outputSchema, value);
      if (outputIssues.length) return fail(new Error(`tool handler result failed its declared outputSchema: ${outputIssues.map(bodySchemaLine).join('; ')}`));
      const result = { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value, isError: false };
      report('success');
      return { result };
    } catch (error) { return fail(error); }
  }

  if (method === 'resources/list') {
    const paged = paginate(sortedEntries(server.resources), isRecord(params) ? params.cursor : undefined);
    if ('error' in paged) return paged;
    const resources = paged.page.map(([, resource]) => ({
      uri: resource.spec.uri, name: resource.spec.name,
      ...(resource.spec.title ? { title: resource.spec.title } : {}),
      ...(resource.spec.description ? { description: resource.spec.description } : {}),
      ...(resource.spec.mimeType ? { mimeType: resource.spec.mimeType } : {}),
    }));
    return { result: { resources, ...(paged.nextCursor ? { nextCursor: paged.nextCursor } : {}) } };
  }
  if (method === 'resources/read') {
    if (!isRecord(params) || typeof params.uri !== 'string') return { error: { code: -32602, message: 'Invalid params: resources/read requires a string "uri"' } };
    const id = server.resourcesByUri.get(params.uri);
    const resource = id === undefined ? undefined : server.resources.get(id);
    if (!resource) return { error: { code: -32002, message: 'Resource not found', data: { uri: params.uri } } };
    const { context, report } = invocation('resource', id!);
    try {
      const value = await resource.call({}, context);
      const result = { contents: [resourceContent(params.uri, resource.spec.mimeType, value)] };
      report('success');
      return { result };
    } catch (error) {
      try { onToolError?.(error, { server: server.name, tool: id!, kind: 'resource' }); } catch { /* host callback errors are never allowed to reach the caller */ }
      report('error');
      return { error: { code: -32603, message: 'The resource could not be read.' } };
    }
  }

  if (method === 'prompts/list') {
    const paged = paginate(sortedEntries(server.prompts), isRecord(params) ? params.cursor : undefined);
    if ('error' in paged) return paged;
    const prompts = paged.page.map(([name, prompt]) => ({
      name,
      ...(prompt.spec.title ? { title: prompt.spec.title } : {}),
      ...(prompt.spec.description ? { description: prompt.spec.description } : {}),
      ...(prompt.spec.arguments && prompt.spec.arguments.length ? { arguments: prompt.spec.arguments.map(argument => ({
        name: argument.name, ...(argument.description ? { description: argument.description } : {}), ...(argument.required !== undefined ? { required: argument.required } : {}),
      })) } : {}),
    }));
    return { result: { prompts, ...(paged.nextCursor ? { nextCursor: paged.nextCursor } : {}) } };
  }
  if (method === 'prompts/get') {
    if (!isRecord(params) || typeof params.name !== 'string') return { error: { code: -32602, message: 'Invalid params: prompts/get requires a string "name"' } };
    const prompt = server.prompts.get(params.name);
    if (!prompt) return { error: { code: -32602, message: `Unknown prompt: ${params.name}` } };
    const args = own(params, 'arguments') ? params.arguments : {};
    if (!isRecord(args)) return { error: { code: -32602, message: 'Invalid params: "arguments" must be an object' } };
    const issues = bodySchemaIssues(prompt.argumentsSchema, args);
    if (issues.length) return { error: { code: -32602, message: 'Invalid params: arguments failed the declared prompt arguments', data: { issues: issues.map(bodySchemaLine) } } };
    const { context, report } = invocation('prompt', params.name);
    try {
      const value = await prompt.call(args, context);
      const result = { ...(prompt.spec.description ? { description: prompt.spec.description } : {}), messages: promptMessages(value) };
      report('success');
      return { result };
    } catch (error) {
      try { onToolError?.(error, { server: server.name, tool: params.name, kind: 'prompt' }); } catch { /* host callback errors are never allowed to reach the caller */ }
      report('error');
      return { error: { code: -32603, message: 'The prompt could not be generated.' } };
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
      for (const [name, spec] of Object.entries(config.servers ?? {})) {
        if (!context.mounts.includes(spec.mount)) throw new Error(`MCP server ${name}: route ${spec.mount} with extension: mcp is not declared`);
        const clash = byMount.get(spec.mount);
        if (clash) throw new Error(`MCP servers ${clash.name} and ${name} share mount ${spec.mount}`);
        const contracts: ExtensionHookContract[] = [];
        const hooksConfig: Record<string, ExtensionHookConfig> = {};

        for (const [toolName, tool] of Object.entries(spec.tools)) {
          try { assertBodySchema(tool.inputSchema); }
          catch (error) { throw new Error(`MCP server ${name}: tool ${toolName} inputSchema: ${(error as Error).message}`, { cause: error }); }
          if (tool.inputSchema.type !== 'object') throw new Error(`MCP server ${name}: tool ${toolName} inputSchema must declare type: object (MCP tool arguments are always an object)`);
          if (tool.outputSchema !== undefined) {
            try { assertBodySchema(tool.outputSchema); }
            catch (error) { throw new Error(`MCP server ${name}: tool ${toolName} outputSchema: ${(error as Error).message}`, { cause: error }); }
            if (tool.outputSchema.type !== 'object') throw new Error(`MCP server ${name}: tool ${toolName} outputSchema must declare type: object (MCP structuredContent is always an object)`);
          }
          // The Ajv input schema loadExtensionHooks compiles against is deliberately permissive
          // (any object): the real, bounded validation of a call's arguments happens per-request via
          // bodySchemaIssues against the tool's own declared inputSchema, with structured JSON-RPC
          // -32602 detail — reusing the same request.body.schema machinery a native route uses,
          // rather than a second, less precise validator here.
          contracts.push({ name: `tool:${toolName}`, kind: 'action', description: tool.description, inputSchema: { type: 'object' } });
          hooksConfig[`tool:${toolName}`] = tool.handler;
        }

        const resourcesByUri = new Map<string, string>();
        for (const [resourceId, resource] of Object.entries(spec.resources ?? {})) {
          const clashUri = resourcesByUri.get(resource.uri);
          if (clashUri) throw new Error(`MCP server ${name}: resources ${clashUri} and ${resourceId} share uri ${resource.uri}`);
          resourcesByUri.set(resource.uri, resourceId);
          contracts.push({ name: `resource:${resourceId}`, kind: 'action', description: resource.description ?? resource.name, inputSchema: { type: 'object' } });
          hooksConfig[`resource:${resourceId}`] = resource.handler;
        }

        for (const [promptId, prompt] of Object.entries(spec.prompts ?? {})) {
          const seen = new Set<string>();
          for (const argument of prompt.arguments ?? []) {
            if (seen.has(argument.name)) throw new Error(`MCP server ${name}: prompt ${promptId} declares argument ${argument.name} more than once`);
            seen.add(argument.name);
          }
          contracts.push({ name: `prompt:${promptId}`, kind: 'action', description: prompt.description ?? promptId, inputSchema: { type: 'object' } });
          hooksConfig[`prompt:${promptId}`] = prompt.handler;
        }

        const handlers = await loadExtensionHooks<string, McpHandlerContext>(hooksConfig, contracts, context);
        const tools = new Map<string, ActiveTool>(Object.entries(spec.tools).map(([toolName, tool]) => [toolName, { spec: tool, call: handlers[`tool:${toolName}`]! }]));
        const resources = new Map<string, ActiveResource>(Object.entries(spec.resources ?? {}).map(([resourceId, resource]) => [resourceId, { spec: resource, call: handlers[`resource:${resourceId}`]! }]));
        const prompts = new Map<string, ActivePrompt>(Object.entries(spec.prompts ?? {}).map(([promptId, prompt]) => [promptId, { spec: prompt, call: handlers[`prompt:${promptId}`]!, argumentsSchema: promptArgumentsSchema(prompt.arguments) }]));
        byMount.set(spec.mount, { name, spec, tools, resources, resourcesByUri, prompts });
      }
      for (const mount of context.mounts) if (!byMount.has(mount)) throw new Error(`MCP mount ${mount} has no server declared`);
      return {
        async handle(request: ExtensionRequest): Promise<HandlerResult> {
          const server = request.mount === null ? undefined : byMount.get(request.mount);
          if (!server || request.path !== request.mount) return textError(404, 'Not found');
          // DNS-rebinding defense the Streamable HTTP transport requires: a present Origin must be
          // exactly the site's canonical origin (the same same-origin idiom forms and store use);
          // an absent one (non-browser MCP clients send none) is admitted. Refused before parsing.
          const from = request.headers.get('origin');
          if (from !== null && from !== context.origin) return textError(403, 'Forbidden');
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
          // Every message after initialize (requests and notifications alike) carries the negotiated
          // revision in MCP-Protocol-Version; an unsupported one is refused with 400, as the
          // 2025-06-18 transport specifies. initialize itself negotiates from params.protocolVersion.
          if (message.method !== 'initialize' && !supportedProtocolVersionHeader(request)) return textError(400, 'Unsupported MCP-Protocol-Version');
          const isNotification = !own(message as unknown as Record<string, unknown>, 'id');
          if (isNotification) return { status: 202, headers: [] };
          const id = message.id as JsonRpcId;
          const outcome = await dispatch(server, message.method, message.params, options, request);
          return rpc(200, id, outcome);
        },
      };
    },
  };
}
