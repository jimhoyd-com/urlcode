// Bound buffered operational output when the log collector cannot keep up.
// Dropped records are counted and reported when output becomes writable again.
// `format`, when given, renders one line for an event (for a TTY); returning
// undefined for an event it does not know falls back to the JSON line, so a
// human formatter never has to cover every event name. `logs_dropped` itself
// always stays JSON, so a collector parsing for it never has to special-case format.
export function createJsonLogger(stream: LogSink = process.stdout, maxBufferBytes = 1048576, format?: EventFormatter): JsonLogger {
  let state=sinkStates.get(stream);
  if(!state){const created={failed:false};state=created;sinkStates.set(stream,created);stream.on?.('error',()=>{created.failed=true;});}
  const sink=state;
  let dropped = 0;
  return event => {
    if (sink.failed || stream.destroyed || stream.writableLength >= maxBufferBytes) { dropped++; return; }
    try {
      if (dropped) {
        stream.write(JSON.stringify({ event:'logs_dropped',count:dropped }) + '\n');
        dropped = 0;
      }
      const rendered = format?.(event as Record<string, unknown>);
      stream.write((rendered !== undefined ? rendered : JSON.stringify(event)) + '\n');
    } catch {sink.failed=true;dropped++;}
  };
}
export type EventFormatter = (event: Record<string, unknown>) => string | undefined;
type JsonLogger = (event: object) => void;
/**
 * Human-readable `dev`/`serve` request/reload/watch/extension-warning lines for a TTY (`GET /go 302 0.9ms`), falling back to the JSON
 * line (via `createJsonLogger`'s own fallback) for any event this does not render. `routes` is a mutable box the
 * caller owns and seeds from the started server's route count: this formatter only ever updates it from `reload`'s
 * own `routes` field afterwards, never by inferring one from a route pattern. No event carries a raw request path
 * (see docs/OBSERVABILITY.md's privacy guarantees), so `route` here is always the configured pattern, or null when
 * unmatched — the same value the JSON `detailed` request log already carries, just rendered as one short line.
 */
export function createDevEventFormatter(routes: { count: number }): EventFormatter {
  return event => {
    const kind = event.event;
    if (kind === 'reload') {
      if (event.status === 'ok' && typeof event.routes === 'number') routes.count = event.routes;
      return event.status === 'ok' ? `Reloaded — ${String(event.routes)} route${event.routes === 1 ? '' : 's'}` : 'Reload rejected — kept serving the previous version';
    }
    if (kind === 'watch') return 'Could not watch the project for changes';
    if (kind === 'extension_warning') return `Extension ${JSON.stringify(String(event.extension))} warning: ${String(event.message)}`;
    if (kind !== 'request') return undefined;
    const { status, durationMs, method, route } = event as { status?: unknown; durationMs?: unknown; method?: unknown; route?: unknown };
    const parts = [typeof method === 'string' ? method : undefined, typeof route === 'string' ? route : route === null ? '(unmatched)' : undefined, String(status), `${String(durationMs)}ms`].filter((part): part is string => part !== undefined);
    const hint = status === 404 && route === null && routes.count === 0 ? ' — no routes configured; add one to urlcode.yaml' : '';
    return parts.join(' ') + hint;
  };
}
/** What the logger needs from its sink: the members of a Writable it touches. process.stdout satisfies it. */
interface LogSink { write(chunk: string): unknown; writableLength: number; destroyed?: boolean; on?(event: 'error', listener: () => void): unknown }
const sinkStates = new WeakMap<LogSink, { failed: boolean }>();
