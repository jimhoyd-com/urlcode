import {escapeHtml} from '@jimhoyd/urlcode-ui';
import { AuthHttpError, validateUserQuery } from '@jimhoyd/urlcode-auth';
import type { AuthService, AuthUser, UserQuery } from '@jimhoyd/urlcode-auth';
export function maskEmail(email: string): string { const at = email.lastIndexOf('@'); return at < 1 ? '***' : [...email][0] + '***' + email.slice(at); }
/** Every field is quoted; spreadsheet formula triggers are made literal text. */
export function csvCell(value: unknown): string {
    const text = String(value ?? ''), safe = /^[\s\uFEFF]*[=+\-@]/u.test(text) || /^[\t\r\n]/u.test(text) ? "'" + text : text;
    return '"' + safe.replaceAll('"', '""') + '"';
}
export function observedLastSeen(user: AuthUser): string {
    const value = 'observedLastSeen' in user ? user.observedLastSeen : undefined;
    return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= 8640000000000000 ? new Date(value).toISOString() : '';
}
export function usersCsv(users: readonly AuthUser[]): Uint8Array {
    if (users.length > 50)
        throw new AuthHttpError(400, 'Export exceeds one page');
    const rows: unknown[][] = [['id', 'email_masked', 'status', 'roles', 'created_utc', 'email_verified', 'display_name', 'locale', 'observed_last_seen_utc'], ...users.map(user => [user.id, maskEmail(user.email), user.status, user.roles.join(';'), new Date(user.created).toISOString(), user.emailVerified, user.profile?.displayName ?? '', user.profile?.locale ?? '', observedLastSeen(user)])];
    return new TextEncoder().encode(rows.map(row => row.map(csvCell).join(',')).join('\r\n') + '\r\n');
}
function one(values: URLSearchParams, key: string): string | undefined { const found = values.getAll(key); if (found.length > 1)
    throw new AuthHttpError(400, 'Duplicate filter'); return found[0] || undefined; }
