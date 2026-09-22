import { AuthHttpError, hasPermission } from '@jimhoyd/urlcode-auth';
import type { AuthService } from '@jimhoyd/urlcode-auth';
import { auditFilters } from './admin-reporting.ts';
/** Complete bounded range export: never silently truncate a result or return partial unauthorized data. */
export async function exportAuditRange(service: AuthService, actorToken: string, query: URLSearchParams, reason: string): Promise<{ from: number; to: number; events: Awaited<ReturnType<AuthService['listAudit']>>['events'] }> {
    if (query.has('after')) throw new AuthHttpError(400, 'Range exports start at the beginning of the selected range');
    const filters = auditFilters(query);
    if (filters.from === undefined || filters.to === undefined) throw new AuthHttpError(400, 'Choose both UTC range endpoints');
    const from = filters.from, to = Math.min(filters.to, Date.now());
    if (from > to) throw new AuthHttpError(400, 'Choose a range that has started');
    const events: Awaited<ReturnType<AuthService['listAudit']>>['events'] = [];
    let after: string | undefined, bytes = 0;
    const started = Date.now(), seen = new Set<string>();
    do {
        const principal = await service.authenticate(actorToken);
        if (!principal || principal.impersonatorId || !hasPermission(principal, 'auth.audit.read') || !hasPermission(principal, 'auth.audit.export')) throw new AuthHttpError(403, 'Audit export permission required');
        if (Date.now() - started > 5000) throw new AuthHttpError(413, 'Choose a smaller audit range');
        const page = await service.listAudit({ ...filters, from, to, limit: 100, ...(after ? { after } : {}) });
        bytes += Buffer.byteLength(JSON.stringify(page.events));
        if (events.length + page.events.length > 5000 || bytes > 4 * 1024 * 1024) throw new AuthHttpError(413, 'Choose a smaller audit range');
        events.push(...page.events);
        after = page.next;
        if (after) { if (seen.has(after)) throw new AuthHttpError(503, 'Audit pagination unavailable'); seen.add(after); }
    } while (after);
    // The export is itself audited (actor, range, count), and requires a reason and fresh
    // authentication like other sensitive admin reveal/export actions — enforced by
    // adminAuditExport itself (permission, freshness), not duplicated here.
    await service.adminAuditExport({ actorToken, reason, from, to, count: events.length });
    return { from, to, events };
}
