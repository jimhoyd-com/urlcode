// AuthExports v1: what auth shares with extensions that require it (admin, a support desk), read with
// ctx.get<AuthExports>('auth'). Consumers never hold auth's CSRF key, a session token or a cookie: they get the
// signed-in account of a request auth's own policy authorized, a CSRF token for their forms, auth's page URLs, and
// `administration`, whose every call names an opaque actor auth minted from that request's session.
import type { ExtensionRequest } from '@jimhoyd/urlcode/extensions';
import type { AuthAdministration } from './administration.ts';
import type { AuthPrincipal } from './auth-core.ts';
import { AuthError } from './auth-store.ts';
import { FRESHNESS_WINDOW_MS } from './freshness.ts';

/** Permission names auth enforces for its own operations. Roles (operator-service.mjs) grant them, or '*'. */
export type AuthPermission =
    | 'auth.users.read' | 'auth.users.manage' | 'auth.users.create' | 'auth.users.export' | 'auth.users.reveal'
    | 'auth.users.impersonate' | 'auth.sessions.manage' | 'auth.roles.read' | 'auth.cases.read' | 'auth.cases.manage' | 'auth.health.read';
export const authPermissions: readonly AuthPermission[] = Object.freeze(['auth.users.read', 'auth.users.manage', 'auth.users.create', 'auth.users.export', 'auth.users.reveal', 'auth.users.impersonate', 'auth.sessions.manage', 'auth.roles.read', 'auth.cases.read', 'auth.cases.manage', 'auth.health.read'] as const);

declare const actorBrand: unique symbol;
/** An opaque capability minted only by `AuthExports.account()`. It carries no readable data. */
export interface AuthActor { readonly [actorBrand]: true }
/** The signed-in account behind `request.principal`, resolved by auth from its own session. Frozen. */
export interface AuthAccount {
    /** === request.principal.id */
    readonly id: string;
    readonly email: string;
    readonly emailVerified: boolean;
    readonly roles: readonly string[];
    /** Effective permissions; empty while enrollment is required. */
    readonly permissions: readonly string[];
    /** Enrollment is required (verify-email, enroll-mfa). */
    readonly restricted: boolean;
    /** A support (impersonation) session. */
    readonly impersonated: boolean;
    /** Epoch ms of the last primary or step-up proof. */
    readonly authenticatedAt: number;
    /** authenticatedAt + FRESHNESS_WINDOW_MS */
    readonly freshUntil: number;
    /** Whether the proof was fresh when the account was resolved. */
    readonly fresh: boolean;
    readonly locale: string | undefined;
    /** !restricted && (permissions includes '*' or `permission`); any name, for example 'audit.read'. */
    has(permission: string): boolean;
    readonly actor: AuthActor;
}
export interface AuthCsrf {
    readonly field: 'csrf';
    readonly header: 'x-csrf-token';
    /** The session-bound token for this request. Throws AuthError 401 when account(request) is null. */
    token(request: ExtensionRequest): string;
}
export interface AuthUrls {
    /** Auth's single mount ('/account' by default). Throws before activation. */
    readonly mount: string;
    account(): string;
    /** `${mount}/login`, with `?returnTo=` when given. Throws for a returnTo that is not a local path outside auth. */
    signIn(returnTo?: string): string;
    stepUp(returnTo?: string): string;
}
export interface AuthExports {
    readonly version: 1;
    /** True between the registration's activate() and its instance close(). Every member below throws while false. */
    readonly active: boolean;
    readonly permissions: readonly AuthPermission[];
    /**
     * The session account of a request on a route an auth session policy guards; null for a route without one, no
     * session, a bearer principal or a principal from another provider. Never throws for a missing or invalid session.
     */
    account(request: ExtensionRequest): AuthAccount | null;
    readonly csrf: AuthCsrf;
    readonly urls: AuthUrls;
    readonly administration: AuthAdministration;
}

