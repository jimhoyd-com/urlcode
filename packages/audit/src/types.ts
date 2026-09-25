import type { RuntimeExtension } from '@jimhoyd/urlcode/extensions';

/** Plain JSON a producer may attach as metadata. Never secrets or submitted values. */
export type AuditValue = string | number | boolean | null | readonly AuditValue[] | { readonly [key: string]: AuditValue };
/** What producers write. Validated by validateAuditEvent, the same function the producer runs before it persists to its outbox. */
export interface AuditEvent {
  /** Producer-assigned idempotency key: crypto.randomUUID() (lowercase v4). */
  readonly id: string;
  /** Producing extension name, /^[a-z][a-z0-9-]{0,63}$/ ("auth", "store", "admin"). */
  readonly source: string;
  /** /^[a-z][a-z0-9_.-]{0,127}$/, for example "session.login", "admin.roles", "store.record.created". */
  readonly action: string;
  /** 1..256 characters, no C0/DEL: a principal id, account id, "anonymous", "operator" or "system". */
  readonly actor: string;
  /** 0..512 characters, no C0/DEL. */
  readonly subject: string;
  /** The producer's event time, epoch ms, a safe integer >= 0. */
  readonly at: number;
  /** 0..1024 characters, no C0/DEL; the operator-typed reason where one exists. Default "". */
  readonly reason?: string;
  /** Plain JSON, depth <= 3, <= 16 keys per object, serialized <= 4096 bytes. */
  readonly metadata?: Readonly<Record<string, AuditValue>>;
}
export interface AuditStoredEvent extends Required<Omit<AuditEvent, 'metadata'>> {
  readonly metadata: Readonly<Record<string, AuditValue>> | null;
  /** Ingest order, an opaque decimal string; the pagination cursor. */
  readonly seq: string;
  /** When audit stored it, epoch ms. */
  readonly recordedAt: number;
}
export interface AuditQuery {
  source?: string; actor?: string; subject?: string; action?: string;
  /** Matches action = prefix or an action starting with prefix + "." ("admin" matches admin.*). */
  actionPrefix?: string;
  /** Inclusive bounds on `at`. */
  from?: number; to?: number;
  /** A `next` value a previous page with the same filter and order returned. */
  after?: string;
  /** 1..100, default 50. */
  limit?: number;
  /** Default "asc" (ingest order); "desc" for newest-first views. */
  order?: 'asc' | 'desc';
}
export interface AuditPage {
  readonly events: readonly AuditStoredEvent[];
  /** Present when more events match; pass it back as `after`. */
  readonly next?: string;
  /** Lowest retained seq at query time, so a range exporter can detect pruning mid-export. Absent when the log is empty. */
  readonly oldest?: string;
}
/** An outbox audit drains. The producer owns atomic capture; audit owns the drain loop. */
export interface AuditProducer {
  readonly source: string;
  /** Oldest first, at most `limit` (audit asks for <= 100). Every event.source must equal `source`. */
  peek(limit: number): Promise<readonly AuditEvent[]>;
  /** Removes delivered events; unknown ids are ignored. */
  ack(ids: readonly string[]): Promise<void>;
}
export interface AuditAttachment {
  /** Wakes the drain loop now (call it after a commit that wrote outbox rows). Never throws. */
  notify(): void;
  /** Stops draining this producer; resolves after an in-flight batch finishes. */
  close(): Promise<void>;
}
export interface AuditExports {
  readonly version: 1;
  /** True once the runtime activated extensions.audit; record, query and flush refuse with 503 audit_inactive until then. */
  readonly active: boolean;
  /** Pure validation, the same function as validateAuditEvent; throws AuditError(400). */
  validate(value: unknown): AuditEvent;
  /** 1..100 validated events; resolves after a durable commit; idempotent on id. */
  record(events: readonly AuditEvent[]): Promise<void>;
  /** Registers a producer. Callable from host() before activation (the loop waits for `active`). A duplicate source throws. */
  attach(producer: AuditProducer): AuditAttachment;
  /**
   * Resolves once every event pending in an attached producer at call time is stored: a producer is done when its
   * peek is empty or holds only events newer than the call. Rejects 503 audit_flush_timeout after 2000 ms.
   */
  flush(): Promise<void>;
  query(filter?: AuditQuery): Promise<AuditPage>;
}
export type AuditErrorCode = 'invalid_audit_event' | 'invalid_audit_query' | 'audit_inactive' | 'audit_unavailable' | 'audit_flush_timeout' | 'audit_backlog';
/** Also thrown by producers: a full outbox refuses the mutation with new AuditError(503, 'audit_backlog'). */
export class AuditError extends Error {
  readonly status: 400 | 503;
  readonly code: AuditErrorCode;
  constructor(status: 400 | 503, code: AuditErrorCode, message?: string) {
    super(message ?? code);
    this.name = 'AuditError';
    this.status = status;
    this.code = code;
  }
}
/** Outbox caps, exported so producers and docs agree. A producer at its cap refuses the mutation with 503 audit_backlog. */
export const auditOutboxLimits: { readonly auth: 10000; readonly perCollection: 1000 } = Object.freeze({ auth: 10000, perCollection: 1000 } as const);
/** Conventional permission names a consumer checks before showing or exporting audit data. Audit itself enforces none. */
export const auditPermissions: readonly ['audit.read', 'audit.export'] = Object.freeze(['audit.read', 'audit.export'] as const);
export interface AuditOptions {
  /** Exact project revision the operator reviewed. */
  projectSha256: string;
  /** Absolute path of the SQLite file; created 0600 when absent. */
  database: string;
  /** Newest events kept, 1000..10000000, default 100000. `extensions.audit.config.retention` overrides it at activation. */
  retention?: number;
  /** Best effort, called after a commit that pruned rows past `retention`. Never affects the store. */
  onPruned?: (removed: number) => void;
  /** Best effort, called when a drain round fails (it retries) or stops a producer that broke the contract. */
  onDeliveryError?: (source: string, error: unknown) => void;
  now?: () => number;
}
export interface Audit { registration: RuntimeExtension; exports: AuditExports; close(): Promise<void> }
