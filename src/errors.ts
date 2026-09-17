export class ConfigError extends Error {}
export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
export function assert(condition, message) {
  if (!condition) throw new ConfigError(message);
}