/** What authorize() learned about an allowed session request, keyed by the request object core hands every hook. */
export interface ResolvedSession { token: string; principal: AuthPrincipal; locale: string | undefined }

const actors = new WeakMap<object, { token: string; accountId: string }>();
/** The session behind an actor, or AuthError 401 invalid_actor for any object auth did not mint. */
export function actorSession(actor: AuthActor): { token: string; accountId: string } {
    const found = actor !== null && typeof actor === 'object' ? actors.get(actor) : undefined;
    if (!found)
        throw new AuthError(401, 'invalid_actor');
    return found;
}
/** A frozen account for `principal`, with a fresh actor bound to `token`. */
export function accountOf(principal: AuthPrincipal, token: string, locale: string | undefined, now = Date.now()): AuthAccount {
    const actor = Object.freeze(Object.create(null)) as AuthActor;
    actors.set(actor, { token, accountId: principal.id });
    const restricted = Boolean(principal.restrictions?.length), permissions = Object.freeze(restricted ? [] : [...principal.permissions]);
    const freshUntil = principal.authenticatedAt + FRESHNESS_WINDOW_MS;
    return Object.freeze({
        id: principal.id, email: principal.email, emailVerified: principal.emailVerified, roles: Object.freeze([...principal.roles]), permissions, restricted,
        impersonated: Boolean(principal.impersonatorId), authenticatedAt: principal.authenticatedAt, freshUntil, fresh: principal.authenticatedAt > 0 && now <= freshUntil, locale,
        has: (permission: string) => !restricted && (permissions.includes('*') || permissions.includes(permission)),
        actor,
    });
}

/** A local path to return to after sign-in: not protocol-relative, no backslash, whitespace or control character, <= 512. */
export function validReturnTo(value: unknown, mount: string): value is string {
    return typeof value === 'string' && /^\/(?![/\\])[^\s\\]{0,511}$/.test(value) && !/[\x00-\x1f\x7f]/.test(value) && value !== mount && !value.startsWith(mount + '/') && !value.startsWith(mount + '?');
}

interface ExportsSite { mount: string; token(sessionToken: string): string }
/** The exports object; `site()` returns the active activation's mount and CSRF signer, or undefined while inactive. */
export function createAuthExports(site: () => ExportsSite | undefined, resolved: WeakMap<ExtensionRequest, ResolvedSession>, administration: AuthAdministration): AuthExports {
    const active = (): ExportsSite => {
        const current = site();
        if (!current)
            throw new AuthError(503, 'auth_inactive');
        return current;
    };
    const withReturn = (path: string, returnTo: string | undefined) => {
        const { mount } = active();
        if (returnTo === undefined)
            return mount + path;
        if (!validReturnTo(returnTo, mount))
            throw new TypeError('returnTo must be a local path outside the auth mount');
        return mount + path + '?returnTo=' + encodeURIComponent(returnTo);
    };
    function account(request: ExtensionRequest): AuthAccount | null {
        active();
        const found = resolved.get(request);
        if (!found || request.principal?.provider !== 'auth' || request.principal.id !== found.principal.id)
            return null;
        return accountOf(found.principal, found.token, found.locale);
    }
    return Object.freeze({
        version: 1 as const,
        get active() { return site() !== undefined; },
        permissions: authPermissions,
        account,
        csrf: Object.freeze({
            field: 'csrf' as const, header: 'x-csrf-token' as const,
            token(request: ExtensionRequest) {
                const current = active(), found = account(request) ? resolved.get(request) : undefined;
                if (!found)
                    throw new AuthError(401, 'sign_in_required');
                return current.token(found.token);
            },
        }),
        urls: Object.freeze({
            get mount() { return active().mount; },
            account: () => active().mount + '/account',
            signIn: (returnTo?: string) => withReturn('/login', returnTo),
            stepUp: (returnTo?: string) => withReturn('/step-up', returnTo),
        }),
        get administration() { active(); return administration; },
    });
}
