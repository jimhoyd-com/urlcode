export class ConfigError extends Error {}
export class HttpError extends Error {
  readonly status: number;
  /** A pre-rendered, fixed-content answer that replaces the plain-text message (used for negotiated 422 bodies). */
  readonly answer: { contentType: string; text: string } | undefined;
  /**
   * `options.cause` carries the operator-side reason (for example the error a
   * trusted function threw) for local diagnostics only. The response body and
   * the event log never include it; see `--debug-errors` in docs/LOCAL-DEVELOPMENT.md.
   */
  constructor(status: number, message: string, answer?: { contentType: string; text: string }, options?: ErrorOptions) { super(message, options); this.status = status; this.answer = answer; }
}
export function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new ConfigError(message);
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
