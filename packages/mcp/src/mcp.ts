import { extensionHookContext, extensionHookReferenceSchema, isSameOriginRequest, loadExtensionHooks } from '@jimhoyd/urlcode/extensions';
import type { ExtensionAuthoringContract, ExtensionHookContext, ExtensionHookContract, ExtensionHookConfig, ExtensionInstance, ExtensionRequest, HandlerResult, RuntimeExtension } from '@jimhoyd/urlcode/extensions';
import { bodySchemaIssues, bodySchemaLine, compileBodySchema, illFormedMember } from '@jimhoyd/urlcode/body-schema';
import type { BodySchema } from '@jimhoyd/urlcode/body-schema';
import { createMcpHandler, ProtocolError, ProtocolErrorCode, Server } from '@modelcontextprotocol/server';

const NAME = /^[a-z][a-z0-9_-]{0,63}$/;
const ARG_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
/** The largest request body the SDK handler reads. */
const MAX_BODY = 256 * 1024;
const utf8 = new TextDecoder('utf-8', { fatal: true });

/**
 * Upper bound, in characters, on the caller-facing text of an `McpToolError`
 * (the same bound the config holds `instructions`, the other free-form text
 * this extension serves a client, to). A longer message is truncated.
 */
const MAX_TOOL_ERROR_TEXT = 4096;
const TOOL_ERROR_BRAND = Symbol.for('@jimhoyd/urlcode-mcp.McpToolError');

/**
 * Thrown by a tool handler to return a caller-facing tool execution error:
 * the `tools/call` result is `isError: true` with `message` as its text
 * content, so the model can read it and self-correct. `data`, when given, is
 * returned as `structuredContent` only if the tool declares an `outputSchema`
 * and `data` conforms to it. Any other thrown value keeps the fixed generic
 * message; only an `McpToolError`'s own message ever reaches the caller.
 */
