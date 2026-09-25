// The administration API auth exports to admin and any other administrative extension. Every call names an opaque
// actor (exports.ts) that stands for the caller's live session: reads check the actor's permission here, and every
// mutation runs in auth's store transaction, which re-checks the session, freshness, permission, delegation ceiling,
// last-administrator and maker-checker guards and writes the audit event. Every message that carries a credential
// (setup, invitation, recovery, account operations) or announces a support session is delivered by auth here, so a
// raw token never leaves auth.
import type { ExtensionHookContext } from '@jimhoyd/urlcode/extensions';
import type { AdminAccountDelivery, AdminAccountRequest, AdminAuthenticationMethods } from './admin-account-operations.ts';
import type { AuthCase, AuthServiceInternal, AuthSession, AuthUser } from './auth-core.ts';
import { AuthError } from './auth-store.ts';
import type { Delivery } from './delivery.ts';
import { accountOf, actorSession } from './exports.ts';
import type { AuthAccount, AuthActor } from './exports.ts';
import { FRESHNESS_WINDOW_MS } from './freshness.ts';
import type { ManualRecoveryCase, ManualRecoveryEvidence } from './manual-recovery.ts';
import type { UserQuery } from './user-query.ts';

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type AdminAccountRequestInput = DistributiveOmit<AdminAccountRequest, 'actorToken' | 'context'>;
export interface AuthPage { limit?: number; after?: string }
export type AuthSessionFilters = { accountId?: string; device?: string; createdFrom?: number; createdTo?: number; limit?: number; after?: string };
export type AuthDashboard = Awaited<ReturnType<AuthServiceInternal['dashboard']>>;
export type AuthAccountExport = Awaited<ReturnType<AuthServiceInternal['adminExport']>>;
/** Every call may carry the request's hook context, handed to the lifecycle hooks it fires. */
type Call<T> = T & { context?: ExtensionHookContext };

