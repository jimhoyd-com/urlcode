import { AuthHttpError, hasPermission } from '@jimhoyd/urlcode-auth';
import type { AuthService } from '@jimhoyd/urlcode-auth';
import { userFilters, usersCsv } from './admin-reporting.ts';

/** Buffer the complete bounded selection; failures never return partial CSV. */
export async function exportUserRange(service: AuthService, actorToken: string, query: URLSearchParams, reason: string): Promise<Uint8Array> {
    if (query.has('after')) throw new AuthHttpError(400, 'Complete exports start at the beginning of the selection');
    if (typeof reason !== 'string' || !reason.trim() || reason.length > 1000) throw new AuthHttpError(400, 'A bounded export reason is required');
    const filters = userFilters(query), deadline = performance.now() + 5000;
    const bounded = async <T>(operation: () => Promise<T>): Promise<T> => {
        const remaining = deadline - performance.now();
        if (remaining <= 0) throw new AuthHttpError(413, 'Narrow the user filters');
        let timer: ReturnType<typeof setTimeout> | undefined;
        try { return await Promise.race([operation(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new AuthHttpError(413, 'Narrow the user filters')), remaining); })]); }
        finally { clearTimeout(timer); }
    };
    const authorize = async () => {
        const actor = await bounded(() => service.authenticate(actorToken));
        if (!actor || actor.impersonatorId || !hasPermission(actor, 'auth.users.read') || !hasPermission(actor, 'auth.users.export') || actor.authenticatedAt <= 0 || Date.now() - actor.authenticatedAt > 300000) throw new AuthHttpError(403, 'Fresh user export authority required');
    };
    const chunks: Uint8Array[] = [usersCsv([])], seen = new Set<string>(), cursors = new Set<string>();
    let bytes = chunks[0]!.byteLength, after: string | undefined;
    do {
        await authorize();
        const page = await bounded(() => service.listUsers({ ...filters, limit: 100, ...(after ? { after } : {}) }));
        if (seen.size + page.users.length > 5000) throw new AuthHttpError(413, 'Narrow the user filters');
        for (const user of page.users) {
            if (seen.has(user.id)) throw new AuthHttpError(409, 'Users changed during export; restart the selection');
            seen.add(user.id);
            const exported = await bounded(() => service.adminExport({ actorToken, accountId: user.id, reason }));
            const full = usersCsv([{ ...exported.user, ...('observedLastSeen' in user ? { observedLastSeen: user.observedLastSeen } : {}) }]);
            const row = full.slice(chunks[0]!.byteLength);
            bytes += row.byteLength;
            if (bytes > 4 * 1024 * 1024) throw new AuthHttpError(413, 'Narrow the user filters');
            chunks.push(row);
        }
        after = page.next;
        if (after) { if (cursors.has(after)) throw new AuthHttpError(409, 'Users changed during export; restart the selection'); cursors.add(after); }
    } while (after);
    await authorize();
    if (performance.now() > deadline) throw new AuthHttpError(413, 'Narrow the user filters');
    return Buffer.concat(chunks, bytes);
}