export class McpToolError extends Error {
  readonly data?: Record<string, unknown>;
  constructor(message: string, options: { data?: Record<string, unknown>; cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'McpToolError';
    if (options.data !== undefined) this.data = options.data;
    Object.defineProperty(this, TOOL_ERROR_BRAND, { value: true });
  }
}
/** Recognizes an `McpToolError` by its registered brand as well, so a second copy of this module still counts. */
function isMcpToolError(value: unknown): value is McpToolError {
  return value instanceof McpToolError || (value instanceof Error && (value as unknown as Record<symbol, unknown>)[TOOL_ERROR_BRAND] === true);
}
function boundedText(text: string): string {
  return text.length <= MAX_TOOL_ERROR_TEXT ? text : `${text.slice(0, MAX_TOOL_ERROR_TEXT - 1)}\u2026`;
}

/**
 * MCP tool behavior hints, echoed verbatim in `tools/list`. They are advisory
 * metadata a client may use (for example to decide whether a call needs user
 * confirmation); this server never enforces or derives behavior from them.
 */
export interface McpToolAnnotations { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean }
export interface McpToolSpec {
  /**
   * `inputSchema` (and `outputSchema`) is a schema in the request body profile, or the name of one of the project's
   * named `schemas` (the top-level `schemas:` map), which `tools/list` advertises resolved.
   */
  description: string; inputSchema: BodySchema | string; handler: ExtensionHookConfig;
  /** Optional human-readable display name, echoed in `tools/list`. */
  title?: string;
  /** Optional behavior hints, echoed in `tools/list`. */
  annotations?: McpToolAnnotations;
  /**
   * Optional JSON Schema (the same bounded `request.body.<METHOD>.schema` JSON Schema 2020-12 profile as
   * `inputSchema`) a tool result's `structuredContent` must conform to. When
   * declared, the handler's return value must be an object satisfying this
   * schema; `tools/call` then returns both a serialized-JSON text content
   * block (for backward compatibility) and `structuredContent` carrying the
   * value itself, per the MCP tools specification's "Output Schema" section.
   * A handler result that does not conform is a server-side contract
   * violation: the caller gets the same generic `isError: true` failure a
   * thrown handler produces, and `onToolError` observes the real mismatch.
   */
  outputSchema?: BodySchema | string;
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
   * the response sent to the caller. A tool handler that throws an
   * `McpToolError` is not reported here: that message is meant for the
   * caller, and `onToolCall` observes it as `outcome: 'tool_error'`.
   */
  onToolError?: (error: unknown, info: { server: string; tool: string; kind: McpHandlerKind }) => void;
  /**
   * Host-owned usage observation: called once for every tool/resource/prompt
   * handler invocation, after it settles, with `outcome: 'success'`,
   * `'tool_error'` (a tool handler threw an `McpToolError`, returned to the
   * caller as its own `isError` result) or `'error'` (the same failures
   * `onToolError` sees), the wall-clock
   * duration and the request id the response carries in `X-Request-Id`.
   * Requests refused before a handler runs (unknown name, invalid arguments)
   * are not reported. Best-effort: a throwing callback is swallowed and never
   * changes the response.
   */
  onToolCall?: (info: McpToolCallInfo) => void;
  /**
   * Pass Server-Sent Events replies through as they are produced, so a `tools/call` that carries
   * `_meta.progressToken` delivers `notifications/progress` before its result. Off by default: the reply is read
   * whole and returned buffered (progress then arrives together with the result), which every target serves. On,
   * the registration declares `streams: true`, so core refuses it on aws and cloudflare before activation. The
   * protocol is stateless either way: there are no sessions and no server-initiated stream.
   */
  streaming?: boolean;
}
export type McpHandlerKind = 'tool' | 'resource' | 'prompt';
export type McpCallOutcome = 'success' | 'tool_error' | 'error';
export interface McpToolCallInfo { server: string; tool: string; kind: McpHandlerKind; outcome: McpCallOutcome; durationMs: number; requestId: string }
/**
 * The second argument every tool/resource/prompt handler receives: core's
 * generic hook context (the mount route's granted `env` and the request id)
 * plus the server key, the tool/resource/prompt key and which kind it is.
 */
export interface McpHandlerContext extends ExtensionHookContext {
  server: string; tool: string; kind: McpHandlerKind;
  /** Aborted when the client disconnects or the SDK cancels this request. A long-running handler should stop when it fires. */
  signal: AbortSignal;
  /**
   * Only on a tool handler: reports progress (`progress` must increase; `total` and `message` are optional). It
   * sends `notifications/progress` when the call carries `_meta.progressToken`, and does nothing otherwise.
   */
  progress?: ProgressFn;
}
/** Reports progress for the current tool call. */
export type ProgressFn = (progress: number, total?: number, message?: string) => void;
type McpHandler = (input: unknown, context: McpHandlerContext) => unknown;
/** A tool as served: its declaration, its handler and its schemas with any project schema name resolved. */
interface ActiveTool { spec: McpToolSpec; call: McpHandler; input: BodySchema; output?: BodySchema }
interface ActiveResource { spec: McpResourceSpec; call: McpHandler }
interface ActivePrompt { spec: McpPromptSpec; call: McpHandler; argumentsSchema: BodySchema }
interface ActiveServer {
  name: string; spec: McpServerSpec;
  tools: Map<string, ActiveTool>;
  resources: Map<string, ActiveResource>; resourcesByUri: Map<string, string>;
  prompts: Map<string, ActivePrompt>;
}

const stringSchema = (description: string) => ({ type: 'string', minLength: 1, maxLength: 512, description });
/** Optional human-readable display name on a tool, resource or prompt (the MCP `title` field). */
const titleSchema = { type: 'string', minLength: 1, maxLength: 256, description: 'Human-readable display name (the MCP title field); the key stays the protocol name.' };
/** A handler reference: the shared extension hook reference shape, described for its role. */
const handlerSchema = (description: string) => ({ ...extensionHookReferenceSchema, description: `${description} Trusted project module ({source, export} or a bare path), run in-process like other extension hooks; sandbox: true is refused.` });
/** The four MCP tool behavior hints, closed: an unknown hint or a non-boolean value is refused at validation. */
const toolAnnotationsSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    readOnlyHint: { type: 'boolean', description: 'Hint to clients that the tool does not modify its environment.' },
    destructiveHint: { type: 'boolean', description: 'Hint that the tool may perform destructive updates.' },
    idempotentHint: { type: 'boolean', description: 'Hint that repeated calls with the same arguments have no additional effect.' },
    openWorldHint: { type: 'boolean', description: 'Hint that the tool interacts with external entities beyond the site.' },
  },
};
/** A project schema name (core's top-level `schemas:` keys), resolved against the activation's `schemas` map. */
const schemaNameSchema = { type: 'string', pattern: '^[A-Za-z][A-Za-z0-9_]{0,63}$' };
const toolConfigSchema = {
  type: 'object', additionalProperties: false, required: ['description', 'inputSchema', 'handler'],
  properties: {
    title: titleSchema,
    description: { type: 'string', minLength: 1, maxLength: 1024, description: 'What the tool does, shown to MCP clients in tools/list.' },
    annotations: { ...toolAnnotationsSchema, description: 'Optional MCP behavior hints, passed to clients as declared; they are advisory and grant or restrict nothing.' },
    // Loosely typed here (any JSON object); the bounded `request.body.<METHOD>.schema`
    // profile itself is enforced strictly, and compiled, at activation via `compileBodySchema`,
    // the same rule a native route's `request.body.<METHOD>.schema` is held to.
    inputSchema: { anyOf: [{ type: 'object' }, schemaNameSchema], description: 'Schema of the arguments object, in the bounded request.body.<METHOD>.schema JSON Schema 2020-12 profile (checked and compiled at activation), or the name of one of the project\'s named schemas (top-level schemas:), which a route\'s request.body.<METHOD>.schema can name too; a call whose arguments fail it never reaches the handler.' },
    outputSchema: { anyOf: [{ type: 'object' }, schemaNameSchema], description: 'Optional schema, in the same profile or named the same way, of the object the handler returns; the result is then sent as structuredContent and a result that fails it is an error.' },
    handler: handlerSchema('Called with the validated arguments and a context (granted env, request id, server and tool names); returns the result or throws McpToolError for an isError answer.'),
  },
};
const resourceConfigSchema = {
  type: 'object', additionalProperties: false, required: ['uri', 'name', 'handler'],
  properties: {
    uri: { type: 'string', minLength: 1, maxLength: 2048, description: 'URI clients read the resource by (resources/read); unique within the server.' },
    name: stringSchema('Resource name listed by resources/list.'),
    title: titleSchema,
    description: { type: 'string', maxLength: 1024, description: 'What the resource holds, shown to clients.' },
    mimeType: { type: 'string', minLength: 1, maxLength: 255, description: 'MIME type advertised for the resource content.' },
    handler: handlerSchema('Returns the resource content: a string, or {text or blob, mimeType}.'),
  },
};
const promptArgumentConfigSchema = {
  type: 'object', additionalProperties: false, required: ['name'],
  properties: {
    name: { type: 'string', pattern: ARG_NAME.source, description: 'Argument name; its value is a string.' },
    description: { type: 'string', maxLength: 1024, description: 'What the argument means, shown to clients.' },
    required: { type: 'boolean', description: 'true: prompts/get without it is refused before the handler runs.' },
  },
};
const promptConfigSchema = {
  type: 'object', additionalProperties: false, required: ['handler'],
  properties: {
    title: titleSchema,
    description: { type: 'string', maxLength: 1024, description: 'What the prompt produces, shown to clients.' },
    arguments: { type: 'array', maxItems: 32, items: promptArgumentConfigSchema, description: 'Declared string arguments of the prompt template.' },
    handler: handlerSchema('Receives the validated string arguments and returns the prompt message content (prompts/get).'),
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
      description: 'MCP servers by name. Omitted (the scaffold default): nothing is mounted. Each needs a route <mount>/* with extension: mcp (POST, and HEAD).',
      type: 'object', minProperties: 1, maxProperties: 8, propertyNames: { pattern: NAME.source },
      additionalProperties: {
        type: 'object', additionalProperties: false, required: ['mount', 'serverName', 'serverVersion', 'tools'],
        properties: {
          mount: { type: 'string', pattern: '^/[A-Za-z0-9._~-]+(?:/[A-Za-z0-9._~-]+)*$', maxLength: 256, description: 'Exact endpoint path clients POST to; the route is <mount>/*, but the mount itself is the only path served (subpaths answer 404).' },
          serverName: stringSchema('Server name reported in the initialize result (serverInfo.name).'),
          serverVersion: { type: 'string', minLength: 1, maxLength: 64, description: 'Server version reported in the initialize result (serverInfo.version).' },
          instructions: { type: 'string', maxLength: 4096, description: 'Optional usage instructions returned to clients in the initialize result.' },
          tools: { type: 'object', minProperties: 1, maxProperties: 64, propertyNames: { pattern: NAME.source }, additionalProperties: toolConfigSchema, description: 'Tools by protocol name (tools/list, tools/call); at least one.' },
          resources: { type: 'object', maxProperties: 64, propertyNames: { pattern: NAME.source }, additionalProperties: resourceConfigSchema, description: 'Optional URI-addressed resources (resources/list, resources/read).' },
          prompts: { type: 'object', maxProperties: 64, propertyNames: { pattern: NAME.source }, additionalProperties: promptConfigSchema, description: 'Optional prompt templates by name (prompts/list, prompts/get).' },
        },
      },
    },
  },
} as const;
export const mcpAuthoring: ExtensionAuthoringContract = {
  description: 'Declare a bounded MCP (Model Context Protocol) tool/resource/prompt server: named tools with a description, a request.body.<METHOD>.schema-shaped input (and optional output) schema, an optional title and optional behavior annotations (readOnlyHint, destructiveHint, idempotentHint, openWorldHint), named URI-addressed resources, and named prompt templates (resources and prompts also take an optional title), each backed by a trusted project handler. The official MCP SDK (@modelcontextprotocol/server) serves the protocol: JSON-RPC 2.0 framing, protocol version negotiation, request ids, notifications and error codes; the extension maps the declared tools, resources and prompts onto it (lists return every declared entry, without pagination) and owns argument and output checks, the trusted handler calls and the caller-facing failures. Project YAML never carries JSON-RPC mechanics, a transport choice or provider settings.',
  surfaces: [
    { kind: 'configuration', name: 'servers', description: 'Declare one or more MCP servers, each with a mount, serverName, serverVersion, optional instructions and bounded tools/resources/prompts maps.', path: 'urlcode.yaml#extensions.mcp.config.servers',
      goals: ['mcp', 'model-context-protocol', 'server', 'servers', 'tool', 'tools', 'connector', 'connectors', 'assistant', 'assistants'] },
    { kind: 'hook', name: 'tool handler', description: 'Each tool declares a trusted project module/export handler (source, optional export), loaded and run the same way as other extension hooks: not sandboxed, receives the schema-validated arguments object and a context carrying the granted env of the mount route, the request id and the server/tool names. It returns the result value, or throws McpToolError (exported by @jimhoyd/urlcode-mcp) with a caller-facing message (and optional data returned as structuredContent when it conforms to the declared outputSchema) to answer isError: true; any other thrown error answers a fixed generic message.', path: 'urlcode.yaml#extensions.mcp.config.servers.<name>.tools.<name>.handler' },
    { kind: 'hook', name: 'resource handler', description: 'Each resource declares a trusted project module/export handler returning that resource’s content (a string, or {text|blob, mimeType}), served over resources/read.', path: 'urlcode.yaml#extensions.mcp.config.servers.<name>.resources.<name>.handler' },
    { kind: 'hook', name: 'prompt handler', description: 'Each prompt declares a trusted project module/export handler receiving the schema-validated string arguments and returning prompt message content, served over prompts/get.', path: 'urlcode.yaml#extensions.mcp.config.servers.<name>.prompts.<name>.handler' },
    { kind: 'extension', name: 'mount', description: 'Mount each server at its declared path with POST (and HEAD); the protocol is stateless, so GET and DELETE are answered 405. The operator may enable streamed progress replies in host.mjs. Add `auth: true` when tool calls require a signed-in caller: with the bundled auth extension that admits a session cookie sent from the site\'s own origin only, so a non-browser MCP client (no Origin header, or a bearer token) is refused 403. The MCP authorization flow (OAuth, bearer tokens) is not implemented and a handler is not told who called, so per-user tools for remote clients are the owner\'s choice: a trusted function route that calls an MCP library directly.', path: 'urlcode.yaml',
      goals: ['mcp', 'remote', 'oauth', 'bearer', 'authorization', 'token', 'tokens', 'client', 'clients', 'connector', 'connectors'] },
  ],
  fastChecks: ['urlcode validate --local --project app --host-file host.mjs --local-review', 'urlcode test --project app --host-file host.mjs --local-review'],
};

