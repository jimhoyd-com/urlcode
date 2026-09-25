/**
 * The producer-side subset of the audit contract: what an outbox producer needs to validate events inside its own
 * storage (a worker thread, a data-file write) without loading the audit store, drain or backup modules.
 */
export { validateAuditEvent } from './event.ts';
export { AuditError, auditOutboxLimits } from './types.ts';
export type { AuditEvent, AuditValue } from './types.ts';