export interface AuthAdministration {
    /** Read per call: delivery is the mail extension's `available`. */
    readonly capabilities: Readonly<{
        delivery: boolean;
        /** delivery, and registration is invite-only, waitlist or open. */
        invitations: boolean;
        /** The operator allowed impersonation, and delivery (the notice is mandatory). */
        impersonation: boolean;
        manualRecovery: boolean;
        accountOperations: boolean;
    }>;
    dashboard(actor: AuthActor): Promise<AuthDashboard>;
    roles(actor: AuthActor): Promise<Readonly<Record<string, readonly string[]>>>;
    users: {
        list(actor: AuthActor, query: UserQuery): Promise<{ users: AuthUser[]; next?: string }>;
        get(actor: AuthActor, accountId: string): Promise<AuthUser | null>;
        sessions(actor: AuthActor, accountId: string): Promise<AuthSession[]>;
        authentication(actor: AuthActor, input: { accountId: string; reason: string }): Promise<AdminAuthenticationMethods>;
        reveal(actor: AuthActor, input: { accountId: string; reason: string }): Promise<{ id: string; email: string }>;
        export(actor: AuthActor, input: { accountId: string; reason: string }): Promise<AuthAccountExport>;
        /** The complete selection or nothing: <= 5000 accounts, <= 4 MiB, <= 5 s; fresh users.read + users.export re-checked before every page and at the end. */
        exportRange(actor: AuthActor, input: { query: UserQuery; reason: string }): Promise<(AuthAccountExport['user'] & { observedLastSeen?: number })[]>;
        addNote(actor: AuthActor, input: { accountId: string; reason: string }): Promise<void>;
        setRoles(actor: AuthActor, input: Call<{ accountId: string; roles: string[]; reason: string }>): Promise<AuthUser>;
        setStatus(actor: AuthActor, input: Call<{ accountId: string; status: 'active' | 'locked'; reason: string }>): Promise<AuthUser>;
        revokeSessions(actor: AuthActor, input: { accountId: string; reason: string }): Promise<void>;
        bulk(actor: AuthActor, input: Call<{ accountIds: string[]; action: 'lock' | 'unlock' | 'revoke-sessions'; reason: string }>): Promise<{ affected: number }>;
        /** Creates the account and delivers its setup link; 503 delivery_unavailable without delivery, 502 delivery_failed (account kept) when it fails. */
        create(actor: AuthActor, input: Call<{ email: string; reason: string }>): Promise<{ user: AuthUser }>;
        /** Stages the operation, delivers each message (4 in flight, 5 s each, 30 s in all), then completes it; any failure cancels it. */
        administer(actor: AuthActor, input: Call<AdminAccountRequestInput>): Promise<{ affected: number }>;
    };
    sessions: {
        list(actor: AuthActor, filters: AuthSessionFilters): Promise<{ sessions: (AuthSession & { accountId: string; email: string })[]; next?: string }>;
        revoke(actor: AuthActor, input: { sessionId: string; reason: string }): Promise<void>;
    };
    registrations: {
        list(actor: AuthActor, page: AuthPage): Promise<{ requests: { id: string; email: string; created: number }[]; next?: string }>;
        approve(actor: AuthActor, input: Call<{ requestId: string; reason: string }>): Promise<AuthUser>;
        /** Issues the invitation and delivers it; 503 delivery_unavailable without delivery, 502 delivery_failed. */
        invite(actor: AuthActor, input: { email: string }): Promise<void>;
    };
    cases: {
        list(actor: AuthActor, page: AuthPage): Promise<{ cases: AuthCase[]; next?: string }>;
        get(actor: AuthActor, caseId: string): Promise<AuthCase | null>;
        create(actor: AuthActor, input: Call<{ accountId: string; action: 'reset-factors' | 'lock' | 'unlock' | 'roles'; roles?: string[]; reason: string }>): Promise<AuthCase>;
        note(actor: AuthActor, input: { caseId: string; note: string }): Promise<AuthCase>;
        close(actor: AuthActor, input: { caseId: string; reason: string }): Promise<AuthCase>;
        approve(actor: AuthActor, input: Call<{ caseId: string; reason: string }>): Promise<AuthCase>;
    };
    recovery: {
        list(actor: AuthActor, page: AuthPage): Promise<{ cases: ManualRecoveryCase[]; next?: string }>;
        create(actor: AuthActor, input: { accountId: string; email: string; evidence: ManualRecoveryEvidence; reason: string }): Promise<ManualRecoveryCase>;
        /** Approves, warns the old address then delivers the restoration link (4 at once, 5 s), then activates; any failure cancels the credential. */
        approve(actor: AuthActor, input: { caseId: string; reason: string }): Promise<void>;
    };
    /** Starts a ten-minute support session after its mandatory notice (5 s): the session's Set-Cookie pairs and auth's account URL. A failed notice ends the session and throws. */
    impersonate(actor: AuthActor, input: { accountId: string; reason: string }): Promise<{ headers: readonly [string, string][]; location: string }>;
    /**
     * Re-validates the actor's live session (revoked, locked or impersonated gives 401), checks every permission
     * (AuthAccount.has) and, with `fresh`, the freshness window (401 fresh_authentication_required). Returns the
     * refreshed account. Admin calls it before each audit export page.
     */
    reauthorize(actor: AuthActor, input: { permissions: readonly string[]; fresh?: boolean }): Promise<AuthAccount>;
}

export interface AdministrationSite { mount: string; sessionHeaders(token: string): [string, string][] }
interface Dependencies {
    service: AuthServiceInternal;
    delivery: Delivery;
    /** The active activation, or undefined: every call refuses while auth is inactive. */
    site(): AdministrationSite | undefined;
    now?: () => number;
}
const DELIVERY_MS = 5000, OPERATION_MS = 30000, IN_FLIGHT = 4, EXPORT_ACCOUNTS = 5000, EXPORT_BYTES = 4 * 1024 * 1024, EXPORT_MS = 5000;
const noticeAction = (action: string) => ('admin-' + action) as `admin-${Exclude<AdminAccountDelivery, { kind: 'token' }>['action']}`;