type ResourceContent = { uri: string; mimeType?: string; text: string } | { uri: string; mimeType?: string; blob: string };
function resourceContent(uri: string, defaultMimeType: string | undefined, value: unknown): ResourceContent {
  const mimeTypeOf = (candidate: unknown): string | undefined => (typeof candidate === 'string' ? candidate : defaultMimeType);
  if (typeof value === 'string') return { uri, ...(defaultMimeType ? { mimeType: defaultMimeType } : {}), text: value };
  if (isRecord(value) && typeof value.text === 'string') { const mimeType = mimeTypeOf(value.mimeType); return { uri, ...(mimeType ? { mimeType } : {}), text: value.text }; }
  if (isRecord(value) && typeof value.blob === 'string') { const mimeType = mimeTypeOf(value.mimeType); return { uri, ...(mimeType ? { mimeType } : {}), blob: value.blob }; }
  return { uri, mimeType: mimeTypeOf(undefined) ?? 'application/json', text: jsonText(value) };
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
      return textMessage('user', typeof entry === 'string' ? entry : jsonText(entry));
    });
  }
  return [textMessage('user', jsonText(value))];
}
function promptArgumentsSchema(args: readonly McpPromptArgumentSpec[] | undefined): BodySchema {
  const properties: Record<string, BodySchema> = {};
  const required: string[] = [];
  for (const arg of args ?? []) { properties[arg.name] = { type: 'string', maxLength: 8192 }; if (arg.required) required.push(arg.name); }
  return { type: 'object', properties, ...(required.length ? { required } : {}), additionalProperties: false };
}

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function textError(status: number, message: string): HandlerResult { return { status, headers: [['content-type', 'text/plain; charset=utf-8']], body: message }; }
/**
 * Serializes a handler result to JSON text, throwing when it cannot be (a BigInt, a cycle, a throwing
 * toJSON, or a function or symbol that serializes to nothing). Every handler result is serialized
 * before its outcome is reported, so a failure here is the invocation's one `error` outcome (#1087).
 */
