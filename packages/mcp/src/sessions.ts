import { randomBytes } from 'node:crypto';
import type { ExtensionRequest, HandlerResult } from '@jimhoyd/urlcode/extensions';

/**
 * The optional parts of the MCP Streamable HTTP transport, enabled only by the operator's `streaming` option:
 * `Mcp-Session-Id` sessions, SSE replies to a `tools/call` that asked for progress, and the per-session GET stream
 * for server-initiated messages with a bounded `Last-Event-ID` replay buffer. Everything here lives in this
 * process's memory, in one extension instance; nothing survives a restart or a dev reload.
 */
export interface McpStreamingOptions {
  /** Most sessions kept at once; `initialize` beyond it evicts the least recently used one. Default 1000. */
  maxSessions?: number;
  /** A session unused for this long is forgotten (its id then answers 404). Default 1 800 000 (30 min). */
  sessionIdleTimeoutMs?: number;
  /**
   * Interval of the `: ping` keep-alive comment on an open SSE stream (the GET stream and a streamed `tools/call`).
   * Keep it below the server's stream idle timeout (`--stream-idle-timeout-ms`, default 30 000), or the server ends
   * a quiet stream. Default 15 000.
   */
  keepAliveMs?: number;
  /** Most server-initiated events a session keeps for `Last-Event-ID` replay. Default 64. */
  replayMaxEvents?: number;
  /** Most bytes of server-initiated events a session keeps for replay; a larger single event is not sent. Default 65 536. */
  replayMaxBytes?: number;
}
export type ResolvedStreamingOptions = Required<McpStreamingOptions>;
export const defaultStreamingOptions: Readonly<ResolvedStreamingOptions> = Object.freeze({
  maxSessions: 1000, sessionIdleTimeoutMs: 1_800_000, keepAliveMs: 15_000, replayMaxEvents: 64, replayMaxBytes: 65_536,
});
const ranges: Record<keyof ResolvedStreamingOptions, [number, number]> = {
  maxSessions: [1, 100_000], sessionIdleTimeoutMs: [1000, 86_400_000], keepAliveMs: [100, 600_000],
  replayMaxEvents: [1, 10_000], replayMaxBytes: [1024, 16_777_216],
};

/** `undefined` when streaming is off (the default); otherwise the validated limits. Throws on an invalid option. */
export function resolveStreamingOptions(value: boolean | McpStreamingOptions | undefined): ResolvedStreamingOptions | undefined {
  if (value === undefined || value === false) return undefined;
  if (value === true) return { ...defaultStreamingOptions };
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('mcp streaming must be a boolean or an options object');
  const resolved = { ...defaultStreamingOptions };
  for (const [key, option] of Object.entries(value)) {
    if (option === undefined) continue;
    const range = (ranges as Record<string, [number, number] | undefined>)[key];
    if (!range) throw new Error(`mcp streaming option ${key} is not known; known options: ${Object.keys(ranges).join(', ')}`);
    if (!Number.isInteger(option) || (option as number) < range[0] || (option as number) > range[1]) throw new Error(`mcp streaming option ${key} must be an integer from ${range[0]} to ${range[1]}`);
    resolved[key as keyof ResolvedStreamingOptions] = option as number;
  }
  if (resolved.keepAliveMs >= resolved.sessionIdleTimeoutMs) throw new Error('mcp streaming option keepAliveMs must be below sessionIdleTimeoutMs');
  return resolved;
}

/** One SSE event carrying a JSON-RPC message; the default event type (`message`) is what MCP clients read. */
export function sseFrame(message: unknown, id?: number): string {
  // JSON.stringify never emits a raw line break, so one `data:` line always carries the whole message.
  return `${id === undefined ? '' : `id: ${id}\n`}event: message\ndata: ${JSON.stringify(message)}\n\n`;
}
const PING = ': ping\n\n';
export function acceptsEventStream(request: ExtensionRequest): boolean {
  return /(?:^|[\s,])text\/event-stream(?:$|[\s,;])/i.test(request.headers.get('accept') ?? '');
}
function textError(status: number, message: string, headers: [string, string][] = []): HandlerResult {
  return { status, headers: [['content-type', 'text/plain; charset=utf-8'], ...headers], body: message };
}
/** Resolves on the next wake-up, abort, or when the keep-alive interval has passed (`'ping'`). */
function wait(signal: AbortSignal, ms: number, arm: (wake: () => void) => void): Promise<'wake' | 'ping'> {
  return new Promise(resolve => {
    let settled = false;
    const done = (why: 'wake' | 'ping'): void => {
      if (settled) return; settled = true;
      clearTimeout(timer); signal.removeEventListener('abort', onAbort); resolve(why);
    };
    const onAbort = (): void => done('wake');
    const timer = setTimeout(() => done('ping'), ms);
    signal.addEventListener('abort', onAbort, { once: true });
    arm(() => done('wake'));
    if (signal.aborted) done('wake');
  });
}