export const userFilterKeys = ['query', 'role', 'status', 'method', 'verified', 'locale', 'createdFrom', 'createdTo', 'lastSeenFrom', 'lastSeenTo', 'sort', 'direction', 'lang'] as const;
function utc(value: string): number {
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?Z$/.test(value))
        throw new AuthHttpError(400, 'Use a UTC date and time ending in Z');
    const time = Date.parse(value);
    if (!Number.isSafeInteger(time) || time < 0 || new Date(time).toISOString().replace('.000Z', 'Z') !== (value.length === 17 ? value.slice(0, -1) + ':00Z' : value))
        throw new AuthHttpError(400, 'Invalid user time');
    return time;
}
export function userFilters(values: URLSearchParams): UserQuery {
    const input: UserQuery = { limit: 50 };
    for (const key of values.keys())
        if (![...userFilterKeys, 'after'].includes(key as typeof userFilterKeys[number]))
            throw new AuthHttpError(400, 'Unknown user filter');
    for (const key of ['query', 'role', 'status', 'method', 'locale', 'sort', 'direction', 'after'] as const) {
        const value = one(values, key);
        if (value)
            Object.assign(input, { [key]: value });
    }
    const verified = one(values, 'verified');
    if (verified !== undefined) {
        if (!['true', 'false'].includes(verified))
            throw new AuthHttpError(400, 'Invalid verification filter');
        input.verified = verified === 'true';
    }
    for (const key of ['createdFrom', 'createdTo', 'lastSeenFrom', 'lastSeenTo'] as const) {
        const value = one(values, key);
        if (value)
            input[key] = utc(value);
    }
    one(values, 'lang');
    try {
        return validateUserQuery(input);
    }
    catch {
        throw new AuthHttpError(400, 'Invalid user filters or cursor; restart the search');
    }
}
export function userFilterFields(values: URLSearchParams, text: (source: string) => string): string {
    const label = (source: string) => escapeHtml(text(source));
    const input = (key: string, title: string) => `<label>${label(title)}<input name="${key}" value="${escapeHtml(one(values, key) || '')}" autocomplete="off"></label>`;
    const select = (key: string, title: string, items: readonly (readonly [
        string,
        string
    ])[], fallback = '') => `<label>${label(title)}<select name="${key}">${items.map(([value, title]) => `<option value="${value}"${(one(values, key) || fallback) === value ? ' selected' : ''}>${label(title)}</option>`).join('')}</select></label>`;
    return input('query', 'Search email, masked email, name or account ID') + input('role', 'Role name') +
        select('status', 'Status', [['', 'Any status'], ['active', 'Active'], ['locked', 'Locked'], ['pending-delete', 'Pending deletion']]) +
        select('method', 'Stored credential method', [['', 'Any stored credential method'], ['password', 'Password'], ['passkey', 'Passkey'], ['oidc', 'External identity']]) +
        select('verified', 'Email verification', [['', 'Any verification'], ['true', 'Verified'], ['false', 'Unverified']]) + input('locale', 'Locale') +
        input('createdFrom', 'Created from UTC') + input('createdTo', 'Created to UTC') + input('lastSeenFrom', 'Last seen from UTC') + input('lastSeenTo', 'Last seen to UTC') +
        select('sort', 'Sort by', [['id', 'Account ID'], ['email', 'Email address'], ['displayName', 'Display name'], ['created', 'Created'], ['lastSeen', 'Last seen']], 'id') +
        select('direction', 'Direction', [['asc', 'Ascending'], ['desc', 'Descending']], 'asc') +
        (one(values, 'lang') ? `<input type="hidden" name="lang" value="${escapeHtml(one(values, 'lang')!)}">` : '');
}
export function auditFilters(values: URLSearchParams): NonNullable<Parameters<AuthService['listAudit']>[0]> {
    const result: NonNullable<Parameters<AuthService['listAudit']>[0]> = { limit: 50 };
    for (const name of ['actor', 'subject', 'action', 'after'] as const) {
        const value = one(values, name);
        if (value)
            result[name] = value;
    }
    for (const name of ['from', 'to'] as const) {
        const value = one(values, name);
        if (value) {
            if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?Z$/.test(value))
                throw new AuthHttpError(400, 'Use a UTC date and time ending in Z');
            const time = Date.parse(value);
            if (!Number.isSafeInteger(time) || time < 0 || new Date(time).toISOString().replace('.000Z', 'Z') !== (value.length === 17 ? value.slice(0, -1) + ':00Z' : value))
                throw new AuthHttpError(400, 'Invalid audit time');
            result[name] = time;
        }
    }
    if (result.from !== undefined && result.to !== undefined && result.from > result.to)
        throw new AuthHttpError(400, 'Invalid time range');
    return result;
}
export function nextPage(path: string, query: URLSearchParams, after: string, allowed: readonly string[]): string { const result = new URLSearchParams(); for (const name of allowed) {
    const value = one(query, name);
    if (value)
        result.set(name, value);
} result.set('after', after); return path + '?' + result.toString(); }
export function selectedNames(body: Uint8Array, contentType: string | null): string[] {
    if (body.byteLength > 16384)
        throw new AuthHttpError(413, 'Request body too large');
    let source: string;
    try {
        source = new TextDecoder('utf-8', { fatal: true }).decode(body);
    }
    catch {
        throw new AuthHttpError(400, 'Invalid encoding');
    }
    let names: string[];
    if (contentType?.split(';')[0]?.trim() === 'application/json') {
        try {
            const parsed: unknown = JSON.parse(source);
            names = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? Object.keys(parsed) : [];
        }
        catch {
            throw new AuthHttpError(400, 'Invalid JSON');
        }
    }
    else
        names = [...new URLSearchParams(source).keys()];
    return names.filter(name => /^selected\.[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(name));
}
export function selectedAccounts(fields: Record<string, string>): string[] {
    const ids = Object.entries(fields).filter(([name]) => name.startsWith('selected.')).map(([name, value]) => { if (value !== 'yes')
        throw new AuthHttpError(400, 'Invalid selection'); return name.slice(9); });
    if (fields.accountIds) {
        if (ids.length)
            throw new AuthHttpError(400, 'Use one selection format');
        ids.push(...fields.accountIds.split(',').map(value => value.trim()).filter(Boolean));
    }
    if (!ids.length || ids.length > 50 || new Set(ids).size !== ids.length)
        throw new AuthHttpError(400, 'Select between one and fifty distinct accounts');
    return ids;
}

export function sessionFilters(values:URLSearchParams): NonNullable<Parameters<AuthService['listAllSessions']>[0]> {
    const result:NonNullable<Parameters<AuthService['listAllSessions']>[0]>={limit:50};
    for(const key of values.keys()) if(!['accountId','device','createdFrom','createdTo','after','lang'].includes(key)) throw new AuthHttpError(400,'Unknown session filter');
    for(const key of ['accountId','device','after'] as const) {const value=one(values,key);if(value)result[key]=value;}
    for(const key of ['createdFrom','createdTo'] as const) {const value=one(values,key);if(value)result[key]=utc(value);}
    return result;
}