function jsonText(value: unknown): string {
  const text = JSON.stringify(value ?? null) as string | undefined;
  if (typeof text !== 'string') throw new TypeError('handler result does not serialize to JSON');
  return text;
}
function toolContent(value: unknown): { content: [{ type: 'text'; text: string }]; isError: boolean } {
  return { content: [{ type: 'text', text: typeof value === 'string' ? value : jsonText(value) }], isError: false };
}
const invalid = (message: string, data?: unknown): ProtocolError => new ProtocolError(ProtocolErrorCode.InvalidParams, message, data);
/**
 * Refuses arguments holding a string or key that is not well-formed UTF-16 (an unpaired `\uD800`-`\uDFFF` escape),
 * as core's JSON body reader does (#988, #1016): the SDK parses the body itself, so this is the one place to check.
 * The protocol error names the argument; the handler never runs.
 */
function refuseIllFormed(args: Readonly<Record<string, unknown>>, what: string): void {
  const argument = illFormedMember(args);
  if (argument !== undefined) throw invalid(`Invalid params: argument ${JSON.stringify(argument)} of ${what} holds an unpaired surrogate escape (\\uD800-\\uDFFF)`, { argument, code: 'invalid_unicode' });
}

/**
 * One SDK server for one HTTP request (the SDK serves every request statelessly). The official SDK owns the
 * protocol: JSON-RPC parsing, lifecycle and version negotiation, notifications and errors (#846). These handlers own
 * the declared behavior: argument and output checks, trusted handler calls, the generic failure messages and the
 * host's onToolCall/onToolError reports.
 */
