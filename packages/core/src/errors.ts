/**
 * Machine-readable context for a configuration or command error. Every field is optional; the CLI copies the ones
 * present onto its `{"event":"error"}` line so an agent can act without parsing the prose. Values are authored names
 * (a route pattern, a project-relative file, a JSON pointer into the YAML), never request or secret data.
 */
export interface ErrorDetails {
  /** A stable kebab-case identifier for the kind of failure, such as `unknown-key` or `multiple-handlers`. */
  code?: string | undefined;
  /** The route pattern as written in YAML (unescaped). */
  route?: string | undefined;
  /** The project-relative file the failure is in. */
  file?: string | undefined;
  /** 1-based line and column in `file`. */
  line?: number | undefined;
  column?: number | undefined;
  /** RFC 6901 pointer into the parsed YAML document. */
  pointer?: string | undefined;
  /** The mapping key at `pointer` the failure is about (an unknown or duplicated key). */
  key?: string | undefined;
  /** The operator-registered extension the failure belongs to. */
  extension?: string | undefined;
}
const configErrorBrand = Symbol.for('urlcode.ConfigError');
export class ConfigError extends Error {
  readonly details: ErrorDetails;
  /** `options.cause` keeps the original error for the operator's own logs; the CLI prints only `message`. */
  constructor(message: string, details: ErrorDetails = {}, options?: ErrorOptions) { super(message, options); this.details = { ...details }; }
}
// A host file can import a second copy of this module (for example the published package while the CLI runs from a
// checkout); the brand lets the loader recognize that copy's ConfigError without trusting any other shape.
Object.defineProperty(ConfigError.prototype, configErrorBrand, { value: true });
/** A ConfigError from this module or from another copy of it, rebuilt as this module's class so the CLI prints it. */
export function asConfigError(error: unknown): ConfigError | undefined {
  if (error instanceof ConfigError) return error;
  if (!(error instanceof Error) || (error as unknown as Record<symbol, unknown>)[configErrorBrand] !== true) return undefined;
  const given = (error as { details?: unknown }).details, details: ErrorDetails = {};
  if (given && typeof given === 'object') for (const [key, value] of Object.entries(given)) if (['code', 'route', 'file', 'pointer', 'key', 'extension'].includes(key) ? typeof value === 'string' : ['line', 'column'].includes(key) && typeof value === 'number') (details as Record<string, unknown>)[key] = value;
  return new ConfigError(error.message, details, { cause: error });
}
export class HttpError extends Error {
  readonly status: number;
  /** A pre-rendered, fixed-content answer that replaces the plain-text message (used for JSON 422 bodies). */
  readonly answer: { contentType: string; text: string } | undefined;
  /**
   * `options.cause` carries the operator-side reason (for example the error a
   * trusted function threw) for local diagnostics only. The response body and
   * the event log never include it; see `--debug-errors` in docs/LOCAL-DEVELOPMENT.md.
   */
  constructor(status: number, message: string, answer?: { contentType: string; text: string }, options?: ErrorOptions) { super(message, options); this.status = status; this.answer = answer; }
}
export function assert(condition: unknown, message: string, details?: ErrorDetails): asserts condition {
  if (!condition) throw new ConfigError(message, details);
}
/**
 * Names the route a failure belongs to, once: a ConfigError without a route gains `Route <pattern>: ` and the
 * `route`/`pointer` details. Anything else is returned unchanged.
 */
export function routeError(error: unknown, pattern: string): unknown {
  if (!(error instanceof ConfigError) || error.details.route !== undefined) return error;
  const named = error.message.startsWith(`${pattern}: `) || error.message.startsWith(`Route ${pattern} `);
  return new ConfigError(named ? error.message : `Route ${pattern}: ${error.message}`, { ...error.details, code: error.details.code ?? 'invalid-route', route: pattern, pointer: error.details.pointer ?? `/routes/${pattern.replace(/~/g, '~0').replace(/\//g, '~1')}` });
}
const MAX_REPORTED_MESSAGE = 500;
/**
 * An operator-authored error message made safe to print on one line: control characters and runs of whitespace
 * collapse to a single space and the text is cut to a bounded length. Never includes a stack.
 */
