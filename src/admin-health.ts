/** Operator-supplied observations only. This adapter never fetches project URLs or exposes provider errors. */
export type HealthStatus = 'healthy' | 'degraded' | 'unavailable' | 'unknown';
export interface AdminHealthSnapshot {
    checkedAt: string;
    runtime: { status: HealthStatus; readiness: HealthStatus; version: string; routes: number };
    sender: HealthStatus;
    providers: readonly { id: string; status: HealthStatus }[];
    alerts: readonly ('sender-failed' | 'provider-expiring' | 'presentation-outdated' | 'translation-incomplete')[];
}
export type AdminHealthProvider = (context: { signal: AbortSignal }) => Promise<AdminHealthSnapshot>;
const statuses = new Set(['healthy', 'degraded', 'unavailable', 'unknown']);
const alerts = new Set(['sender-failed', 'provider-expiring', 'presentation-outdated', 'translation-incomplete']);
/** Validate and copy only the allowed fields: arbitrary errors, URLs, credentials and metadata never cross this boundary. */
export function validateHealthSnapshot(value: AdminHealthSnapshot): AdminHealthSnapshot {
    if (!value || typeof value.checkedAt !== 'string' || !Number.isFinite(Date.parse(value.checkedAt)) || new Date(value.checkedAt).toISOString() !== value.checkedAt || !value.runtime || !statuses.has(value.runtime.status) || !statuses.has(value.runtime.readiness) || typeof value.runtime.version !== 'string' || !/^[A-Za-z0-9.+_-]{1,64}$/.test(value.runtime.version) || !Number.isSafeInteger(value.runtime.routes) || value.runtime.routes < 0 || value.runtime.routes > 1000000 || !statuses.has(value.sender) || !Array.isArray(value.providers) || value.providers.length > 20 || !Array.isArray(value.alerts) || value.alerts.length > 20)
        throw new Error('Invalid health snapshot');
    const ids = new Set<string>();
    const providers = value.providers.map(provider => {
        if (!provider || typeof provider.id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(provider.id) || ids.has(provider.id) || !statuses.has(provider.status)) throw new Error('Invalid provider health');
        ids.add(provider.id);
        return { id: provider.id, status: provider.status };
    });
    if (value.alerts.some(alert => !alerts.has(alert))) throw new Error('Invalid health alert');
    return { checkedAt: value.checkedAt, runtime: { status: value.runtime.status, readiness: value.runtime.readiness, version: value.runtime.version, routes: value.runtime.routes }, sender: value.sender, providers, alerts: [...new Set(value.alerts)] };
}
/** Bound concurrent operator callbacks even when an adapter ignores cancellation. */
export function createHealthReader(provider: AdminHealthProvider): () => Promise<AdminHealthSnapshot | null> {
    let active = false;
    return async () => {
        if (active) return null;
        active = true;
        const controller = new AbortController();
        let timer: ReturnType<typeof setTimeout> | undefined;
        const operation = Promise.resolve().then(() => provider({ signal: controller.signal })).then(validateHealthSnapshot).finally(() => { active = false; });
        try {
            return await Promise.race([operation, new Promise<null>(resolve => { timer = setTimeout(() => { controller.abort(); resolve(null); }, 2000); })]);
        } catch { return null; }
        finally { if (timer) clearTimeout(timer); }
    };
}