function serverFor(server: ActiveServer, options: McpExtensionOptions, request: ExtensionRequest, streaming: boolean): Server {
  const { onToolError, onToolCall } = options;
  const sdk = new Server({ name: server.spec.serverName, version: server.spec.serverVersion }, {
    capabilities: {
      tools: { listChanged: false },
      ...(server.resources.size > 0 ? { resources: { listChanged: false } } : {}),
      ...(server.prompts.size > 0 ? { prompts: { listChanged: false } } : {}),
    },
    ...(server.spec.instructions === undefined ? {} : { instructions: server.spec.instructions }),
  });
  /** Starts one handler invocation: the context it receives and the `onToolCall` report for its outcome. */
  const invocation = (kind: McpHandlerKind, tool: string, signal: AbortSignal, progress?: ProgressFn) => {
    const started = performance.now();
    const context: McpHandlerContext = {
      ...extensionHookContext(request), server: server.name, tool, kind,
      signal: request.signal ? AbortSignal.any([signal, request.signal]) : signal,
      ...(kind === 'tool' ? { progress: progress ?? (() => {}) } : {}),
    };
    const report = (outcome: McpCallOutcome): void => {
      try { onToolCall?.({ server: server.name, tool, kind, outcome, durationMs: Math.round((performance.now() - started) * 100) / 100, requestId: request.requestId }); } catch { /* host callback errors are never allowed to reach the caller */ }
    };
    return { context, report };
  };
  const observe = (error: unknown, tool: string, kind: McpHandlerKind): void => {
    try { onToolError?.(error, { server: server.name, tool, kind }); } catch { /* host callback errors are never allowed to reach the caller */ }
  };

  sdk.setRequestHandler('tools/list', () => ({ tools: [...server.tools].map(([name, tool]) => ({
    name, ...(tool.spec.title ? { title: tool.spec.title } : {}),
    description: tool.spec.description, inputSchema: tool.input as { type: 'object' },
    ...(tool.output ? { outputSchema: tool.output as { type: 'object' } } : {}),
    ...(tool.spec.annotations ? { annotations: tool.spec.annotations } : {}),
  })) }));
  sdk.setRequestHandler('tools/call', async (call, ctx) => {
    const name = call.params.name, tool = server.tools.get(name);
    if (!tool) throw invalid(`Unknown tool: ${name}`);
    const args = call.params.arguments ?? {};
    refuseIllFormed(args, `tool ${name}`);
    const issues = bodySchemaIssues(tool.input, args);
    // An input validation failure is a tool execution error the model can act on (SEP-1303); the handler never runs.
    if (issues.length) return { content: [{ type: 'text' as const, text: boundedText(`Invalid arguments for tool ${name}: ${issues.map(bodySchemaLine).join('; ')}`) }], isError: true };
    const token = call.params._meta?.progressToken;
    const progress: ProgressFn | undefined = streaming && token !== undefined
      ? (value, total, message) => { void ctx.mcpReq.notify({ method: 'notifications/progress', params: { progressToken: token, progress: value, ...(total === undefined ? {} : { total }), ...(message === undefined ? {} : { message }) } }).catch(() => undefined); }
      : undefined;
    const { context, report } = invocation('tool', name, ctx.mcpReq.signal, progress);
    const fail = (error: unknown) => {
      observe(error, name, 'tool');
      report('error');
      return { content: [{ type: 'text' as const, text: 'The tool could not complete the request.' }], isError: true };
    };
    try {
      const value = await tool.call(args, context);
      // The result is serialized before success is reported: a result that cannot be is the one `error` outcome (#1087).
      if (!tool.output) { const result = toolContent(value); report('success'); return result; }
      // Output schema declared: the MCP tools specification requires structuredContent conforming to it; a
      // non-conforming handler result is a server-side contract violation, answered like a thrown handler error.
      if (!isRecord(value)) return fail(new Error('tool handler result is not an object, but the tool declares an outputSchema'));
      const outputIssues = bodySchemaIssues(tool.output, value);
      if (outputIssues.length) return fail(new Error(`tool handler result failed its declared outputSchema: ${outputIssues.map(bodySchemaLine).join('; ')}`));
      const result = { content: [{ type: 'text' as const, text: jsonText(value) }], structuredContent: value, isError: false };
      report('success');
      return result;
    } catch (error) {
      if (!isMcpToolError(error)) return fail(error);
      // A handler-chosen, caller-facing failure: its own (bounded) message, never the generic one.
      let structuredContent: Record<string, unknown> | undefined;
      if (error.data !== undefined && tool.output) {
        const dataIssues = isRecord(error.data) ? bodySchemaIssues(tool.output, error.data) : [];
        if (isRecord(error.data) && !dataIssues.length) structuredContent = error.data;
        else observe(new Error(`McpToolError data failed the tool's declared outputSchema and was not returned: ${dataIssues.map(bodySchemaLine).join('; ') || 'not an object'}`), name, 'tool');
      }
      report('tool_error');
      return { content: [{ type: 'text' as const, text: boundedText(String(error.message)) }], ...(structuredContent ? { structuredContent } : {}), isError: true };
    }
  });

  if (server.resources.size > 0) {
    sdk.setRequestHandler('resources/list', () => ({ resources: [...server.resources.values()].map(resource => ({
      uri: resource.spec.uri, name: resource.spec.name,
      ...(resource.spec.title ? { title: resource.spec.title } : {}),
      ...(resource.spec.description ? { description: resource.spec.description } : {}),
      ...(resource.spec.mimeType ? { mimeType: resource.spec.mimeType } : {}),
    })) }));
    sdk.setRequestHandler('resources/read', async (read, ctx) => {
      const uri = read.params.uri, id = server.resourcesByUri.get(uri), resource = id === undefined ? undefined : server.resources.get(id);
      if (!resource) throw invalid('Resource not found', { uri });
      const { context, report } = invocation('resource', id!, ctx.mcpReq.signal);
      try {
        const contents = [resourceContent(uri, resource.spec.mimeType, await resource.call({}, context))];
        report('success');
        return { contents };
      } catch (error) {
        observe(error, id!, 'resource');
        report('error');
        throw new ProtocolError(ProtocolErrorCode.InternalError, 'The resource could not be read.');
      }
    });
  }

  if (server.prompts.size > 0) {
    sdk.setRequestHandler('prompts/list', () => ({ prompts: [...server.prompts].map(([name, prompt]) => ({
      name,
      ...(prompt.spec.title ? { title: prompt.spec.title } : {}),
      ...(prompt.spec.description ? { description: prompt.spec.description } : {}),
      ...(prompt.spec.arguments && prompt.spec.arguments.length ? { arguments: prompt.spec.arguments.map(argument => ({
        name: argument.name, ...(argument.description ? { description: argument.description } : {}), ...(argument.required !== undefined ? { required: argument.required } : {}),
      })) } : {}),
    })) }));
    sdk.setRequestHandler('prompts/get', async (get, ctx) => {
      const name = get.params.name, prompt = server.prompts.get(name);
      if (!prompt) throw invalid(`Unknown prompt: ${name}`);
      const args = get.params.arguments ?? {};
      refuseIllFormed(args, `prompt ${name}`);
      const issues = bodySchemaIssues(prompt.argumentsSchema, args);
      if (issues.length) throw invalid('Invalid params: arguments failed the declared prompt arguments', { issues: issues.map(bodySchemaLine) });
      const { context, report } = invocation('prompt', name, ctx.mcpReq.signal);
      try {
        const messages = promptMessages(await prompt.call(args, context));
        report('success');
        return { ...(prompt.spec.description ? { description: prompt.spec.description } : {}), messages };
      } catch (error) {
        observe(error, name, 'prompt');
        report('error');
        throw new ProtocolError(ProtocolErrorCode.InternalError, 'The prompt could not be generated.');
      }
    });
  }
  return sdk;
}

