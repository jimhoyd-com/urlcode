/** Auth's audit events as its outbox holds them (before the audit extension drains them), oldest first, at most 100. */
import type { AuditEvent } from '@jimhoyd/urlcode-audit';
import { internal } from '../../src/auth-core.ts';
import type { AuthService } from '../../src/auth-core.ts';

export async function outbox(service: AuthService, filter: { action?: string; actor?: string; subject?: string } = {}): Promise<AuditEvent[]> {
    return (await internal(service).auditOutbox.peek(100)).filter(event => (filter.action === undefined || event.action === filter.action) && (filter.actor === undefined || event.actor === filter.actor) && (filter.subject === undefined || event.subject === filter.subject));
}