export function createAdministration({ service, delivery, site, now = Date.now }: Dependencies): AuthAdministration {
    let delivering = 0;
    const active = (): AdministrationSite => {
        const current = site();
        if (!current)
            throw new AuthError(503, 'auth_inactive');
        return current;
    };
    /** The actor's live session as an account, or 401 when it is gone, locked or a support session. */
    async function resolve(actor: AuthActor): Promise<{ token: string; account: AuthAccount }> {
        active();
        const { token, accountId } = actorSession(actor), principal = await service.authenticate(token);
        if (!principal || principal.id !== accountId || principal.impersonatorId)
            throw new AuthError(401, 'invalid_session');
        const locale = (await service.getUser(principal.id))?.profile?.locale;
        return { token, account: accountOf(principal, token, locale, now()) };
    }
    async function permitted(actor: AuthActor, ...permissions: string[]): Promise<string> {
        const { token, account } = await resolve(actor);
        if (!permissions.every(permission => account.has(permission)))
            throw new AuthError(403, 'permission_denied');
        return token;
    }
    /** Mutations: the store checks the session, permission and freshness inside its transaction. */
    const tokenOf = (actor: AuthActor) => { active(); return actorSession(actor).token; };
    /** One delivery slot of the 4 auth runs at once for administrators, held for the whole operation. */
    async function slot<T>(run: () => Promise<T>): Promise<T> {
        if (delivering >= IN_FLIGHT)
            throw new AuthError(503, 'delivery_busy');
        delivering++;
        try { return await run(); }
        finally { delivering--; }
    }
    async function reauthorize(actor: AuthActor, input: { permissions: readonly string[]; fresh?: boolean }): Promise<AuthAccount> {
        const { account } = await resolve(actor);
        if (!Array.isArray(input?.permissions) || !input.permissions.every(permission => typeof permission === 'string' && account.has(permission)))
            throw new AuthError(403, 'permission_denied');
        if (input.fresh && (account.authenticatedAt <= 0 || now() - account.authenticatedAt > FRESHNESS_WINDOW_MS))
            throw new AuthError(401, 'fresh_authentication_required');
        return account;
    }
    const required = () => { if (!delivery.available) throw new AuthError(503, 'delivery_unavailable'); };
    const failed = (error: unknown): never => { throw new AuthError(502, 'delivery_failed', error); };
    const capabilities = Object.freeze({
        get delivery() { return delivery.available; },
        get invitations() { return delivery.available && ['invite-only', 'waitlist', 'open'].includes(service.getRegistrationMode()); },
        get impersonation() { return service.getImpersonationEnabled() && delivery.available; },
        get manualRecovery() { return service.getManualRecoveryEnabled() && delivery.available; },
        get accountOperations() { return delivery.available; },
    });
    async function deliverAccountMessage(message: AdminAccountDelivery, signal: AbortSignal): Promise<void> {
        if (message.kind === 'token')
            await delivery.token(message.purpose, message.email, message.token, message.locale, { strict: true, signal });
        else
            await delivery.send(noticeAction(message.action), message.email, { link: delivery.page('/account') }, message.locale, { strict: true, signal });
    }
    return {
        capabilities,
        async dashboard(actor) { await permitted(actor, 'auth.users.read'); return service.dashboard(); },
        async roles(actor) { await permitted(actor, 'auth.roles.read'); return service.getRoles(); },
        users: {
            async list(actor, query) { await permitted(actor, 'auth.users.read'); return service.listUsers(query); },
            async get(actor, accountId) { await permitted(actor, 'auth.users.read'); return service.getUser(accountId); },
            async sessions(actor, accountId) { await permitted(actor, 'auth.sessions.manage'); return service.listSessions(accountId); },
            authentication: (actor, input) => service.inspectAccountAuthentication({ actorToken: tokenOf(actor), ...input }),
            reveal: (actor, input) => service.adminReveal({ actorToken: tokenOf(actor), ...input }),
            export: (actor, input) => service.adminExport({ actorToken: tokenOf(actor), ...input }),
            async exportRange(actor, input) {
                if (!input || typeof input.reason !== 'string' || !input.reason.trim() || input.reason.length > 256)
                    throw new AuthError(400, 'invalid_reason');
                if (input.query?.after !== undefined)
                    throw new AuthError(400, 'export_starts_at_beginning');
                const deadline = performance.now() + EXPORT_MS, tooLarge = () => new AuthError(413, 'export_too_large');
                const bounded = async <T>(operation: () => Promise<T>): Promise<T> => {
                    const remaining = deadline - performance.now();
                    if (remaining <= 0)
                        throw tooLarge();
                    let timer: ReturnType<typeof setTimeout> | undefined;
                    try { return await Promise.race([operation(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(tooLarge()), remaining); })]); }
                    finally { clearTimeout(timer); }
                };
                const authorize = () => bounded(() => reauthorize(actor, { permissions: ['auth.users.read', 'auth.users.export'], fresh: true }));
                const rows: (AuthAccountExport['user'] & { observedLastSeen?: number })[] = [], seen = new Set<string>(), cursors = new Set<string>();
                let bytes = 0, after: string | undefined;
                do {
                    await authorize();
                    const token = tokenOf(actor);
                    const page = await bounded(() => service.listUsers({ ...input.query, limit: 100, ...(after ? { after } : {}) }));
                    if (seen.size + page.users.length > EXPORT_ACCOUNTS)
                        throw tooLarge();
                    for (const user of page.users) {
                        if (seen.has(user.id))
                            throw new AuthError(409, 'users_changed_during_export');
                        seen.add(user.id);
                        const exported = await bounded(() => service.adminExport({ actorToken: token, accountId: user.id, reason: input.reason.trim() }));
                        const row = { ...exported.user, ...(user.observedLastSeen !== undefined ? { observedLastSeen: user.observedLastSeen } : {}) };
                        bytes += Buffer.byteLength(JSON.stringify(row));
                        if (bytes > EXPORT_BYTES)
                            throw tooLarge();
                        rows.push(row);
                    }
                    after = page.next;
                    if (after) {
                        if (cursors.has(after))
                            throw new AuthError(409, 'users_changed_during_export');
                        cursors.add(after);
                    }
                } while (after);
                await authorize();
                if (performance.now() > deadline)
                    throw tooLarge();
                return rows;
            },
            addNote: (actor, input) => service.adminAddNote({ actorToken: tokenOf(actor), ...input }),
            setRoles: (actor, input) => service.adminSetRoles({ actorToken: tokenOf(actor), ...input }),
            setStatus: (actor, input) => service.adminSetStatus({ actorToken: tokenOf(actor), ...input }),
            revokeSessions: (actor, input) => service.adminRevokeSessions({ actorToken: tokenOf(actor), ...input }),
            bulk: (actor, input) => service.adminBulk({ actorToken: tokenOf(actor), ...input }),
            async create(actor, input) {
                const actorToken = tokenOf(actor);
                required();
                const created = await service.adminCreateUser({ actorToken, ...input });
                await slot(() => delivery.token('account-setup', created.user.email, created.setupToken, created.user.profile?.locale, { strict: true, signal: AbortSignal.timeout(DELIVERY_MS) })).catch(failed);
                return { user: created.user };
            },
            async administer(actor, input) {
                const actorToken = tokenOf(actor);
                required();
                return await slot(async () => {
                    const deadline = now() + OPERATION_MS;
                    let operationId: string | undefined;
                    try {
                        const staged = await service.stageAccountAdministration({ ...input, actorToken } as AdminAccountRequest);
                        operationId = staged.operationId;
                        for (const message of staged.deliveries) {
                            const remaining = deadline - now();
                            if (remaining <= 0)
                                throw new AuthError(503, 'delivery_busy');
                            await deliverAccountMessage(message, AbortSignal.timeout(Math.min(DELIVERY_MS, remaining)));
                        }
                        return await service.completeAccountAdministration({ actorToken, operationId, ...(input.context ? { context: input.context } : {}) });
                    }
                    catch (error) {
                        if (operationId)
                            await service.cancelAccountAdministration({ actorToken, operationId }).catch(() => {});
                        throw error;
                    }
                });
            },
        },
        sessions: {
            async list(actor, filters) { await permitted(actor, 'auth.sessions.manage'); return service.listAllSessions(filters); },
            revoke: (actor, input) => service.adminRevokeSession({ actorToken: tokenOf(actor), ...input }),
        },
        registrations: {
            async list(actor, page) { await permitted(actor, 'auth.users.manage'); return service.listRegistrationRequests(page); },
            approve: (actor, input) => service.approveRegistration({ actorToken: tokenOf(actor), ...input }),
            async invite(actor, input) {
                const actorToken = tokenOf(actor);
                required();
                const issued = await service.invite({ actorToken, email: input.email });
                await slot(() => delivery.token('invitation', input.email, issued.token, undefined, { strict: true, signal: AbortSignal.timeout(DELIVERY_MS) })).catch(failed);
            },
        },
        cases: {
            async list(actor, page) { await permitted(actor, 'auth.cases.read'); return service.listCases(page); },
            async get(actor, caseId) { await permitted(actor, 'auth.cases.read'); return service.getCase(caseId); },
            create: (actor, input) => service.createCase({ actorToken: tokenOf(actor), ...input }),
            note: (actor, input) => service.addCaseNote({ actorToken: tokenOf(actor), ...input }),
            close: (actor, input) => service.closeCase({ actorToken: tokenOf(actor), ...input }),
            approve: (actor, input) => service.approveCase({ actorToken: tokenOf(actor), ...input }),
        },
        recovery: {
            async list(actor, page) { await permitted(actor, 'auth.cases.read'); return service.listRecoveryCases(page); },
            create: (actor, input) => service.createRecoveryCase({ actorToken: tokenOf(actor), ...input }),
            async approve(actor, input) {
                const actorToken = tokenOf(actor);
                if (!capabilities.manualRecovery)
                    throw new AuthError(503, 'delivery_unavailable');
                await slot(async () => {
                    const issued = await service.approveRecoveryCase({ actorToken, ...input });
                    try {
                        const signal = AbortSignal.timeout(DELIVERY_MS);
                        // The old address is warned first; the restoration link goes out only after that succeeds.
                        await delivery.send('manual-recovery-warning', issued.oldEmail, {}, undefined, { strict: true, signal });
                        await delivery.token('manual-recovery', issued.email, issued.token, undefined, { strict: true, signal });
                        await service.activateRecoveryCase({ actorToken, caseId: issued.case.id, token: issued.token });
                    }
                    catch (error) {
                        await service.cancelRecoveryCredential({ actorToken, caseId: issued.case.id, token: issued.token }).catch(() => {});
                        throw error;
                    }
                });
            },
        },
        async impersonate(actor, input) {
            const actorToken = tokenOf(actor), current = active();
            if (!capabilities.impersonation)
                throw new AuthError(503, 'impersonation_unavailable');
            const started = await service.createImpersonation({ actorToken, ...input });
            try {
                await slot(() => delivery.send('impersonation-started', started.user.email, { reason: input.reason, link: delivery.page('/account') }, started.user.profile?.locale, { strict: true, signal: AbortSignal.timeout(DELIVERY_MS) }));
            }
            catch (error) {
                await service.logout(started.token).catch(() => {});
                throw error;
            }
            return { headers: Object.freeze(current.sessionHeaders(started.token)), location: current.mount + '/account' };
        },
        reauthorize,
    };
}