interface BufferedEvent { id: number; frame: string; bytes: number }
interface Attachment { wake: (() => void) | null; closed: boolean }
export interface McpSession {
  readonly id: string;
  /** `provider:id` of the principal that created the session, or `null` for an unauthenticated mount. */
  readonly owner: string | null;
  lastSeen: number;
  /** Last event id issued; ids are consecutive integers from 1, so a client can see a gap. */
  lastEventId: number;
  /** Highest event id handed to a GET stream. */
  delivered: number;
  buffer: BufferedEvent[]; bufferBytes: number;
  stream: Attachment | null;
  /** In-flight requests by JSON-encoded JSON-RPC id, for `notifications/cancelled`. */
  inflight: Map<string, AbortController>;
  /** Aborted when the session ends (DELETE, eviction, expiry, shutdown). */
  readonly ended: AbortController;
}
export type ProgressFn = (progress: number, total?: number, message?: string) => void;

/** The session owner key: the principal's provider and id, never anything a client sends. */
export function ownerOf(request: ExtensionRequest): string | null {
  return request.principal ? `${request.principal.provider}:${request.principal.id}` : null;
}

/**
 * The bounded in-memory session table of one extension instance. The Map's insertion order is the recency order:
 * every use moves a session to the end, so expired sessions are always at the front and the front is the least
 * recently used one to evict.
 */
