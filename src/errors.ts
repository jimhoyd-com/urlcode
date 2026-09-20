export class ConfigError extends Error {}
export class HttpError extends Error {
  readonly status: number;
  /** A pre-rendered, fixed-content answer that replaces the plain-text message (used for negotiated 422 bodies). */
  readonly answer: { contentType: string; text: string } | undefined;
  constructor(status: number, message: string, answer?: { contentType: string; text: string }) { super(message); this.status = status; this.answer = answer; }
}
export function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new ConfigError(message);
}
