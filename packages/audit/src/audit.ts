// createAudit: the store, the drain loops and the runtime registration, sharing one `active` state. The extension's
// host() calls it; tests and operator scripts may call it directly.
import type { ExtensionAuthoringContract, ExtensionInstance, HandlerResult, RuntimeExtension } from '@jimhoyd/urlcode/extensions';
import { AuditError } from './types.ts';
import type { Audit, AuditExports, AuditOptions, AuditProducer } from './types.ts';
import { MAX_BATCH, validateAuditEvent, validateAuditQuery } from './event.ts';
import { openAuditStore } from './store.ts';
import { createDrain } from './drain.ts';

export const DEFAULT_RETENTION = 100000, MIN_RETENTION = 1000, MAX_RETENTION = 10000000;

export const auditConfigSchema = {
  type: 'object', additionalProperties: false,
  properties: { retention: { type: 'integer', minimum: MIN_RETENTION, maximum: MAX_RETENTION } },
} as const;

export const auditAuthoring: ExtensionAuthoringContract = {
  description: 'Durable, bounded audit log. It serves no routes: other extensions record into it (auth always; store collections that declare audit: true) and admin reads it. The project declares only how many events it keeps.',
  surfaces: [
    { kind: 'configuration', name: 'retention', description: 'Newest events kept (1000..10000000, default 100000); older ones are pruned as new ones arrive.', path: 'urlcode.yaml#extensions.audit.config.retention' },
  ],
  fastChecks: ['urlcode validate --project . --host-file <host.mjs> --origin <origin>'],
};

function retentionOf(value: unknown): number {
  if (!Number.isInteger(value) || (value as number) < MIN_RETENTION || (value as number) > MAX_RETENTION) throw new Error(`Audit retention must be an integer from ${MIN_RETENTION} to ${MAX_RETENTION}`);
  return value as number;
}
function inactive(): AuditError { return new AuditError(503, 'audit_inactive', 'The audit extension is not active'); }
function notFound(): HandlerResult { return { status: 404, headers: [['content-type', 'text/plain; charset=utf-8']], body: 'Not found' }; }

export async function createAudit(options: AuditOptions): Promise<Audit> {
  if (!/^[a-f0-9]{64}$/.test(options.projectSha256)) throw new Error('audit extension requires an explicit operator revision pin');
  if (typeof options.database !== 'string' || !options.database) throw new Error('audit needs a database path');
  let retention = retentionOf(options.retention ?? DEFAULT_RETENTION);
  const now = options.now ?? Date.now;
  // A runtime reload may activate the next runtime before it closes the previous one: count the live activations.
  let activations = 0;
  const isActive = (): boolean => activations > 0;
  const store = await openAuditStore(options.database, options.onPruned);
  const drain = createDrain({ ingest: events => { store.ingest(events, retention, now()); }, isActive, now, onDeliveryError: options.onDeliveryError });
  let closed = false;

  const exports: AuditExports = Object.freeze({
    version: 1 as const,
    get active() { return isActive() && !closed; },
    validate: validateAuditEvent,
    async record(events: readonly unknown[]) {
      if (!Array.isArray(events) || events.length < 1 || events.length > MAX_BATCH) throw new AuditError(400, 'invalid_audit_event', `Record 1 to ${MAX_BATCH} audit events at a time`);
      const valid = events.map(validateAuditEvent);
      if (!exports.active) throw inactive();
      store.ingest(valid, retention, now());
    },
    attach(producer: AuditProducer) {
      if (closed) throw new AuditError(503, 'audit_unavailable', 'The audit host is closed');
      return drain.attach(producer);
    },
    async flush() { if (!exports.active) throw inactive(); await drain.flush(); },
    async query(filter?: unknown) {
      const query = validateAuditQuery(filter);
      if (!exports.active) throw inactive();
      return store.query(query);
    },
  });

  const registration: RuntimeExtension = {
    name: 'audit', version: '1', projectSha256: options.projectSha256, targets: ['node'],
    schema: auditConfigSchema, authoring: auditAuthoring,
    activate(config, context): ExtensionInstance {
      if (closed) throw new Error('The audit host is closed');
      if (context.mounts.length > 0) throw new Error('audit serves no routes; remove every route with extension: audit');
      if (config.retention !== undefined) retention = retentionOf(config.retention);
      activations++;
      drain.wake();
      let open = true;
      return {
        handle: () => notFound(),
        close() { if (open) { open = false; activations--; } },
      };
    },
  };

  return {
    registration, exports,
    async close() {
      if (closed) return;
      closed = true;
      await drain.close();
      store.close();
    },
  };
}
