export class ConfigError extends Error {}
export class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}
export function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new ConfigError(message);
}
