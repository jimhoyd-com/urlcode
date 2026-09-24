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
}
export class ConfigError extends Error {
  readonly details: ErrorDetails;
  constructor(message: string, details: ErrorDetails = {}) { super(message); this.details = { ...details }; }
}
export class HttpError extends Error {
  readonly status: number;
  /** A pre-rendered, fixed-content answer that replaces the plain-text message (used for JSON 422 bodies). */
  readonly answer: { contentType: string; text: string } | undefined;
  constructor(status: number, message: string, answer?: { contentType: string; text: string }) { super(message); this.status = status; this.answer = answer; }
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
/** The defined detail fields only, for JSON output. */
export function errorFields(details: ErrorDetails): ErrorDetails {
  return Object.fromEntries(Object.entries(details).filter(([, value]) => value !== undefined)) as ErrorDetails;
}