export function boundedMessage(error: unknown, max = MAX_REPORTED_MESSAGE): string {
  const raw = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  const text = raw.replace(/[\u0000-\u001f\u007f-\u009f\s]+/g, ' ').trim();
  if (!text) return error instanceof Error ? `${error.name || 'Error'} with no message` : 'a non-Error value was thrown';
  return text.length > max ? `${text.slice(0, max)}...` : text;
}
/**
 * Names the extension a failure raised while preparing or activating it belongs to, once. The result is a
 * ConfigError, so `validate`, `test`, `dev` and `serve` startup print it: the text is what the operator's own
 * extension code or registration threw, reported on the operator's own console, never in an HTTP response
 * (request-time answers keep the fixed `Internal server error`). A ConfigError that already names an extension is
 * returned unchanged; other ConfigErrors keep their details and gain the `extension` field.
 */
export function extensionError(error: unknown, name: string, phase: 'activate' | 'prepare' | 'host'): ConfigError {
  if (error instanceof ConfigError && error.details.extension !== undefined) return error;
  const code = phase === 'activate' ? 'extension-activation' : phase === 'host' ? 'extension-host' : 'extension-registration';
  const details: ErrorDetails = error instanceof ConfigError ? { ...error.details, code: error.details.code ?? code, extension: name } : { code, extension: name };
  const what = phase === 'activate' ? 'failed to activate' : phase === 'host' ? 'host() failed' : 'registration could not be prepared';
  return new ConfigError(`Extension ${JSON.stringify(name)} ${what}: ${boundedMessage(error)}`, details, { cause: error });
}
/**
 * The operator's host file threw while it was imported (a top-level error, a failed import, or an extension's
 * `host()` hook when that copy of core could not name it). Like `extensionError`, the text is the operator's own
 * error on one bounded line with no stack, printed on the operator's console only. A module-resolution message can
 * include local file paths (the missing specifier and the importing file); they are shown as Node reports them.
 */
export function hostLoadError(error: unknown): ConfigError {
  return new ConfigError(`Host file failed to load: ${boundedMessage(error)}`, { code: 'host-load' }, { cause: error });
}
/** The defined detail fields only, for JSON output. */
export function errorFields(details: ErrorDetails): ErrorDetails {
  return Object.fromEntries(Object.entries(details).filter(([, value]) => value !== undefined)) as ErrorDetails;
}
const systemMessages: Record<string, string | undefined> = { ERR_PARSE_ARGS_UNKNOWN_OPTION:'Unknown option; use --help', EEXIST:'Destination or edit lock already exists', ENOENT:'Required file or directory not found', EADDRINUSE:'Port is already in use', EACCES:'Permission denied' };
/**
 * The message the CLI prints for a failed command: URLCode's own validation
 * and HTTP errors verbatim, well-known system error codes as a fixed sentence,
 * anything else as a generic next step. `internal: true` returns the text of
 * other errors too, for local, operator-only surfaces such as the stdio MCP
 * server where there is no one to hide it from.
 */
export function describeError(error: unknown, { internal = false }: { internal?: boolean } = {}): string {
  if (error instanceof ConfigError || error instanceof HttpError) return error.message;
  const code = typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string' ? error.code : undefined;
  const known = code !== undefined ? systemMessages[code] : undefined;
  if (known) return known;
  if (internal && error instanceof Error && error.message) return error.message;
  return 'Operation failed; check project files, module dependencies and command options';
}
/**
 * Appended to a binding or egress denial when the operator policy is pinned to
 * a different project revision, which is what makes every edit to a pinned
 * project fail the same way. Empty when there is no pin or it matches.
 */
export function revisionPinHint(pinned: string | undefined, actual: string | undefined): string {
  if (pinned === undefined || actual === undefined || pinned === actual) return '';
  return `: the policy is pinned to project revision ${pinned}, but the project is now revision ${actual}. Any change to routes, policies or function sources changes the revision; regenerate the requested grants with \`urlcode permissions\`, review them, and pin the new projectSha256`;
}