/** Reads a Response body stream as byte chunks for a streamed extension result. */
async function* chunks(body: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
  const reader = body.getReader();
  try { for (;;) { const { done, value } = await reader.read(); if (done) return; yield value; } }
  finally { reader.releaseLock(); }
}

/** Creates the MCP registration. See docs/EXTENSIONS.md and packages/mcp/README.md. */
export function createMcpExtension(options: McpExtensionOptions): RuntimeExtension {
  if (!/^[a-f0-9]{64}$/.test(options.projectSha256)) throw new Error('mcp extension requires an explicit operator revision pin');
  if (options.streaming !== undefined && typeof options.streaming !== 'boolean') throw new Error('mcp streaming must be true or false');
  const streaming = options.streaming === true;
  return {
    name: 'mcp', version: '1', projectSha256: options.projectSha256, targets: ['node', 'aws', 'vercel'],
    // Declared only when the operator opted in: core then refuses aws (and cloudflare) before activation.
    ...(streaming ? { streams: true } : {}),
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
        const schemasOf = new Map<string, { input: BodySchema; output?: BodySchema }>();
        for (const [toolName, tool] of Object.entries(spec.tools)) {
          /** The tool's schema, a project schema name resolved; admitted and compiled either way. */
          const resolve = (key: 'inputSchema' | 'outputSchema', declared: BodySchema | string, requirement: string): BodySchema => {
            const where = `MCP server ${name}: tool ${toolName} ${key}`;
            let schema: BodySchema;
            if (typeof declared === 'string') {
              const named = context.schemas && Object.hasOwn(context.schemas, declared) ? context.schemas[declared] : undefined;
              if (!named) throw new Error(`${where} names schema ${declared}, which the project does not declare under schemas`);
              schema = named;
            } else schema = declared;
            try { compileBodySchema(schema); }
            catch (error) { throw new Error(`${where}: ${(error as Error).message}`, { cause: error }); }
            if (schema.type !== 'object') throw new Error(`${where} must declare type: object (${requirement})`);
            return schema;
          };
          const input = resolve('inputSchema', tool.inputSchema, 'MCP tool arguments are always an object');
          const output = tool.outputSchema === undefined ? undefined : resolve('outputSchema', tool.outputSchema, 'MCP structuredContent is always an object');
          schemasOf.set(toolName, { input, ...(output ? { output } : {}) });
          // The hook contract's schema is deliberately permissive (any object): each call's arguments are checked
          // against the tool's own declared inputSchema, with the same request.body.<METHOD>.schema rules a native route uses.
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
        const tools = new Map<string, ActiveTool>(Object.entries(spec.tools).map(([toolName, tool]) => [toolName, { spec: tool, call: handlers[`tool:${toolName}`]!, ...schemasOf.get(toolName)! }]));
        const resources = new Map<string, ActiveResource>(Object.entries(spec.resources ?? {}).map(([resourceId, resource]) => [resourceId, { spec: resource, call: handlers[`resource:${resourceId}`]! }]));
        const prompts = new Map<string, ActivePrompt>(Object.entries(spec.prompts ?? {}).map(([promptId, prompt]) => [promptId, { spec: prompt, call: handlers[`prompt:${promptId}`]!, argumentsSchema: promptArgumentsSchema(prompt.arguments) }]));
        byMount.set(spec.mount, { name, spec, tools, resources, resourcesByUri, prompts });
      }
      for (const mount of context.mounts) if (!byMount.has(mount)) throw new Error(`MCP mount ${mount} has no server declared`);
      return {
        async handle(request: ExtensionRequest): Promise<HandlerResult> {
          const server = request.mount === null ? undefined : byMount.get(request.mount);
          if (!server || request.path !== request.mount) return textError(404, 'Not found');
          // DNS-rebinding defense the Streamable HTTP transport requires: core's same-origin rule. A present Origin
          // must be one of the site's origins; a request with no provenance header at all (non-browser MCP clients
          // send none) is admitted, since the endpoint takes application/json only. Refused before parsing.
          if (!isSameOriginRequest(request, context, { whenAbsent: 'admit' })) return textError(403, 'Forbidden');
          if (request.method === 'HEAD') return { status: 200, headers: [] };
          // The official SDK serves the request: it answers the JSON-RPC exchange (and 405 to GET/DELETE, which a
          // stateless server has no use for) from a fresh server bound to this one request.
          const url = new URL(request.path, context.origin);
          url.search = request.query.toString();
          const init: RequestInit = { method: request.method, headers: request.headers, ...(request.signal ? { signal: request.signal } : {}) };
          // The SDK decodes the body non-fatally, so invalid UTF-8 would reach a handler as U+FFFD. A body the SDK would
          // parse (a POST of application/json within the size bound; it answers 415 and 413 itself, first) is decoded
          // fatally here and refused with the SDK's own -32700 parse-error shape, as core's body reader refuses invalid
          // encoding (#1021).
          if (request.method === 'POST' && request.body.byteLength <= MAX_BODY && (request.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase() === 'application/json') {
            try { utf8.decode(request.body); }
            catch { return { status: 400, headers: [['content-type', 'application/json']], body: JSON.stringify({ jsonrpc: '2.0', error: { code: -32700, message: 'Parse error: the request body is not valid UTF-8' }, id: null }) }; }
          }
          if (request.method !== 'GET' && request.method !== 'DELETE') init.body = Buffer.from(request.body);
          const handler = createMcpHandler(() => serverFor(server, options, request, streaming), { maxRequestBodySize: MAX_BODY });
          const response = await handler.fetch(new Request(url, init));
          const headers: [string, string][] = [...response.headers].filter(([name]) => name !== 'content-length');
          if (streaming && response.body && response.headers.get('content-type')?.startsWith('text/event-stream')) return { status: response.status, headers, stream: chunks(response.body) };
          return { status: response.status, headers, body: new Uint8Array(await response.arrayBuffer()) };
        },
      };
    },
  };
}