export class McpSessionRegistry {
  readonly #sessions = new Map<string, McpSession>();
  readonly #options: ResolvedStreamingOptions;
  readonly #now: () => number;
  constructor(options: ResolvedStreamingOptions, now: () => number = Date.now) { this.#options = options; this.#now = now; }
  get size(): number { this.#sweep(); return this.#sessions.size; }
  create(owner: string | null): McpSession {
    this.#sweep();
    while (this.#sessions.size >= this.#options.maxSessions) this.#end(this.#sessions.keys().next().value!);
    // 32 random bytes as base64url: 43 visible-ASCII characters, as the transport requires of a session id.
    const session: McpSession = {
      id: randomBytes(32).toString('base64url'), owner, lastSeen: this.#now(), lastEventId: 0, delivered: 0,
      buffer: [], bufferBytes: 0, stream: null, inflight: new Map(), ended: new AbortController(),
    };
    this.#sessions.set(session.id, session);
    return session;
  }
  /** The live session with `id` owned by `owner`, touched; `undefined` for an unknown, expired or foreign id. */
  lookup(id: string, owner: string | null): McpSession | undefined {
    this.#sweep();
    const session = this.#sessions.get(id);
    // Another principal's id is answered exactly like an unknown one, so its existence is not revealed.
    if (!session || session.owner !== owner) return undefined;
    this.#touch(session);
    return session;
  }
  terminate(id: string): void { this.#end(id); }
  /**
   * Queues one server-initiated JSON-RPC message (a notification) for the session's GET stream, with the next
   * event id, and wakes an attached stream. The replay buffer keeps the newest events within its count and byte
   * bounds. Returns `false` when the session is gone or the event alone exceeds the byte bound.
   */
  send(id: string, message: unknown): boolean {
    const session = this.#sessions.get(id);
    if (!session) return false;
    const eventId = session.lastEventId + 1;
    const frame = sseFrame(message, eventId);
    const bytes = Buffer.byteLength(frame);
    if (bytes > this.#options.replayMaxBytes) return false;
    session.lastEventId = eventId;
    session.buffer.push({ id: eventId, frame, bytes });
    session.bufferBytes += bytes;
    while (session.buffer.length > this.#options.replayMaxEvents || session.bufferBytes > this.#options.replayMaxBytes) session.bufferBytes -= session.buffer.shift()!.bytes;
    session.stream?.wake?.();
    return true;
  }
  /**
   * Opens the session's GET stream. Without `Last-Event-ID` it starts after the last event handed to an earlier
   * stream (so events queued while no stream was open are delivered); with one, after that id. A newer GET replaces
   * the open one, which ends cleanly: a client whose connection died silently is never locked out of its session.
   */
  openStream(session: McpSession, lastEventId: number | undefined, signal: AbortSignal): AsyncGenerator<string> {
    if (session.stream) { session.stream.closed = true; session.stream.wake?.(); }
    const attachment: Attachment = { wake: null, closed: false };
    session.stream = attachment;
    this.#touch(session);
    const detach = (): void => { attachment.closed = true; if (session.stream === attachment) session.stream = null; attachment.wake?.(); };
    // Detach as soon as the client goes, even before the generator resumes, so a reconnect finds the slot free.
    signal.addEventListener('abort', detach, { once: true });
    session.ended.signal.addEventListener('abort', detach, { once: true });
    const keepAliveMs = this.#options.keepAliveMs;
    let cursor = lastEventId ?? session.delivered;
    const touch = (): void => this.#touch(session);
    return (async function* events(): AsyncGenerator<string> {
      try {
        yield ''; // commit the head now: a quiet stream should still announce itself
        for (;;) {
          if (attachment.closed || signal.aborted || session.ended.signal.aborted) return;
          const next = session.buffer.find(event => event.id > cursor);
          if (next) {
            cursor = next.id;
            if (cursor > session.delivered) session.delivered = cursor;
            yield next.frame;
            continue;
          }
          if (await wait(signal, keepAliveMs, wake => { attachment.wake = wake; }) === 'ping' && !attachment.closed) { touch(); yield PING; }
          attachment.wake = null;
        }
      } finally {
        signal.removeEventListener('abort', detach); session.ended.signal.removeEventListener('abort', detach);
        detach();
      }
    })();
  }
  close(): void { for (const id of [...this.#sessions.keys()]) this.#end(id); }
  #touch(session: McpSession): void {
    session.lastSeen = this.#now();
    this.#sessions.delete(session.id); this.#sessions.set(session.id, session);
  }
  #sweep(): void {
    const cutoff = this.#now() - this.#options.sessionIdleTimeoutMs;
    for (const session of this.#sessions.values()) { if (session.lastSeen > cutoff) break; this.#end(session.id); }
  }
  #end(id: string): void {
    const session = this.#sessions.get(id);
    if (!session) return;
    this.#sessions.delete(id);
    session.ended.abort('session-ended');
    for (const controller of session.inflight.values()) controller.abort('session-ended');
    session.inflight.clear();
    session.buffer = []; session.bufferBytes = 0;
  }
}

/** Reads the session a non-`initialize` request names: its session, or the transport's refusal (400 or 404). */
export function requestSession(registry: McpSessionRegistry, request: ExtensionRequest): { session: McpSession } | { refusal: HandlerResult } {
  const count = request.headerCounts['mcp-session-id'] ?? 0;
  const id = request.headers.get('mcp-session-id');
  if (count > 1) return { refusal: textError(400, 'Duplicate Mcp-Session-Id header') };
  if (id === null || id === '') return { refusal: textError(400, 'Missing Mcp-Session-Id header') };
  const session = registry.lookup(id, ownerOf(request));
  // 404 tells the client its session is gone (ended, expired, evicted or from before a restart): re-initialize.
  if (!session) return { refusal: textError(404, 'Session not found') };
  return { session };
}

/** Parses `Last-Event-ID`: `undefined` when absent, `null` when it is not an id this session issued. */
export function lastEventIdOf(request: ExtensionRequest, session: McpSession): number | undefined | null {
  if ((request.headerCounts['last-event-id'] ?? 0) > 1) return null;
  const raw = request.headers.get('last-event-id');
  if (raw === null) return undefined;
  if (!/^(?:0|[1-9][0-9]{0,15})$/.test(raw)) return null;
  const value = Number(raw);
  return value <= session.lastEventId ? value : null;
}

/**
 * The SSE reply to one `tools/call` that asked for progress: `notifications/progress` messages as the tool reports
 * them, then the JSON-RPC response, then the end of the stream. `run` starts at once; progress reported faster than
 * the client reads is coalesced to the latest value, and a value that does not increase is dropped (the progress
 * utility requires it to increase). The events carry no id: a POST stream is not resumable here.
 */
export function progressStream(options: { signal: AbortSignal; keepAliveMs: number; progressToken: string | number; run: (progress: ProgressFn) => Promise<unknown> }): AsyncGenerator<string> {
  const { signal, keepAliveMs, progressToken } = options;
  let pending: string | undefined;
  let final: string | undefined;
  let failure: { error: unknown } | undefined;
  let wake: (() => void) | null = null;
  let settled = false;
  let last = -Infinity;
  const progress: ProgressFn = (value, total, message) => {
    if (settled || signal.aborted || typeof value !== 'number' || !Number.isFinite(value) || value <= last) return;
    last = value;
    pending = sseFrame({ jsonrpc: '2.0', method: 'notifications/progress', params: {
      progressToken, progress: value,
      ...(typeof total === 'number' && Number.isFinite(total) ? { total } : {}),
      ...(typeof message === 'string' ? { message: message.length <= 1024 ? message : `${message.slice(0, 1023)}…` } : {}),
    } });
    wake?.();
  };
  options.run(progress).then(response => { settled = true; final = sseFrame(response); wake?.(); }, (error: unknown) => { settled = true; failure = { error }; wake?.(); });
  return (async function* reply(): AsyncGenerator<string> {
    yield ''; // commit the head at once: the client learns it is getting a stream before the tool finishes
    for (;;) {
      if (pending !== undefined) { const frame = pending; pending = undefined; yield frame; continue; }
      if (failure) throw failure.error;
      if (final !== undefined) { yield final; return; }
      if (signal.aborted) return;
      const why = await wait(signal, keepAliveMs, next => { wake = next; });
      wake = null;
      if (why === 'ping' && pending === undefined && final === undefined) yield PING;
    }
  })();
}
