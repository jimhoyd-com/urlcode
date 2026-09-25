import {createAdminAccountOperations} from './admin-account-operations.ts';
import type {AdminAccountService} from './admin-account-operations.ts';
import {isIP} from 'node:net';
import { validateUserQuery } from './user-query.ts';
import type { UserQuery } from './user-query.ts';
import {validateRecoveryEvidence} from './manual-recovery.ts';
import type {ManualRecoveryService,ManualRecoveryCase} from './manual-recovery.ts';
import { isDisposableEmailDomain, disposableDomainsRevision } from './disposable-domains.ts';
import type { FactorRecoveryService } from './factor-recovery.ts';
import { randomBytes, randomInt, randomUUID, createHash, createHmac, createCipheriv, createDecipheriv, scrypt, pbkdf2, timingSafeEqual } from 'node:crypto';
import { compare as bcryptCompare } from 'bcryptjs';
import { domainToASCII } from 'node:url';
import { TOTP, Secret } from 'otpauth';
import { createRegistrationPolicy } from './registration.ts';
import type { RegistrationPolicy, RegistrationInput, RegistrationProfile, RegistrationOptions } from './registration.ts';
import { AuthError, openAuthStore } from './auth-store.ts';
import { clientKey, principalIdPattern } from '@jimhoyd/urlcode/extensions';
import type { ExtensionHookContext } from '@jimhoyd/urlcode/extensions';
import type { AuditEvent } from '@jimhoyd/urlcode-audit';
import type { AuthRecord, SessionRecord } from './auth-store.ts';
import { FRESHNESS_WINDOW_MS } from './freshness.ts';
import { createHookRunner } from './lifecycle-hooks.ts';
import type { AuthHookStats, LoadedAuthHooks } from './lifecycle-hooks.ts';
export { AuthError };
export type { AuthHookStats };
export interface AuthUser {
    /** Latest retained device/session observation; not complete historical activity. */
    observedLastSeen?: number;
    id: string;
    email: string;
    emailVerified: boolean;
    status: 'active' | 'locked' | 'pending-delete';
    roles: string[];
    created: number;
    totpEnabled: boolean;
    passkeyMfaEnabled?: boolean;
    profile?: RegistrationProfile;
}
export type AuthRestriction = 'verify-email' | 'enroll-mfa';
export interface AuthSecondFactor {
    token: string;
    browserHash: string;
}
export interface AuthSecurityPolicy {
    allowPasskeySecondFactor?: true;
    trustedDeviceTtlMs?: number;
    allowEmailFactorRecovery?: true;
    allowManualRecovery?: true;
    requireEmailVerification: boolean;
    requireMfa: boolean;
    deletionGraceMs: number;
}
export interface AuthPrincipal {
    restrictions?: AuthRestriction[];
    id: string;
    email: string;
    emailVerified: boolean;
    roles: string[];
    permissions: string[];
    sessionId: string;
    authenticatedAt: number;
    impersonatorId?: string;
}
export interface ExternalAuthProof {
    kind: 'oidc';
    version: number;
    provider: string;
    subject: string;
}
export interface PasskeyAuthProof {
    kind: 'passkey';
    version: number;
    credentialId: string;
    publicKeyHash: string;
    expectedCounter: number;
    newCounter: number;
}
export type AuthProof = ExternalAuthProof | PasskeyAuthProof;
export interface AuthDevice {
    id: string;
    label?: string;
}
export interface AuthSessionResult {
    newDevice?: boolean;
    user: AuthUser;
    token: string;
    principal: AuthPrincipal;
    /**
     * Set only on the synthetic result `create()` returns for an email that already has an
     * account (see JSON-API.md's no-enumeration guarantee): the shape/status matches a genuine
     * registration, but `token` was never persisted server-side (no session row backs it), so it
     * authenticates nothing. Callers must skip `onSignUp` and new-device notices when this is set.
     */
    duplicate?: boolean;
}
export interface AuthSession {
    id: string;
    created: number;
    authenticatedAt: number;
    expires: number;
    lastSeen?: number;
    deviceLabel?: string;
}
export interface AuthDailyMetric {
    day: string;
    signUps: number;
    signIns: number;
    failedSignIns: number;
    methods: {
        method: string;
        signUps: number;
        signIns: number;
        failedSignIns: number;
    }[];
}
export interface AuthOptions {
    blockDisposableEmails?: boolean;
    allowPasskeySecondFactor?: boolean;
    trustedDeviceTtlMs?: number;
    /** Explicit email fallback lowers MFA assurance; disabled by default. */
    allowEmailFactorRecovery?: boolean;
    allowManualRecovery?: boolean;
    approveConfigurationChangeFrom?: string;
    configurationTag?: string;
    requireEmailVerification?: boolean;
    requireMfa?: boolean;
    deletionGraceMs?: number;
    database: string;
    encryptionKey?: Uint8Array;
    encryptionKeys?: Record<string, Uint8Array>;
    activeEncryptionKey?: string;
    roles: Record<string, string[]>;
    defaultRole?: string;
    now?: () => number;
    registrationPolicy?: RegistrationPolicy;
    sessionTtlMs?: number;
    sessionIdleMs?: number;
    allowImpersonation?: boolean;
    registrationMode?: 'open' | 'invite-only' | 'waitlist' | 'off';
    allowedEmails?: string[];
    blockedEmails?: string[];
    checkPassword?: (password: string, context?: {
        signal: AbortSignal;
    }) => Promise<void>;
    allowedEmailDomains?: string[];
    blockedEmailDomains?: string[];
}
export interface AuthCredentials {
    secondFactor?: AuthSecondFactor;
    trustedDevice?: string;
    device?: AuthDevice;
    email: string;
    password: string;
    totp?: string;
    recoveryCode?: string;
    /** Caller's network client (IP), when the deployment trusts one. Used only to scope the
     * password-guessing attempt budget per client in addition to per account; never persisted. */
    client?: string;
}
export interface AuthPasskey {
    secondFactor?: boolean;
    id: string;
    accountId: string;
    publicKey: string;
    counter: number;
    transports?: string[];
    /** The relying-party ID the credential was registered for (recorded since #736). */
    rpId?: string;
}
export interface AuthCase {
    id: string;
    accountId: string;
    action: 'reset-factors' | 'lock' | 'unlock' | 'roles' | 'restore-access';
    recovery?:ManualRecoveryCase['recovery'];
    roles?: string[];
    reason: string;
    makerId: string;
    approverId?: string;
    status: 'pending' | 'applied' | 'closed';
    notes?: {
        actorId: string;
        note: string;
        created: number;
    }[];
    created: number;
    expires: number;
    targetVersion: number;
}
export interface SignupBinding {
    flowId: string;
    browserHash: string;
}
export interface SignupState {
    flowId: string;
    accountId: string;
    email: string;
    step: 'verify-email' | 'credential' | 'profile';
    expires: number;
}
export interface SignupStart extends SignupState {
    delivery?: {
        kind: 'signup-code';
        email: string;
        code: string;
    } | {
        kind: 'registration-attempt';
        email: string;
    };
}
/** A request's hook context, carried by every service method that fires a project lifecycle hook. */
interface HookContext { context?: ExtensionHookContext }
/**
 * Everything the auth service does. Auth's extension, its administration API and its CLI use this type through
 * `internal()`; operator code gets `AuthService`, which omits the administrative operations (they run through
 * `AuthExports.administration`, which checks an actor per call).
 */
export interface AuthServiceInternal extends FactorRecoveryService,ManualRecoveryService,AdminAccountService {
    /** Attaches the project's lifecycle hooks; the latest attachment wins and its detach removes only itself. */
    attachLifecycleHooks(hooks: LoadedAuthHooks): () => void;
    /** The producer side of the audit outbox the audit extension drains (packages/audit SECURITY.md). */
    readonly auditOutbox: {
        peek(limit: number): Promise<AuditEvent[]>;
        ack(ids: readonly string[]): Promise<void>;
        onPending(listener: () => void): () => void;
        backlog(): Promise<number>;
    };
    /** Stored passkeys counted by the RP ID recorded at registration ('' for a credential with none recorded). */
    passkeyRpIds(): Promise<Record<string, number>>;
    createSecondFactorProof(input: {
        browserHash: string;
        proof: PasskeyAuthProof;
    }): Promise<string>;
    setPasskeySecondFactor(input: {
        token: string;
        credentialId: string;
        enabled: boolean;
        secondFactor?: AuthSecondFactor;
    }): Promise<void>;
    rememberDevice(input: {
        token: string;
        label?: string;
    }): Promise<{
        token: string;
        expires: number;
    }>;
    listTrustedDevices(token: string): Promise<{
        id: string;
        label: string;
        created: number;
        expires: number;
    }[]>;
    revokeTrustedDevice(input: {
        token: string;
        deviceId: string;
    }): Promise<void>;
    beginSignup(input: HookContext & {
        email: string;
        browserHash: string;
        invitationToken?: string;
    }): Promise<SignupStart>;
    getSignup(input: SignupBinding): Promise<SignupState | null>;
    verifySignup(input: SignupBinding & {
        code: string;
    }): Promise<SignupState>;
    setSignupPassword(input: SignupBinding & {
        password: string;
    }): Promise<SignupState>;
    setSignupPasskeyChallenge(input: SignupBinding & {
        challenge: string;
    }): Promise<SignupState>;
    getSignupPasskeyChallenge(input: SignupBinding): Promise<{
        state: SignupState;
        challenge: string;
    }>;
    setSignupPasskey(input: SignupBinding & {
        challenge: string;
        credential: Omit<AuthPasskey, 'accountId'>;
    }): Promise<SignupState>;
    completeSignup(input: SignupBinding & HookContext & {
        profile?: RegistrationInput;
        device?: AuthDevice;
    }): Promise<AuthSessionResult | null>;
    register(input: HookContext & {
        email: string;
        password: string;
        invitationToken?: string;
        device?: AuthDevice;
        profile?: RegistrationInput;
    }): Promise<AuthSessionResult>;
    bootstrapAdmin(input: {
        email: string;
        password: string;
    }): Promise<AuthSessionResult>;
    login(input: AuthCredentials): Promise<AuthSessionResult>;
    stepUp(input: {
        token: string;
        password: string;
        totp?: string;
        recoveryCode?: string;
        secondFactor?: AuthSecondFactor;
        client?: string;
    }): Promise<AuthSessionResult>;
    authenticate(token: string): Promise<AuthPrincipal | null>;
    logout(token: string): Promise<void>;
    revokeSessions(accountId: string): Promise<void>;
    listUsers(options?: UserQuery): Promise<{
        users: AuthUser[];
        next?: string;
    }>;
    getUser(id: string): Promise<AuthUser | null>;
    getRoles(): Record<string, string[]>;
    listSessions(accountId: string): Promise<AuthSession[]>;
    listDevices(accountId: string): Promise<{
        id: string;
        label: string;
        lastSeen: number;
    }[]>;
    issueToken(input: {
        email: string;
        purpose: 'verify-email' | 'reset-password';
    }): Promise<{
        token: string | null;
    }>;
    /**
     * Consumes an emailed verification token. On an account whose email was never
     * verified this is its first mailbox proof: unless `sessionToken` is a live
     * session of that same account (the registrant verifying in its own browser),
     * every sign-in method, factor and session established before verification is
     * removed, including the password, and the result carries `signInMethodsReset`.
     */
    consumeVerification(token: string, sessionToken?: string): Promise<AuthUser & {
        signInMethodsReset?: true;
    }>;
    resetPassword(input: {
        token: string;
        password: string;
    }): Promise<AuthUser>;
    beginTotp(token: string): Promise<{
        secret: string;
        otpauthUrl: string;
    }>;
    confirmTotp(input: {
        token: string;
        code: string;
    }): Promise<{
        recoveryCodes: string[];
    }>;
    disableTotp(input: {
        token: string;
        password: string;
        code?: string;
        secondFactor?: AuthSecondFactor;
    }): Promise<void>;
    adminSetRoles(input: HookContext & {
        actorToken: string;
        accountId: string;
        roles: string[];
        reason?: string;
    }): Promise<AuthUser>;
    adminSetStatus(input: HookContext & {
        actorToken: string;
        accountId: string;
        status: 'active' | 'locked';
        reason?: string;
    }): Promise<AuthUser>;
    adminRevokeSessions(input: {
        actorToken: string;
        accountId: string;
        reason?: string;
    }): Promise<void>;
    putFlow(input: {
        id: string;
        kind: string;
        data: unknown;
        expires: number;
    }): Promise<void>;
    consumeFlow(id: string, kind: string): Promise<unknown | null>;
    /** Read-only: does not delete the flow. Callers check the browser binding against this
     * before calling `consumeFlow`, so a request from the wrong browser cannot burn a flow the
     * right browser still needs. */
    peekFlow(id: string, kind: string): Promise<unknown | null>;
    findExternal(provider: string, subject: string): Promise<AuthUser | null>;
    linkExternal(input: {
        /** The initiating session's reference (`sessionReference(actorToken)`), not the raw
         * bearer token — see `sessionReference`'s doc comment. */
        sessionReference: string;
        provider: string;
        subject: string;
    }): Promise<void>;
    createExternalAccount(input: HookContext & {
        email: string;
        provider: string;
        subject: string;
        emailVerified: boolean;
        profile?: RegistrationInput;
    }): Promise<AuthUser>;
    getExternalProof(provider: string, subject: string): Promise<{
        user: AuthUser;
        proof: ExternalAuthProof;
    } | null>;
    issueSession(accountId: string, input: {
        trustedDevice?: string;
        method: 'passkey' | 'oidc';
        proof: AuthProof;
        device?: AuthDevice;
        totp?: string;
        recoveryCode?: string;
        secondFactor?: AuthSecondFactor;
    }): Promise<AuthSessionResult>;
    addPasskey(input: {
        actorToken: string;
        credential: Omit<AuthPasskey, 'accountId'>;
    }): Promise<void>;
    getPasskey(id: string): Promise<{
        accountId: string;
        credential: Omit<AuthPasskey, 'accountId'>;
        proof: Omit<PasskeyAuthProof, 'newCounter'>;
    } | null>;
    listPasskeys(accountId: string): Promise<Omit<AuthPasskey, 'accountId'>[]>;
    changePassword(input: {
        token: string;
        currentPassword: string;
        password: string;
        totp?: string;
        recoveryCode?: string;
        secondFactor?: AuthSecondFactor;
    }): Promise<void>;
    exportAccount(token: string): Promise<{
        user: AuthUser;
        sessions: AuthSession[];
        passkeys: {
            id: string;
            transports?: string[];
        }[];
        identities: {
            provider: string;
            subject: string;
        }[];
    }>;
    deleteAccount(input: HookContext & {
        token: string;
        password?: string;
        totp?: string;
        recoveryCode?: string;
        secondFactor?: AuthSecondFactor;
    }): Promise<{
        cancelToken: string;
        deleteAfter: number;
    }>;
    cancelDeletion(token: string): Promise<void>;
    purgeDeleted(options?: HookContext & {
        limit?: number;
    }): Promise<{
        purged: number;
    }>;
    issueEmailCode(input: {
        email: string;
        client?: string;
    }): Promise<{
        flowId: string;
        code: string | null;
    }>;
    consumeEmailCode(input: {
        trustedDevice?: string;
        flowId: string;
        code: string;
        device?: AuthDevice;
        totp?: string;
        recoveryCode?: string;
        secondFactor?: AuthSecondFactor;
    }): Promise<AuthSessionResult>;
    createCase(input: HookContext & {
        actorToken: string;
        accountId: string;
        action: Exclude<AuthCase['action'],'restore-access'>;
        roles?: string[];
        reason: string;
    }): Promise<AuthCase>;
    listCases(options?: {
        limit?: number;
        after?: string;
    }): Promise<{
        cases: AuthCase[];
        next?: string;
    }>;
    getCase(id: string): Promise<AuthCase | null>;
    approveCase(input: HookContext & {
        actorToken: string;
        caseId: string;
        reason: string;
    }): Promise<AuthCase>;
    createImpersonation(input: {
        actorToken: string;
        accountId: string;
        reason: string;
    }): Promise<AuthSessionResult>;
    adminBulk(input: HookContext & {
        actorToken: string;
        accountIds: string[];
        action: 'lock' | 'unlock' | 'revoke-sessions';
        reason: string;
    }): Promise<{
        affected: number;
    }>;
    dashboard(): Promise<{
        users: number;
        active: number;
        locked: number;
        pendingDeletion: number;
        sessions: number;
        waitlist: number;
        daily: AuthDailyMetric[];
    }>;
    listAllSessions(options?: {
        accountId?: string;
        device?: string;
        createdFrom?: number;
        createdTo?: number;
        limit?: number;
        after?: string;
    }): Promise<{
        sessions: (AuthSession & {
            accountId: string;
            email: string;
        })[];
        next?: string;
    }>;
    importUsers(users: {
        email: string;
        passwordHash: string;
        emailVerified?: boolean;
    }[], options?: HookContext): Promise<{
        imported: number;
    }>;
    getProfile(token: string): Promise<RegistrationProfile>;
    updateProfile(input: {
        token: string;
        profile: RegistrationInput;
    }): Promise<RegistrationProfile>;
    getConfigurationRevision(): Promise<string>;
    getSecurityPolicy(): AuthSecurityPolicy;
    getHookStats(): AuthHookStats;
    getRegistrationSchema(): RegistrationOptions;
    getRegistrationMode(): 'open' | 'invite-only' | 'waitlist' | 'off';
    /** Whether the operator allowed support impersonation (`allowImpersonation`). */
    getImpersonationEnabled(): boolean;
    requestRegistration(input: HookContext & {
        email: string;
        password: string;
        profile?: RegistrationInput;
    }): Promise<{
        id: string;
        /** True when the address already had a waitlist request or account (not exposed to callers; JSON-API.md's no-enumeration guarantee keeps the HTTP response identical either way). */
        duplicate?: boolean;
    }>;
    listRegistrationRequests(options?: {
        limit?: number;
        after?: string;
    }): Promise<{
        requests: {
            id: string;
            email: string;
            created: number;
        }[];
        next?: string;
    }>;
    approveRegistration(input: HookContext & {
        actorToken: string;
        requestId: string;
        reason?: string;
    }): Promise<AuthUser>;
    invite(input: {
        actorToken: string;
        email: string;
    }): Promise<{
        token: string;
    }>;
    completeStepUp(input: {
        token: string;
        accountId: string;
        method: 'passkey';
        proof: PasskeyAuthProof;
        totp?: string;
        recoveryCode?: string;
        secondFactor?: AuthSecondFactor;
    }): Promise<AuthSessionResult>;
    removePasskey(input: {
        token: string;
        credentialId: string;
    }): Promise<void>;
    unlinkExternal(input: {
        token: string;
        provider: string;
        subject: string;
    }): Promise<void>;
    closeCase(input: {
        actorToken: string;
        caseId: string;
        reason: string;
    }): Promise<AuthCase>;
    addCaseNote(input: {
        actorToken: string;
        caseId: string;
        note: string;
    }): Promise<AuthCase>;
    cleanup(options?: {
        limit?: number;
    }): Promise<{
        removed: number;
    }>;
    requestEmailChange(input: {
        token: string;
        email: string;
        password?: string;
        totp?: string;
        recoveryCode?: string;
        secondFactor?: AuthSecondFactor;
    }): Promise<{
        oldEmail: string;
        newEmail: string;
        verificationToken: string;
        cancelToken: string;
        activateAfter: number;
    }>;
    confirmEmailChange(token: string): Promise<AuthUser>;
    cancelEmailChange(token: string): Promise<void>;
    adminCreateUser(input: HookContext & {
        actorToken: string;
        email: string;
        reason: string;
    }): Promise<{
        user: AuthUser;
        setupToken: string;
    }>;
    revokeSession(input: {
        token: string;
        sessionId: string;
    }): Promise<void>;
    adminRevokeSession(input: {
        actorToken: string;
        sessionId: string;
        reason: string;
    }): Promise<void>;
    adminAddNote(input: { actorToken: string; accountId: string; reason: string }): Promise<void>;
    adminReveal(input: { actorToken: string; accountId: string; reason: string }): Promise<{ id: string; email: string }>;
    adminExport(input: {
        actorToken: string;
        accountId: string;
        reason: string;
    }): Promise<{
        user: AuthUser;
        sessions: AuthSession[];
        identities: {
            provider: string;
            subject: string;
        }[];
    }>;
    rotateEncryptionKey(): Promise<{
        changed: number;
        remaining: number;
    }>;
    /**
     * Issues a bearer/API-key credential (packages/auth/README.md's "Bearer/API-key authentication"). `key` is
     * returned once, at issuance, and is never recoverable afterward: only its scrypt hash
     * is stored (auth-core.ts's existing password-hashing derivation). Operator-only; not
     * reachable from any route the project declares (issue outside route YAML, e.g. the
     * `urlcode-auth` CLI or an operator script against the same `AuthService`).
     * `quota` (urlcode#703) gives this key its own budget, `requests` per `window`
     * seconds with the same bounds as a route's `auth.bearer.quota`: on every bearer
     * route the key authenticates on, it is counted against this budget only, in
     * place of the route's. Fixed at issuance; `null` when omitted.
     */
    issueApiKey(input: {
        name: string;
        scopes: string[];
        expiresInMs?: number;
        quota?: { requests: number; window: number };
        /**
         * The user the key acts for (urlcode#732): an existing, active account's id, or refused with
         * `invalid_api_key_user`. The key's request principal is then that user id, so records it creates in an
         * owned store collection belong to the user and survive rotating the key; it still acts only within its own
         * `scopes`, never the user's roles. Locking the user or deleting the account disables the key. Omitted, the
         * key is a service key whose principal is `apikey:<key id>`.
         */
        userId?: string;
    }): Promise<{
        id: string;
        key: string;
        name: string;
        scopes: string[];
        expires: number | null;
        quota: { requests: number; window: number } | null;
        userId: string | null;
    }>;
    /** `userDisabled` is true for a user-linked key whose user is locked, pending deletion or purged: it fails authentication. */
    listApiKeys(): Promise<{
        id: string;
        name: string;
        scopes: string[];
        created: number;
        expires: number | null;
        revoked: boolean;
        lastUsed: number | null;
        quota: { requests: number; window: number } | null;
        userId: string | null;
        userDisabled: boolean;
    }[]>;
    revokeApiKey(id: string): Promise<void>;
    /**
     * Verifies a raw bearer/API-key credential (the `Authorization: Bearer <key>` value).
     * Never throws for a missing, malformed, unknown, expired or revoked key — it returns
     * `null`, which the auth extension's `authorize()` turns into a 401; a valid key whose
     * scopes do not cover the route's `auth: {bearer: {scopes}}` requirement is a 403 the
     * extension computes from the returned `scopes`, not from this method. `quota` is
     * the key's own budget (urlcode#703), or `null` when it was issued without one.
     * `userId` is the user the key acts for (urlcode#732), or `null` for a service key; a
     * user-linked key whose user is not active returns `null` like a revoked key.
     */
    authenticateApiKey(key: string): Promise<{
        id: string;
        name: string;
        scopes: string[];
        quota: { requests: number; window: number } | null;
        userId: string | null;
    } | null>;
    /**
     * Counts one request against a bearer/API-key credential's quota (a route's
     * `auth: {bearer: {quota: {requests, window}}}`, urlcode#572, or the key's own
     * quota from `issueApiKey`, which the extension passes instead, urlcode#703). `id` is the
     * key's public id from `authenticateApiKey`, never its secret. Fixed window,
     * like the sign-in attempt counter: the window opens at the credential's
     * first counted request and `requests` are allowed until it closes. A
     * refused request is not counted. Routes that restate the same
     * `requests`/`window` share one counter per credential; a different budget
     * gets its own. Counted in the auth SQLite store, so the count survives a
     * restart and is shared by every process on the host opening the same
     * database file (not across hosts). Throws `AuthError` 503 when the store is
     * unavailable or its counter table is at capacity — never allows by default.
     */
    consumeApiKeyQuota(id: string, quota: {
        requests: number;
        window: number;
    }): Promise<{
        allowed: boolean;
        remaining: number;
        reset: number;
    }>;
    close(): Promise<void>;
}
/** Operations only `AuthExports.administration` (and auth's CLI) reach; operator code does not see them. */
type AdminOnly = 'adminSetRoles' | 'adminSetStatus' | 'adminRevokeSessions' | 'adminRevokeSession' | 'adminBulk' | 'adminAddNote' | 'adminReveal' | 'adminExport' | 'adminCreateUser' | 'invite' | 'approveRegistration' | 'listRegistrationRequests' | 'createImpersonation' | 'createCase' | 'listCases' | 'getCase' | 'approveCase' | 'closeCase' | 'addCaseNote' | 'createRecoveryCase' | 'listRecoveryCases' | 'approveRecoveryCase' | 'activateRecoveryCase' | 'cancelRecoveryCredential' | 'inspectAccountAuthentication' | 'stageAccountAdministration' | 'completeAccountAdministration' | 'cancelAccountAdministration' | 'dashboard' | 'listAllSessions';
/** The auth service operator code (operator-service.mjs, scripts) holds. */
export type AuthService = Omit<AuthServiceInternal, AdminOnly | 'attachLifecycleHooks' | 'auditOutbox' | 'passkeyRpIds'>;
/** The full service behind an `AuthService` that `createAuthService` made. Throws for any other object. */
export function internal(service: AuthService): AuthServiceInternal {
    const full = service as Partial<AuthServiceInternal>;
    if (!full || typeof full.attachLifecycleHooks !== 'function' || typeof full.adminSetRoles !== 'function' || typeof full.auditOutbox?.peek !== 'function')
        throw new TypeError('Expected the service createAuthService returns');
    return full as AuthServiceInternal;
}
const fail = (status: number, code: string): never => { throw new AuthError(status, code); };
/** Same bounds as the `bearer.quota` policy schema (auth.ts `apiKeyQuotaSchema`): 1..1,000,000 requests per 1..2,592,000 seconds (30 days). Also bounds a key's own `quota` at issuance (urlcode#703). */
function validApiKeyQuota(quota: unknown): quota is { requests: number; window: number } {
    if (!quota || typeof quota !== 'object')
        return false;
    const { requests, window } = quota as Record<string, unknown>;
    return Number.isSafeInteger(requests) && Number(requests) >= 1 && Number(requests) <= 1000000 && Number.isSafeInteger(window) && Number(window) >= 1 && Number(window) <= 2592000;
}
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
/**
 * The opaque, irreversible reference a session token hashes to (the same value
 * `auth_sessions.hash` stores). A caller that needs to carry "which session initiated this"
 * across a boundary that cannot safely hold the raw bearer token (for example, a provider-flow
 * record that survives a cross-site redirect) stores this reference instead of the raw token —
 * see the OIDC link flow in auth-flows.ts and packages/auth/SECURITY.md's "stored only as
 * hashes" claim. The reference alone cannot authenticate a request (every endpoint that accepts
 * a bearer token re-derives its hash from the raw token itself; none accept a hash directly),
 * so on its own it cannot be replayed as a session outside `linkExternal`'s narrow use.
 */
export function sessionReference(token: string): string {
    return digest(token);
}
const token = () => randomBytes(32).toString('base64url');
const validToken = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);
/** A lowercase DNS name: the relying-party ID a passkey was registered for. */
const validRpId = (value: unknown): value is string => typeof value === 'string' && value.length <= 253 && /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/.test(value);
const id = (value: string) => {
    if (typeof value !== 'string' || value.length > 256 || !value || /[\x00-\x20\x7f]/.test(value))
        fail(400, 'invalid_identifier');
    return value;
};
export function normalizeEmail(value: string): string {
    if (typeof value !== 'string' || value.length > 254)
        fail(400, 'invalid_email');
    const parts = value.normalize('NFKC').trim().split('@');
    if (parts.length !== 2)
        fail(400, 'invalid_email');
    const local = parts[0]!.toLowerCase(), domain = domainToASCII(parts[1]!).toLowerCase();
    if (!local || local.length > 64 || /[\s\x00-\x1f\x7f"(),:;<>[\]\\]/.test(local) || !domain || domain.length > 253 || domain.split('.').some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) || local.length + domain.length + 1 > 254)
        fail(400, 'invalid_email');
    return local + '@' + domain;
}
function password(value: string): void {
    if (typeof value !== 'string' || value.length > 1024 || [...value].length < 15 || [...value].length > 256 || Buffer.byteLength(value) > 1024)
        fail(400, 'password_length_invalid');
}
let hashing = 0;
let passwordChecks = 0;
// Password derivation is deliberately expensive (scrypt) and bounded to two concurrent
// derivations process-wide so a burst of hashing cannot exhaust CPU. Rather than refusing the
// instant both slots are busy, a caller that cannot get a slot immediately waits briefly in a
// bounded queue (bounded both in length and in wait time) before refusing with the same
// `password_hash_busy` — see "Password hashing concurrency" in SECURITY.md.
const HASH_SLOTS = 2, HASH_QUEUE_MAX = 16, HASH_WAIT_MS_DEFAULT = 2000, HASH_WAIT_MS_CAP = 30000;
/**
 * Per-waiter budget for the bounded password-hash queue. Defaults to 2000ms;
 * URLCODE_AUTH_HASH_WAIT_MS may raise it (up to 30000ms) for shared/slow CI
 * runners, mirroring storeStartupBudgetMs's precedent for the auth-store
 * worker startup budget (#339/#424). Values that are not integers at or above
 * the default are ignored, so it can never tighten the production bound. A
 * tail waiter can sit behind up to HASH_QUEUE_MAX-1 other waiters and needs a
 * full scrypt derivation to finish before each slot ahead of it frees, so the
 * budget must cover several derivations' worth of wall-clock time, not just
 * one, on the slowest runner this is measured against.
 */
export function hashWaitBudgetMs(env: Record<string, string | undefined> = process.env): number {
    const raw = env.URLCODE_AUTH_HASH_WAIT_MS;
    if (raw === undefined || !/^\d{1,6}$/.test(raw)) return HASH_WAIT_MS_DEFAULT;
    return Math.min(HASH_WAIT_MS_CAP, Math.max(HASH_WAIT_MS_DEFAULT, Number(raw)));
}
const hashWaiters: (() => void)[] = [];
async function acquireHashSlot(): Promise<void> {
    if (hashing < HASH_SLOTS) {
        hashing++;
        return;
    }
    if (hashWaiters.length >= HASH_QUEUE_MAX)
        fail(503, 'password_hash_busy');
    await new Promise<void>((resolve, reject) => {
        const wake = () => { clearTimeout(timer); hashing++; resolve(); };
        const timer = setTimeout(() => {
            const index = hashWaiters.indexOf(wake);
            if (index !== -1)
                hashWaiters.splice(index, 1);
            reject(new AuthError(503, 'password_hash_busy'));
        }, hashWaitBudgetMs());
        hashWaiters.push(wake);
    });
}
function releaseHashSlot(): void {
    hashing--;
    const next = hashWaiters.shift();
    if (next)
        next();
}
async function derive(value: string, salt: Buffer): Promise<Buffer> {
    await acquireHashSlot();
    try {
        return await new Promise<Buffer>((resolve, reject) => scrypt(value, salt, 32, { N: 131072, r: 8, p: 1, maxmem: 160 * 1024 * 1024 }, (error, key) => error ? reject(new AuthError(503, 'password_hash_unavailable')) : resolve(key)));
    }
    finally {
        releaseHashSlot();
    }
}
async function hashPassword(value: string, validate = true): Promise<string> {
    if (validate)
        password(value);
    const salt = randomBytes(16), key = await derive(value, salt);
    return `scrypt-v1$${salt.toString('base64url')}$${key.toString('base64url')}`;
}
function validPasswordHash(encoded: string): boolean {
    if (typeof encoded !== 'string' || encoded.length > 512)
        return false;
    if (/^scrypt-v1\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{43}$/.test(encoded))
        return true;
    const bcrypt = /^\$2[aby]\$(\d{2})\$[./A-Za-z0-9]{53}$/.exec(encoded);
    if (bcrypt)
        return Number(bcrypt[1]) >= 10 && Number(bcrypt[1]) <= 14;
    const pb = /^pbkdf2-sha256\$(\d{6,7})\$([A-Za-z0-9_-]{22,86})\$([A-Za-z0-9_-]{43})$/.exec(encoded);
    return Boolean(pb) && Number(pb![1]) >= 600000 && Number(pb![1]) <= 1000000;
}
async function verifyPassword(value: string, encoded: string | undefined): Promise<boolean> {
    if (typeof value !== 'string' || Buffer.byteLength(value) > 1024)
        fail(401, 'invalid_credentials');
    if (encoded && validPasswordHash(encoded) && !encoded.startsWith('scrypt-v1$')) {
        await acquireHashSlot();
        try {
            if (encoded.startsWith('$2')) {
                if (Buffer.byteLength(value) > 72)
                    return false;
                return await bcryptCompare(value, encoded);
            }
            const parts = encoded.split('$'), derived = await new Promise<Buffer>((resolve, reject) => pbkdf2(value, Buffer.from(parts[2]!, 'base64url'), Number(parts[1]), 32, 'sha256', (error, key) => error ? reject(new AuthError(503, 'password_hash_unavailable')) : resolve(key)));
            return timingSafeEqual(derived, Buffer.from(parts[3]!, 'base64url'));
        }
        finally {
            releaseHashSlot();
        }
    }
    const parts = encoded?.split('$'), valid = encoded && validPasswordHash(encoded) && parts?.[0] === 'scrypt-v1';
    const key = await derive(value, valid ? Buffer.from(parts![1]!, 'base64url') : Buffer.alloc(16));
    return Boolean(valid) && timingSafeEqual(key, Buffer.from(parts![2]!, 'base64url'));
}
const basePublicUser = (user: AuthRecord): AuthUser => ({ id: user.id, email: user.email, emailVerified: user.emailVerified, status: user.status, roles: [...user.roles], created: user.created, totpEnabled: Boolean(user.totpSecret) });
export async function createAuthService(options: AuthOptions): Promise<AuthService> {
    return createService(options);
}
async function createService(options: AuthOptions): Promise<AuthServiceInternal> {
    if (options.approveConfigurationChangeFrom !== undefined && (typeof options.approveConfigurationChangeFrom !== 'string' || !/^[a-f0-9]{64}$/.test(options.approveConfigurationChangeFrom)))
        fail(400, 'invalid_configuration_approval');
    if (options.configurationTag !== undefined && (typeof options.configurationTag !== 'string' || options.configurationTag.length < 1 || options.configurationTag.length > 128 || /[\x00-\x1f\x7f]/.test(options.configurationTag)))
        fail(400, 'invalid_configuration_tag');
    for (const value of [options.requireEmailVerification, options.requireMfa, options.blockDisposableEmails])
        if (value !== undefined && typeof value !== 'boolean')
            fail(400, 'invalid_security_policy');
    const deletionGraceMs = options.deletionGraceMs ?? 604800000;
    if (!Number.isSafeInteger(deletionGraceMs) || deletionGraceMs < 86400000 || deletionGraceMs > 2592000000)
        fail(400, 'invalid_deletion_grace');
    if(options.allowManualRecovery!==undefined&&typeof options.allowManualRecovery!=='boolean')fail(400,'invalid_manual_recovery_policy');
    if (options.allowEmailFactorRecovery !== undefined && typeof options.allowEmailFactorRecovery !== 'boolean')
        fail(400, 'invalid_factor_recovery_policy');
    if (options.allowPasskeySecondFactor !== undefined && typeof options.allowPasskeySecondFactor !== 'boolean')
        fail(400, 'invalid_security_policy');
    const trustedDeviceTtlMs = options.trustedDeviceTtlMs ?? 0;
    if (!Number.isSafeInteger(trustedDeviceTtlMs) || trustedDeviceTtlMs < 0 || trustedDeviceTtlMs > 2592000000 || trustedDeviceTtlMs > 0 && trustedDeviceTtlMs < 60000)
        fail(400, 'invalid_trusted_device_policy');
    const securityPolicy: AuthSecurityPolicy = Object.freeze({ ...(options.allowManualRecovery===true?{allowManualRecovery:true as const}:{}), ...(options.allowPasskeySecondFactor ? { allowPasskeySecondFactor: true as const } : {}), ...(trustedDeviceTtlMs ? { trustedDeviceTtlMs } : {}), ...(options.allowEmailFactorRecovery === true ? { allowEmailFactorRecovery: true as const } : {}), requireEmailVerification: options.requireEmailVerification === true, requireMfa: options.requireMfa === true, deletionGraceMs });
    const supplied = options.encryptionKeys ?? (options.encryptionKey ? { legacy: options.encryptionKey } : {}), activeKey = options.activeEncryptionKey ?? 'legacy';
    const keys: Record<string, Buffer> = Object.create(null);
    if (Object.keys(supplied).length < 1 || Object.keys(supplied).length > 8)
        fail(400, 'auth_encryption_key_required');
    for (const [name, value] of Object.entries(supplied)) {
        if (!/^[a-zA-Z0-9_-]{1,32}$/.test(name) || !(value instanceof Uint8Array) || value.byteLength !== 32)
            fail(400, 'auth_encryption_key_required');
        keys[name] = Buffer.from(value);
    }
    if (!keys[activeKey])
        fail(400, 'auth_encryption_key_required');
    if (!options.roles || typeof options.roles !== 'object' || Array.isArray(options.roles) || Object.keys(options.roles).length > 64)
        fail(400, 'invalid_roles');
    const roles: Record<string, string[]> = Object.create(null);
    for (const [name, list] of Object.entries(options.roles)) {
        if (!/^[a-z][a-z0-9_-]{0,63}$/.test(name) || !Array.isArray(list) || list.length > 128 || list.some(p => typeof p !== 'string' || !/^\*$|^[a-z][a-z0-9_.:-]{0,127}$/.test(p)))
            fail(400, 'invalid_roles');
        roles[name] = [...new Set(list)];
    }
    const defaultRole = options.defaultRole ?? 'user';
    if (!Object.hasOwn(roles, defaultRole) || roles[defaultRole]!.some(p => p === '*' || p.startsWith('auth.')))
        fail(400, 'unsafe_default_role');
    // A support session keeps only these: the permissions every plain member holds.
    const memberPermissions: ReadonlySet<string> = new Set(roles[defaultRole]);
    const mode = options.registrationMode ?? 'open';
    if (!['open', 'invite-only', 'waitlist', 'off'].includes(mode))
        fail(400, 'invalid_registration_mode');
    const domains = (values: string[] | undefined) => {
        if (values !== undefined && (!Array.isArray(values) || values.length > 100))
            fail(400, 'invalid_email_domains');
        return (values ?? []).map(value => normalizeEmail('test@' + value).split('@')[1]!);
    };
    const emailList = (values: string[] | undefined) => {
        if (values !== undefined && (!Array.isArray(values) || values.length > 1000))
            fail(400, 'invalid_email_list');
        return (values ?? []).map(normalizeEmail);
    };
    const allowedEmails = emailList(options.allowedEmails), blockedEmails = emailList(options.blockedEmails);
    const allowed = domains(options.allowedEmailDomains), blocked = domains(options.blockedEmailDomains);
    const permittedEmail = (value: string) => {
        const email = normalizeEmail(value), domain = email.split('@')[1]!;
        if (options.blockDisposableEmails && isDisposableEmailDomain(domain) || blockedEmails.includes(email) || (allowedEmails.length && !allowedEmails.includes(email)) || blocked.includes(domain) || (allowed.length && !allowed.includes(domain)))
            fail(403, 'registration_unavailable');
        return email;
    };
    const ttl = options.sessionTtlMs ?? 86400000;
    if (!Number.isSafeInteger(ttl) || ttl < 60000 || ttl > 2592000000)
        fail(400, 'invalid_session_ttl');
    const idle = options.sessionIdleMs ?? Math.min(ttl, 1800000);
    if (!Number.isSafeInteger(idle) || idle < 60000 || idle > ttl)
        fail(400, 'invalid_session_idle');
    const key = keys[activeKey]!, now = () => {
        const value = (options.now ?? Date.now)();
        if (!Number.isSafeInteger(value) || value < 0)
            fail(503, 'invalid_clock');
        return value;
    };
    const store = await openAuthStore({ database: options.database, ...(options.approveConfigurationChangeFrom ? { approveConfigurationChangeFrom: options.approveConfigurationChangeFrom } : {}), configurationChangeAt: now(), ...(options.configurationTag !== undefined ? { configurationTag: options.configurationTag } : {}), roles, defaultRole, sessionTtlMs: ttl, sessionIdleMs: idle, securityPolicy, registration: { ...(options.blockDisposableEmails ? { disposableDomainsRevision } : {}), mode, allowed, blocked, allowedEmails, blockedEmails, allowImpersonation: options.allowImpersonation === true }, activeKey, keyFingerprints: Object.fromEntries(Object.entries(keys).map(([name, value]) => [name, createHmac('sha256', value).update('urlcode-auth-store-v1').digest('hex')])) });
    let closed = false;
    const hooks = createHookRunner();
    /** The account behind an administrator's session, for hook inputs; the store re-checks it in the transaction. */
    const actorOf = async (actorToken: string): Promise<AuthRecord> => {
        const found = validToken(actorToken) ? await store.call<{ user: AuthRecord } | null>('authenticate', { hash: digest(actorToken), now: now() }) : null;
        if (!found)
            return fail(401, 'fresh_authentication_required');
        return found.user;
    };
    /** Runs beforeRoleChange for one account when it is attached: the account's current roles against `requested`. */
    const roleChange = async (actorToken: string, accountId: string, requested: string[], why: string, context?: ExtensionHookContext) => {
        if (!hooks.has('beforeRoleChange'))
            return;
        const actor = await actorOf(actorToken), target = await store.call<AuthRecord | null>('account', { id: id(accountId) });
        if (!target)
            fail(404, 'account_not_found');
        await hooks.beforeRoleChange({ accountId: target!.id, currentRoles: [...target!.roles], requestedRoles: [...requested], actorId: actor.id, reason: why }, context);
    };
    const check = () => {
        if (closed)
            fail(503, 'auth_service_closed');
    };
    const profilePolicy = options.registrationPolicy ?? createRegistrationPolicy();
    const validateProfile = (input: RegistrationInput, existing?: RegistrationProfile) => {
        try {
            return profilePolicy.validate(input, { now: now(), ...(existing ? { existing } : {}) });
        }
        catch {
            return fail(400, 'invalid_registration_profile');
        }
    };
    const publicUser = (user: AuthRecord): AuthUser => ({ ...basePublicUser(user), ...(securityPolicy.allowPasskeySecondFactor && user.mfaPasskeys?.length ? { passkeyMfaEnabled: true } : {}), ...(user.profile ? { profile: profilePolicy.publicProfile(user.profile) } : {}) });
    const newPassword = async (value: string) => {
        password(value);
        if (options.checkPassword) {
            if (passwordChecks >= 4)
                fail(503, 'password_check_busy');
            passwordChecks++;
            const controller = new AbortController();
            let timer: NodeJS.Timeout | undefined;
            const pending = Promise.resolve().then(() => options.checkPassword!(value, { signal: controller.signal }));
            void pending.finally(() => { passwordChecks--; }).catch(() => { });
            try {
                await Promise.race([pending, new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new AuthError(503, 'password_check_unavailable')); }, 5000); })]);
            }
            catch (error) {
                if (error instanceof AuthError && error.code === 'password_check_unavailable')
                    throw error;
                fail(400, 'password_not_allowed');
            }
            finally {
                if (timer)
                    clearTimeout(timer);
            }
        }
        return hashPassword(value);
    };
    const perms = (names: string[]) => [...new Set(names.flatMap(name => roles[name] || []))];
    const restrictions = (user: AuthRecord): AuthRestriction[] => [...(securityPolicy.requireEmailVerification && !user.emailVerified ? ['verify-email' as const] : []), ...((user.mfaRecoveryRequired || securityPolicy.requireMfa && !user.totpSecret && !(securityPolicy.allowPasskeySecondFactor && user.mfaPasskeys?.length)) ? ['enroll-mfa' as const] : [])];
    const principal = (user: AuthRecord, session: SessionRecord): AuthPrincipal => { const pending = restrictions(user); return { id: user.id, email: user.email, emailVerified: user.emailVerified, roles: pending.length ? [] : [...user.roles], permissions: pending.length ? [] : session.impersonatorId ? perms(user.roles).filter(p => memberPermissions.has(p)) : perms(user.roles), ...(pending.length ? { restrictions: pending } : {}), ...(session.impersonatorId ? { impersonatorId: session.impersonatorId } : {}), sessionId: session.id, authenticatedAt: session.authenticatedAt }; };
    const sessionFor = (accountId: string, device?: AuthDevice): {
        raw: string;
        value: SessionRecord;
    } => {
        if (device && (!validToken(device.id) || device.label !== undefined && (typeof device.label !== 'string' || device.label.length > 160 || /[\x00-\x1f\x7f]/.test(device.label))))
            fail(400, 'invalid_device');
        const raw = token(), created = now();
        return { raw, value: { id: randomUUID(), hash: digest(raw), accountId, created, authenticatedAt: created, primaryMethod: 'password', expires: created + ttl, ...(device ? { deviceHash: digest(device.id), deviceLabel: device.label ?? 'Browser' } : {}) } };
    };
    const seal = (value: string, context: string) => { const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, nonce); cipher.setAAD(Buffer.from(context)); const bytes = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]); return activeKey + '.' + Buffer.concat([nonce, cipher.getAuthTag(), bytes]).toString('base64url'); };
    const unseal = (value: string, context: string) => {
        try {
            const parts = value.split('.'), keyId = parts.length === 2 ? parts[0]! : 'legacy', secretKey = keys[keyId];
            if (!secretKey)
                throw new Error();
            const bytes = Buffer.from(parts.at(-1)!, 'base64url');
            if (bytes.length < 29)
                throw new Error();
            const cipher = createDecipheriv('aes-256-gcm', secretKey, bytes.subarray(0, 12));
            cipher.setAuthTag(bytes.subarray(12, 28));
            cipher.setAAD(Buffer.from(context));
            return Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString('utf8');
        }
        catch {
            return fail(503, 'auth_secret_unavailable');
        }
    };
    const lookupSession = async (raw: string, fresh = false, enrollment = false) => {
        check();
        if (!validToken(raw))
            return fail(401, 'invalid_credentials');
        const value = await store.call<{
            user: AuthRecord;
            session: SessionRecord;
        } | null>('authenticate', { hash: digest(raw), now: now() });
        if (!value)
            return fail(401, 'invalid_credentials');
        if (value.session.impersonatorId && fresh)
            fail(403, 'impersonation_restricted');
        if (fresh && now() - value.session.authenticatedAt > FRESHNESS_WINDOW_MS)
            fail(401, 'fresh_authentication_required');
        if (enrollment && value.user.mfaRecoveryRequired && !value.session.recoveryEnrollment)
            fail(403, 'recovery_enrollment_proof_required');
        if (fresh) {
            const pending = restrictions(value.user);
            if (pending.length && (!enrollment || pending.includes('verify-email')))
                fail(403, 'enrollment_required');
        }
        return value;
    };
    const attempt = async (value: string, limit = 10, windowMs = 900000) => { const attemptKey = createHash('sha256').update('urlcode-auth-attempt:' + value).digest('hex'); await store.call('attempt', { key: attemptKey, limit, windowMs, now: now() }); return attemptKey; };
    /**
     * Guessable-secret sign-in/token attempts (password, reset/email-code tokens) get two
     * independent budgets instead of one shared, client-blind counter: a tight one scoped to the
     * caller's network client, so one client's failures cannot exhaust the budget for every other
     * client trying the same account; and a much higher one scoped to the account alone, so a
     * distributed attacker (many clients, one target account) is still bounded. Both keys are
     * returned so the caller can clear them together on success. The client scope is the
     * address's clientKey, so an IPv6 /64 is one client (#547).
     */
    const guessableAttempt = async (scope: string, subject: string, client?: string): Promise<string[]> => {
        const trustedClient = typeof client === 'string' && isIP(client) ? clientKey(client) : undefined;
        return trustedClient
            ? [await attempt(scope + ':' + subject, 30, 900000), await attempt(scope + ':' + subject + ':client:' + trustedClient, 10, 900000)]
            : [await attempt(scope + ':' + subject, 10, 900000)];
    };
    const counter = (secret: string, code: string, accountId: string) => {
        if (typeof code !== 'string' || !/^\d{6}$/.test(code))
            return fail(401, 'invalid_credentials');
        const totp = new TOTP({ secret: unseal(secret, 'totp:' + accountId), algorithm: 'SHA1', digits: 6, period: 30 });
        const timestamp = now(), delta = totp.validate({ token: code, window: 1, timestamp });
        if (delta === null)
            return fail(401, 'invalid_credentials');
        return Math.floor(timestamp / 30000) + delta;
    };
    const factor = (user: AuthRecord, input: {
        totp?: string;
        recoveryCode?: string;
        secondFactor?: AuthSecondFactor;
        trustedDevice?: string;
    }, allowTrusted = false): Record<string, unknown> => {
        if (input.secondFactor) {
            if (!securityPolicy.allowPasskeySecondFactor || !validToken(input.secondFactor.token) || !/^[a-f0-9]{64}$/.test(input.secondFactor.browserHash))
                fail(401, 'invalid_second_factor');
            return { secondFactorHash: digest(input.secondFactor.token), secondFactorBrowser: input.secondFactor.browserHash };
        }
        if (allowTrusted && input.trustedDevice && !input.totp && !input.recoveryCode && (user.totpSecret || securityPolicy.allowPasskeySecondFactor && user.mfaPasskeys?.length)) {
            if (!trustedDeviceTtlMs || !validToken(input.trustedDevice))
                fail(401, 'invalid_trusted_device');
            return { trustedDeviceHash: digest(input.trustedDevice) };
        }
        if (!user.totpSecret) {
            if (securityPolicy.allowPasskeySecondFactor && user.mfaPasskeys?.length)
                fail(401, 'second_factor_required');
            return {};
        }
        if (input.recoveryCode) {
            if (!/^[A-Za-z0-9_-]{22}$/.test(input.recoveryCode))
                fail(401, 'invalid_credentials');
            return { recoveryHash: digest(input.recoveryCode) };
        }
        return { counter: counter(user.totpSecret, input.totp ?? '', user.id) };
    };
    const create = async (input: HookContext & {
        email: string;
        password: string;
        invitationToken?: string;
        device?: AuthDevice;
        profile?: RegistrationInput;
    }, bootstrap = false) => {
        check();
        if (!bootstrap && (mode === 'off' || mode === 'waitlist' || mode === 'invite-only' && !validToken(input.invitationToken)))
            fail(403, 'registration_unavailable');
        const email = permittedEmail(input.email), method = bootstrap ? 'bootstrap' as const : input.invitationToken ? 'invitation' as const : 'password' as const;
        if (method !== 'bootstrap')
            await hooks.beforeRegister({ email, method, ...(input.profile ? { profile: input.profile as unknown as Record<string, unknown> } : {}) }, input.context);
        const passwordHash = await newPassword(input.password), created = now(), accountId = randomUUID();
        let assigned = [defaultRole];
        if (bootstrap) {
            const admin = Object.keys(roles).find(name => roles[name]!.includes('*'));
            if (!admin)
                fail(400, 'administrator_role_required');
            assigned = [admin!];
        }
        const user: AuthRecord = { id: accountId, email, emailVerified: false, status: 'active', roles: assigned, created, passwordHash, version: 1, totpCounter: -1, ...(!bootstrap && (options.registrationPolicy || input.profile) ? { profile: validateProfile(input.profile ?? {}) } : {}) }, session = sessionFor(accountId, input.device);
        const stored = await store.call<AuthRecord | null>('create', { user, session: session.value, bootstrap, ...(!bootstrap && mode === 'invite-only' ? { invitationHash: digest(input.invitationToken!) } : {}), now: now() });
        if (!stored) {
            // Existing account (bootstrap can never collide: it requires an empty accounts
            // table). Mirror a genuine registration's shape/status without creating a session:
            // `session.value` was never passed to `addSession`, so `session.raw` authenticates
            // nothing even though it is well-formed. See AuthSessionResult.duplicate. The HTTP
            // layer (auth.ts) must not turn `token` into a session cookie for this result: a
            // cookie that looks valid but isn't backed by a persisted session is exactly what
            // `duplicate` exists to prevent (#548).
            return { user: publicUser(user), token: session.raw, principal: principal(user, session.value), duplicate: true };
        }
        await hooks.action('onAccountCreated', { accountId: stored.id, email: stored.email, method }, input.context);
        return { user: publicUser(stored), token: session.raw, principal: principal(stored, session.value), ...(stored.newDevice ? { newDevice: true } : {}) };
    };
    const login = async (input: AuthCredentials, oldToken?: string) => {
        check();
        const email=normalizeEmail(input.email);
        // Password is the only guessable-secret proof here (passkey/OIDC sign-in and step-up use
        // their own namespaced budgets below, so a password-guessing attacker never spends someone
        // else's passkey/OIDC allowance, or vice versa), so it is the one that gets client scoping.
        const attemptKeys=await guessableAttempt('login:password',email,input.client),user=await store.call<AuthRecord|null>('email',{email});
        const verified = await verifyPassword(input.password, user?.passwordHash);
        if (!verified || !user || user.status !== 'active')
            return fail(401, 'invalid_credentials');
        const fact = factor(user, input, !oldToken), session = sessionFor(user.id, input.device), upgradedHash = !user.passwordHash.startsWith('scrypt-v1$') ? await hashPassword(input.password, false) : undefined;
        if (fact.trustedDeviceHash)
            session.value.authenticatedAt = 0;
        const stored = await store.call<AuthRecord>('login', { accountId: user.id, version: user.version, passwordHash: user.passwordHash, ...(upgradedHash ? { upgradedHash } : {}), ...fact, session: session.value, attemptKeys, ...(oldToken ? { oldHash: digest(oldToken) } : {}), now: now() });
        return { user: publicUser(stored), token: session.raw, principal: principal(stored, session.value), ...(stored.newDevice ? { newDevice: true } : {}) };
    };
    const pagination = (options: {
        limit?: number;
        after?: string;
    } = {}) => {
        const limit = options.limit ?? 50;
        if (!Number.isInteger(limit) || limit < 1 || limit > 100 || typeof (options.after ?? '') !== 'string' || (options.after?.length ?? 0) > 256)
            fail(400, 'invalid_page');
        return { limit, after: options.after ?? '' };
    };
    const reason = (value: string | undefined) => {
        if (value !== undefined && (typeof value !== 'string' || value.length > 256 || /[\x00-\x1f\x7f-\x9f]/.test(value)))
            fail(400, 'invalid_reason');
        return value ?? '';
    };
    const external = (provider: string, subject: string) => {
        if (!/^[a-z][a-z0-9_-]{0,63}$/.test(provider) || typeof subject !== 'string' || !subject || subject.length > 512 || /[\x00-\x1f\x7f]/.test(subject))
            fail(400, 'invalid_external_identity');
    };
    const validateProof = (value: AuthProof, method: string): AuthProof => {
        if (!value || value.kind !== method || !Number.isSafeInteger(value.version) || value.version < 1)
            fail(400, 'invalid_auth_proof');
        if (value.kind === 'oidc')
            external(value.provider, value.subject);
        else if (value.kind === 'passkey') {
            if (typeof value.credentialId !== 'string' || !value.credentialId || value.credentialId.length > 2048 || !(/^[a-f0-9]{64}$/.test(value.publicKeyHash)) || ![value.expectedCounter, value.newCounter].every(counter => Number.isSafeInteger(counter) && counter >= 0 && counter <= 4294967295) || !(value.expectedCounter === 0 && value.newCounter === 0) && value.newCounter <= value.expectedCounter)
                fail(400, 'invalid_auth_proof');
        }
        else
            fail(400, 'invalid_auth_proof');
        return structuredClone(value);
    };
    const signupBinding = (input: SignupBinding) => {
        check();
        if (!validToken(input.flowId) || typeof input.browserHash !== 'string' || !/^[a-f0-9]{64}$/.test(input.browserHash))
            fail(400, 'invalid_signup_flow');
        return { hash: digest(input.flowId), browser: input.browserHash, now: now() };
    };
    const signupState = (row: {
        account_id: string;
        email: string;
        step: SignupState['step'];
        expires: number;
    }, flowId: string): SignupState => ({ flowId, accountId: row.account_id, email: row.email, step: row.step, expires: row.expires });
    const signupRead = async (input: SignupBinding, step?: SignupState['step']) => {
        const row = await store.call<{
            account_id: string;
            email: string;
            step: SignupState['step'];
            expires: number;
            challenge: string | null;
        } | null>('signupRead', signupBinding(input));
        if (!row || step && row.step !== step)
            fail(400, 'invalid_signup_flow');
        return row!;
    };
    const service: AuthServiceInternal = {
        ...createAdminAccountOperations({store,check,now,roles,permittedEmail,hooks,roleChange}),
        attachLifecycleHooks: loaded => hooks.attach(loaded),
        auditOutbox: {
            peek: limit => store.call<AuditEvent[]>('auditOutboxPeek', { limit }),
            async ack(ids) { await store.call('auditOutboxAck', { ids: [...ids] }); },
            onPending: listener => store.onAuditPending(listener),
            backlog: () => store.call<number>('auditOutboxBacklog'),
        },
        passkeyRpIds: () => store.call<Record<string, number>>('passkeyRpIds'),
        async createSecondFactorProof(input) {
            check();
            if (!securityPolicy.allowPasskeySecondFactor || typeof input.browserHash !== 'string' || !/^[a-f0-9]{64}$/.test(input.browserHash))
                fail(400, 'invalid_second_factor');
            const proof = validateProof(input.proof, 'passkey'), raw = token();
            await store.call('factorProof', { hash: digest(raw), browser: input.browserHash, proof, now: now() });
            return raw;
        },
        async setPasskeySecondFactor(input) {
            if (!securityPolicy.allowPasskeySecondFactor || !validToken(input.token) || typeof input.enabled !== 'boolean' || typeof input.credentialId !== 'string' || !input.credentialId || input.credentialId.length > 2048)
                fail(400, 'invalid_second_factor');
            const { user } = await lookupSession(input.token, true, input.enabled);
            const fact = input.enabled ? factor(user, input.secondFactor ? { secondFactor: input.secondFactor } : {}) : {};
            if (input.enabled && !fact.secondFactorHash)
                fail(401, 'second_factor_required');
            await store.call('setPasskeyFactor', { hash: digest(input.token), credentialId: input.credentialId, enabled: input.enabled, ...fact, now: now() });
        },
        async rememberDevice(input) {
            if (!trustedDeviceTtlMs || !validToken(input.token) || input.label !== undefined && (typeof input.label !== 'string' || input.label.length > 160 || /[\x00-\x1f\x7f]/.test(input.label)))
                fail(400, 'invalid_trusted_device');
            const raw = token(), expires = now() + trustedDeviceTtlMs;
            await store.call('rememberDevice', { hash: digest(input.token), deviceHash: digest(raw), deviceId: randomUUID(), label: input.label ?? 'Browser', expires, now: now() });
            return { token: raw, expires };
        },
        async listTrustedDevices(raw) { if (!validToken(raw))
            fail(401, 'invalid_credentials'); return store.call('trustedDevices', { hash: digest(raw), now: now() }); },
        async revokeTrustedDevice(input) { if (!validToken(input.token))
            fail(401, 'invalid_credentials'); await store.call('revokeTrustedDevice', { hash: digest(input.token), deviceId: id(input.deviceId), now: now() }); },
        getManualRecoveryEnabled:()=>securityPolicy.allowManualRecovery===true,
        async createRecoveryCase(input){check();if(!securityPolicy.allowManualRecovery)fail(403,'manual_recovery_disabled');if(!validToken(input.actorToken))fail(401,'invalid_credentials');const why=reason(input.reason);if(!why.trim())fail(400,'invalid_case');let evidence;try{evidence=validateRecoveryEvidence(input.evidence);}catch{fail(400,'invalid_recovery_evidence');}return store.call<ManualRecoveryCase>('manualRecoveryCreate',{hash:digest(input.actorToken),accountId:id(input.accountId),email:permittedEmail(input.email),evidence,reason:why,id:randomUUID(),now:now()});},
        async listRecoveryCases(options){check();const page=pagination(options),cases=await store.call<ManualRecoveryCase[]>('manualRecoveryList',{...page,now:now()});return {cases,...(cases.length===page.limit?{next:cases.at(-1)!.id}:{})};},
        async approveRecoveryCase(input){check();if(!validToken(input.actorToken))fail(401,'invalid_credentials');const why=reason(input.reason);if(!why.trim())fail(400,'invalid_case');const raw=token(),result=await store.call<{case:ManualRecoveryCase;email:string;oldEmail:string}>('manualRecoveryApprove',{hash:digest(input.actorToken),id:id(input.caseId),reason:why,tokenHash:digest(raw),now:now()});return {...result,token:raw};},
        async activateRecoveryCase(input){check();if(!validToken(input.actorToken)||!validToken(input.token))fail(401,'invalid_credentials');await store.call('manualRecoveryActivate',{hash:digest(input.actorToken),id:id(input.caseId),tokenHash:digest(input.token),now:now()});},
        async cancelRecoveryCredential(input){check();if(!validToken(input.actorToken)||!validToken(input.token))fail(401,'invalid_credentials');await store.call('manualRecoveryCancel',{hash:digest(input.actorToken),id:id(input.caseId),tokenHash:digest(input.token),now:now()});},
        async redeemRecoveryCase(input){check();if(!securityPolicy.allowManualRecovery)fail(403,'manual_recovery_disabled');if(!validToken(input.token))fail(401,'invalid_recovery');await store.call('manualRecoveryCheck',{tokenHash:digest(input.token),now:now()});await attempt('manual-recovery:'+digest(input.token));const passwordHash=await newPassword(input.password),raw=token(),timestamp=now(),value:SessionRecord={id:randomUUID(),hash:digest(raw),accountId:'',created:timestamp,authenticatedAt:timestamp,expires:timestamp+Math.min(ttl,1800000),recoveryEnrollment:1,primaryMethod:'recovery',mfaAuthenticatedAt:0,mfaVersion:0};const user=await store.call<AuthRecord>('manualRecoveryRedeem',{tokenHash:digest(input.token),passwordHash,session:value,now:timestamp});value.accountId=user.id;return {user:publicUser(user),token:raw,principal:principal(user,value)};},
        getFactorRecoveryEnabled: () => securityPolicy.allowEmailFactorRecovery === true,
        async beginFactorRecovery(input) { check(); if (!securityPolicy.allowEmailFactorRecovery)
            fail(403, 'factor_recovery_disabled'); if (!validToken(input.browserToken))
            fail(400, 'invalid_recovery_browser'); const email = normalizeEmail(input.email); await attempt('factor-recovery:' + email); const verificationToken = token(), cancelToken = token(); const issued = await store.call<boolean>('factorRecoveryBegin', { email, browser: digest(input.browserToken), verification: digest(verificationToken), cancellation: digest(cancelToken), now: now() }); return { verificationToken: issued ? verificationToken : null, cancelToken: issued ? cancelToken : null }; },
        async confirmFactorRecovery(input) { check(); if (!securityPolicy.allowEmailFactorRecovery)
            fail(403, 'factor_recovery_disabled'); if (!validToken(input.token) || !validToken(input.browserToken))
            fail(400, 'invalid_recovery_token'); return store.call<{
            completeAfter: number;
            expires: number;
        }>('factorRecoveryConfirm', { verification: digest(input.token), browser: digest(input.browserToken), now: now() }); },
        async cancelFactorRecovery(raw) { check(); if (!securityPolicy.allowEmailFactorRecovery)
            fail(403, 'factor_recovery_disabled'); if (!validToken(raw))
            fail(400, 'invalid_recovery_token'); await store.call('factorRecoveryCancel', { cancellation: digest(raw), now: now() }); },
        async completeFactorRecovery(input) { check(); if (!securityPolicy.allowEmailFactorRecovery)
            fail(403, 'factor_recovery_disabled'); if (!validToken(input.token) || !validToken(input.browserToken))
            fail(400, 'invalid_recovery_token'); const raw = token(), timestamp = now(); const value = { id: randomUUID(), hash: digest(raw), accountId: '', created: timestamp, authenticatedAt: timestamp, expires: timestamp + Math.min(ttl, 1800000) }; const user = await store.call<AuthRecord>('factorRecoveryComplete', { verification: digest(input.token), browser: digest(input.browserToken), session: value, now: timestamp }); value.accountId = user.id; return { user: publicUser(user), token: raw, principal: principal(user, value) }; },
        async beginSignup(input) {
            check();
            if (typeof input.browserHash !== 'string' || !/^[a-f0-9]{64}$/.test(input.browserHash))
                fail(400, 'invalid_signup_flow');
            if (mode === 'off')
                fail(403, 'registration_unavailable');
            const email = normalizeEmail(input.email);
            await hooks.beforeRegister({ email, method: 'signup' }, input.context);
            let eligible = true;
            try {
                permittedEmail(email);
            }
            catch {
                eligible = false;
            }
            await attempt('signup:' + email);
            // Long-window per-account cap on top of the short per-code ceiling (#462): otherwise
            // repeated signup attempts can keep re-issuing codes for the same address indefinitely.
            await attempt('signup:daily:' + email, 20, 86400000);
            const flowId = randomBytes(32).toString('base64url'), accountId = randomUUID(), code = String(randomInt(1000000)).padStart(6, '0');
            const step = securityPolicy.requireEmailVerification ? 'verify-email' as const : 'credential' as const;
            const expires = now() + 1800000;
            const result = await store.call<{
                existing: boolean;
                eligible: boolean;
            }>('signupBegin', { hash: digest(flowId), browser: input.browserHash, email, accountId, codeHash: digest(flowId + ':' + code), step, expires, eligible, invitationHash: validToken(input.invitationToken) ? digest(input.invitationToken!) : '', now: now() });
            return { flowId, accountId, email, step, expires, ...(result.existing ? { delivery: { kind: 'registration-attempt' as const, email } } : result.eligible && securityPolicy.requireEmailVerification ? { delivery: { kind: 'signup-code' as const, email, code } } : {}) };
        },
        async getSignup(input) {
            const row = await store.call<{
                account_id: string;
                email: string;
                step: SignupState['step'];
                expires: number;
            } | null>('signupRead', signupBinding(input));
            return row ? signupState(row, input.flowId) : null;
        },
        async verifySignup(input) {
            const args = signupBinding(input);
            const row = await store.call<{
                account_id: string;
                email: string;
                step: SignupState['step'];
                expires: number;
            } | null>('signupVerify', { ...args, codeHash: digest(input.flowId + ':' + (typeof input.code === 'string' && /^\d{6}$/.test(input.code) ? input.code : 'invalid')) });
            if (!row)
                fail(400, 'invalid_signup_code');
            return signupState(row!, input.flowId);
        },
        async setSignupPassword(input) {
            await signupRead(input, 'credential');
            const passwordHash = await newPassword(input.password);
            await store.call('signupCredential', { ...signupBinding(input), passwordHash });
            return signupState(await signupRead(input, 'profile'), input.flowId);
        },
        async setSignupPasskeyChallenge(input) {
            if (typeof input.challenge !== 'string' || !/^[A-Za-z0-9_-]{32,1024}$/.test(input.challenge))
                fail(400, 'invalid_passkey');
            await store.call('signupChallenge', { ...signupBinding(input), challenge: input.challenge });
            return signupState(await signupRead(input, 'credential'), input.flowId);
        },
        async getSignupPasskeyChallenge(input) {
            const row = await signupRead(input, 'credential');
            if (!row.challenge)
                fail(400, 'invalid_signup_flow');
            return { state: signupState(row, input.flowId), challenge: row.challenge! };
        },
        async setSignupPasskey(input) {
            if (typeof input.challenge !== 'string' || !/^[A-Za-z0-9_-]{32,1024}$/.test(input.challenge))
                fail(400, 'invalid_passkey');
            const c = input.credential;
            if (!c || typeof c.id !== 'string' || !c.id || c.id.length > 2048 || typeof c.publicKey !== 'string' || !c.publicKey || c.publicKey.length > 8192 || !Number.isSafeInteger(c.counter) || c.counter < 0 || c.transports && (!Array.isArray(c.transports) || c.transports.length > 8 || c.transports.some(t => !['ble', 'cable', 'hybrid', 'internal', 'nfc', 'smart-card', 'usb'].includes(t))))
                fail(400, 'invalid_passkey');
            if (c.rpId !== undefined && !validRpId(c.rpId))
                fail(400, 'invalid_passkey');
            const credential = { id: c.id, publicKey: c.publicKey, counter: c.counter, ...(c.transports ? { transports: c.transports } : {}), ...(c.rpId ? { rpId: c.rpId } : {}) };
            await store.call('signupCredential', { ...signupBinding(input), challenge: input.challenge, credential });
            return signupState(await signupRead(input, 'profile'), input.flowId);
        },
        async completeSignup(input) {
            const row = await signupRead(input, 'profile'), profile = validateProfile(input.profile ?? {}), session = sessionFor(row.account_id, input.device);
            const stored = await store.call<AuthRecord | null>('signupComplete', { ...signupBinding(input), profile, session: session.value });
            if (!stored)
                return null;
            await hooks.action('onAccountCreated', { accountId: stored.id, email: stored.email, method: 'signup' }, input.context);
            return { user: publicUser(stored), token: session.raw, principal: principal(stored, session.value), ...(stored.newDevice ? { newDevice: true } : {}) };
        },
        register: input => create(input), bootstrapAdmin: input => create(input, true), login,
        async stepUp(input) {
            const value = await lookupSession(input.token);
            if (value.session.impersonatorId)
                fail(403, 'impersonation_restricted');
            return login({ email: value.user.email, password: input.password, ...(input.totp ? { totp: input.totp } : {}), ...(input.recoveryCode ? { recoveryCode: input.recoveryCode } : {}), ...(input.secondFactor ? { secondFactor: input.secondFactor } : {}), ...(input.client ? { client: input.client } : {}) }, input.token);
        },
        async authenticate(raw) {
            check();
            if (!validToken(raw))
                return null;
            const value = await store.call<{
                user: AuthRecord;
                session: SessionRecord;
            } | null>('authenticate', { hash: digest(raw), now: now() });
            return value ? principal(value.user, value.session) : null;
        },
        async logout(raw) {
            check();
            if (validToken(raw))
                await store.call('logout', { hash: digest(raw), now: now() });
        },
        async revokeSessions(accountId) { check(); await store.call('revoke', { accountId: id(accountId), now: now() }); },
        async listUsers(options) {
            check();
            if(options?.limit!==undefined&&(!Number.isInteger(options.limit)||options.limit<1||options.limit>100))fail(400,'invalid_page');
            let filters: ReturnType<typeof validateUserQuery>;
            try { filters = validateUserQuery(options); } catch { return fail(400, 'invalid_user_filter'); }
            if (filters.role !== undefined && !Object.hasOwn(roles, filters.role)) fail(400, 'invalid_filter');
            const result = await store.call<{ users: (AuthRecord & { observedLastSeen?: number })[]; next?: string }>('users', { ...filters });
            return { users: result.users.map(user => ({ ...publicUser(user), ...(typeof user.observedLastSeen === 'number' ? { observedLastSeen: user.observedLastSeen } : {}) })), ...(result.next ? { next: result.next } : {}) };
        },
        async getUser(accountId) { check(); const row = await store.call<AuthRecord | null>('account', { id: id(accountId) }); return row ? publicUser(row) : null; }, getRoles: () => structuredClone(roles),
        async listDevices(accountId) {
            check();
            return store.call<{
                id: string;
                label: string;
                lastSeen: number;
            }[]>('devices', { accountId: id(accountId) });
        },
        async listSessions(accountId) { check(); return store.call<AuthSession[]>('sessions', { accountId: id(accountId), now: now() }); },
        async issueToken(input) {
            check();
            if (!['verify-email', 'reset-password'].includes(input.purpose))
                fail(400, 'invalid_token_purpose');
            const email = normalizeEmail(input.email);
            // Namespaced per purpose: a reset-password flood against an account cannot also burn
            // its verify-email budget, and vice versa (they used to share one `token:<email>` key).
            await attempt('token:' + input.purpose + ':' + email);
            const raw = token(), issued = await store.call<boolean>('issueToken', { email, purpose: input.purpose, hash: digest(raw), now: now() });
            return { token: issued ? raw : null };
        },
        async consumeVerification(raw, sessionToken) {
            check();
            if (!validToken(raw))
                fail(400, 'invalid_token');
            const stored = await store.call<AuthRecord>('consumeToken', { hash: digest(raw), purpose: 'verify-email', ...(sessionToken !== undefined && validToken(sessionToken) ? { sessionHash: digest(sessionToken) } : {}), now: now() });
            return { ...publicUser(stored), ...(stored.mailboxClaimed ? { signInMethodsReset: true as const } : {}) };
        },
        async resetPassword(input) {
            check();
            if (!validToken(input.token))
                fail(400, 'invalid_token');
            const passwordHash = await newPassword(input.password);
            return publicUser(await store.call<AuthRecord>('consumeToken', { hash: digest(input.token), purpose: 'reset-password', passwordHash, now: now() }));
        },
        async beginTotp(raw) { const { user } = await lookupSession(raw, true, true); await attempt('totp:' + user.id); const secret = new Secret({ size: 20 }), totp = new TOTP({ issuer: 'URLCode', label: user.email, secret }); await store.call('totpBegin', { hash: digest(raw), secret: seal(secret.base32, 'totp:' + user.id), now: now() }); return { secret: secret.base32, otpauthUrl: totp.toString() }; },
        async confirmTotp(input) {
            const { user } = await lookupSession(input.token, true, true);
            await attempt('totp:' + user.id);
            if (!user.totpPending)
                fail(400, 'invalid_totp_setup');
            const step = counter(user.totpPending!, input.code, user.id), recoveryCodes = Array.from({ length: 10 }, () => randomBytes(16).toString('base64url'));
            await store.call('totpConfirm', { hash: digest(input.token), version: user.version, counter: step, recoveryHashes: recoveryCodes.map(digest), now: now() });
            return { recoveryCodes };
        },
        async disableTotp(input) {
            const { user } = await lookupSession(input.token, true);
            await attempt('totp:' + user.id);
            if (user.passwordHash && !await verifyPassword(input.password, user.passwordHash) || !user.totpSecret)
                fail(401, 'invalid_credentials');
            const fact = input.secondFactor ? factor(user, input) : { counter: counter(user.totpSecret!, input.code ?? '', user.id) };
            await store.call('totpDisable', { hash: digest(input.token), version: user.version, ...fact, now: now() });
        },
        async adminSetRoles(input) {
            check();
            if (!validToken(input.actorToken) || !Array.isArray(input.roles) || !input.roles.length || input.roles.length > 32 || input.roles.some(name => !Object.hasOwn(roles, name)))
                fail(400, 'invalid_roles');
            const why = reason(input.reason), requested = [...new Set(input.roles)];
            await roleChange(input.actorToken, input.accountId, requested, why, input.context);
            return publicUser(await store.call<AuthRecord>('admin', { hash: digest(input.actorToken), accountId: id(input.accountId), roles: requested, reason: why, now: now() }));
        },
        async adminSetStatus(input) {
            check();
            if (!validToken(input.actorToken) || !['active', 'locked'].includes(input.status))
                fail(400, 'invalid_account_status');
            const why = reason(input.reason), actor = hooks.has('onAccountStatusChanged') ? await actorOf(input.actorToken) : undefined;
            const changed = publicUser(await store.call<AuthRecord>('admin', { hash: digest(input.actorToken), accountId: id(input.accountId), status: input.status, reason: why, now: now() }));
            if (actor)
                await hooks.action('onAccountStatusChanged', { accountId: changed.id, status: input.status, actorId: actor.id, reason: why }, input.context);
            return changed;
        },
        async adminRevokeSessions(input) {
            check();
            if (!validToken(input.actorToken))
                fail(401, 'invalid_credentials');
            await store.call('adminRevoke', { hash: digest(input.actorToken), accountId: id(input.accountId), reason: reason(input.reason), now: now() });
        },
        async putFlow(input) {
            check();
            id(input.id);
            id(input.kind);
            const data = JSON.stringify(input.data);
            if (typeof data !== 'string' || Buffer.byteLength(data) > 16384 || !Number.isSafeInteger(input.expires) || input.expires <= now() || input.expires > now() + 600000)
                fail(400, 'invalid_auth_flow');
            await store.call('putFlow', { id: input.id, kind: input.kind, data: seal(data, 'flow:' + input.id + ':' + input.kind), expires: input.expires, now: now() });
        },
        async consumeFlow(flowId, kind) { check(); id(flowId); id(kind); const value = await store.call<string | null>('consumeFlow', { id: flowId, kind, now: now() }); return value === null ? null : JSON.parse(unseal(value, 'flow:' + flowId + ':' + kind)) as unknown; },
        async peekFlow(flowId, kind) { check(); id(flowId); id(kind); const value = await store.call<string | null>('peekFlow', { id: flowId, kind, now: now() }); return value === null ? null : JSON.parse(unseal(value, 'flow:' + flowId + ':' + kind)) as unknown; },
        async findExternal(provider, subject) { check(); external(provider, subject); const row = await store.call<AuthRecord | null>('external', { provider, subject }); return row ? publicUser(row) : null; },
        async linkExternal(input) {
            check();
            external(input.provider, input.subject);
            if (typeof input.sessionReference !== 'string' || !/^[a-f0-9]{64}$/.test(input.sessionReference))
                fail(401, 'invalid_credentials');
            await store.call('linkExternal', { hash: input.sessionReference, provider: input.provider, subject: input.subject, now: now() });
        },
        async createExternalAccount(input) {
            check();
            if (mode !== 'open')
                fail(403, 'registration_unavailable');
            external(input.provider, input.subject);
            if (input.emailVerified !== true)
                fail(400, 'verified_provider_email_required');
            const email = permittedEmail(input.email);
            await hooks.beforeRegister({ email, method: 'external', ...(input.profile ? { profile: input.profile as unknown as Record<string, unknown> } : {}) }, input.context);
            const user: AuthRecord = { id: randomUUID(), email, emailVerified: true, status: 'active', roles: [defaultRole], created: now(), passwordHash: '', version: 1, totpCounter: -1, ...(options.registrationPolicy || input.profile ? { profile: validateProfile(input.profile ?? {}) } : {}) };
            const saved = await store.call<AuthRecord>('createExternal', { user, provider: input.provider, subject: input.subject, now: now() });
            await hooks.action('onAccountCreated', { accountId: saved.id, email: saved.email, method: 'external' }, input.context);
            return publicUser(saved);
        },
        async getExternalProof(provider, subject) { check(); external(provider, subject); const user = await store.call<AuthRecord | null>('external', { provider, subject }); return user ? { user: publicUser(user), proof: { kind: 'oidc', version: user.version, provider, subject } } : null; },
        async issueSession(accountId, input) {
            check();
            const proof = validateProof(input.proof, input.method);
            if (!['passkey', 'oidc'].includes(input.method))
                fail(400, 'invalid_auth_method');
            const user = await store.call<AuthRecord | null>('account', { id: id(accountId) });
            if (!user || user.status !== 'active')
                fail(401, 'invalid_credentials');
            // Not a guessable secret: its own namespace so it never shares budget with, or is
            // exhausted by, password sign-in attempts against the same account.
            const attemptKeys = [await attempt('login:' + input.method + ':' + user!.email)], fact = factor(user!, input, true), session = sessionFor(accountId, input.device);
            session.value.primaryMethod = input.method;
            if (proof.kind === 'passkey')
                session.value.primaryCredentialId = proof.credentialId;
            if (fact.trustedDeviceHash)
                session.value.authenticatedAt = 0;
            const stored = await store.call<AuthRecord>('login', { accountId, proof, version: user!.version, passwordHash: user!.passwordHash, ...fact, session: session.value, attemptKeys, now: now() });
            return { user: publicUser(stored), token: session.raw, principal: principal(stored, session.value), ...(stored.newDevice ? { newDevice: true } : {}) };
        },
        async addPasskey(input) {
            check();
            if (!validToken(input.actorToken) || !input.credential || typeof input.credential.id !== 'string' || input.credential.id.length > 2048 || !input.credential.id || typeof input.credential.publicKey !== 'string' || input.credential.publicKey.length > 8192 || !Number.isSafeInteger(input.credential.counter) || input.credential.counter < 0 || (input.credential.transports && (input.credential.transports.length > 8 || input.credential.transports.some(t => !['ble', 'cable', 'hybrid', 'internal', 'nfc', 'smart-card', 'usb'].includes(t)))) || input.credential.rpId !== undefined && !validRpId(input.credential.rpId))
                fail(400, 'invalid_passkey');
            await store.call('addPasskey', { hash: digest(input.actorToken), credential: { id: input.credential.id, publicKey: input.credential.publicKey, counter: input.credential.counter, ...(input.credential.transports ? { transports: input.credential.transports } : {}), ...(input.credential.rpId ? { rpId: input.credential.rpId } : {}) }, now: now() });
        },
        async getPasskey(credentialId) {
            check();
            if (typeof credentialId !== 'string' || credentialId.length > 2048)
                fail(400, 'invalid_passkey');
            return store.call<{
                accountId: string;
                credential: Omit<AuthPasskey, 'accountId'>;
                proof: Omit<PasskeyAuthProof, 'newCounter'>;
            } | null>('getPasskey', { id: credentialId });
        },
        async listPasskeys(accountId) { check(); return store.call<Omit<AuthPasskey, 'accountId'>[]>('listPasskeys', { accountId: id(accountId) }); },
        async changePassword(input) {
            const { user } = await lookupSession(input.token, true);
            // Its own namespace: a session-gated re-confirmation never shares budget with an
            // anonymous, unauthenticated sign-in attempt against the same account.
            await attempt('login:reauth:' + user.email);
            if (!await verifyPassword(input.currentPassword, user.passwordHash))
                fail(401, 'invalid_credentials');
            const fact = factor(user, input), passwordHash = await newPassword(input.password);
            await store.call('changePassword', { hash: digest(input.token), version: user.version, passwordHash, ...fact, now: now() });
        },
        async exportAccount(raw) {
            const { user } = await lookupSession(raw, true);
            return { user: publicUser(user), sessions: await service.listSessions(user.id), passkeys: (await service.listPasskeys(user.id)).map(({ id, transports }) => ({ id, ...(transports ? { transports } : {}) })), identities: await store.call<{
                    provider: string;
                    subject: string;
                }[]>('identities', { accountId: user.id }) };
        },
        async deleteAccount(input) {
            const { user } = await lookupSession(input.token, true);
            await attempt('login:reauth:' + user.email);
            if (user.passwordHash && !await verifyPassword(input.password ?? '', user.passwordHash))
                fail(401, 'invalid_credentials');
            const cancelToken = token();
            const deleted = await store.call<{
                deleteAfter: number;
            }>('deleteAccount', { hash: digest(input.token), cancelHash: digest(cancelToken), version: user.version, ...factor(user, input), now: now() });
            await hooks.action('onDeletionScheduled', { accountId: user.id, email: user.email, deleteAfter: deleted.deleteAfter }, input.context);
            return { cancelToken, deleteAfter: deleted.deleteAfter };
        },
        async cancelDeletion(raw) {
            check();
            if (!validToken(raw))
                fail(400, 'invalid_token');
            await store.call('cancelDeletion', { hash: digest(raw), now: now() });
        },
        async purgeDeleted(options = {}) {
            check();
            const limit = options.limit ?? 100;
            if (!Number.isInteger(limit) || limit < 1 || limit > 100)
                fail(400, 'invalid_page');
            const result = await store.call<{
                purged: number;
                deleted: string[];
            }>('purgeDeleted', { limit, now: now() });
            for (const accountId of result.deleted)
                await hooks.action('onAccountDeleted', { accountId }, options.context);
            return { purged: result.purged };
        },
        async issueEmailCode(input) {
            check();
            const email = normalizeEmail(input.email), trustedClient = typeof input.client === 'string' && isIP(input.client) ? clientKey(input.client) : undefined;
            // Namespaced separately from other token purposes (#461), plus a long-window
            // per-account cap on issuance on top of the short per-code attempt/expiry ceiling
            // already enforced in the store (#462): per-code limits alone do not bound how many
            // codes one account can accumulate over a day. A trusted client additionally gets its
            // own tighter per-email daily budget: since a fresh code invalidates whichever one was
            // still in flight (see the store's `issueEmailCode`), a single client could otherwise
            // exhaust, or repeatedly cancel, another account's codes on its own. Scoping to the
            // client's clientKey (an IPv6 /64 is one client, matching #547) forces that to take
            // several distinct clients before the shared per-email ceiling above is even reached
            // (#548).
            await attempt('email-code:' + email);
            await attempt('email-code:daily:' + email, 20, 86400000);
            if (trustedClient)
                await attempt('email-code:daily:' + email + ':client:' + trustedClient, 5, 86400000);
            const flowId = token(), code = String(randomInt(1000000)).padStart(6, '0'), issued = await store.call<boolean>('issueEmailCode', { email, hash: digest(flowId), codeHash: digest(flowId + ':' + code), now: now() });
            return { flowId, code: issued ? code : null };
        },
        async consumeEmailCode(input) {
            check();
            if (!validToken(input.flowId) || typeof input.code !== 'string' || !/^\d{6}$/.test(input.code))
                fail(400, 'invalid_code');
            const user = await store.call<AuthRecord | null>('checkEmailCode', { hash: digest(input.flowId), codeHash: digest(input.flowId + ':' + input.code), now: now() });
            if (!user)
                fail(400, 'invalid_code');
            // An unverified account's first mailbox proof removes its earlier factors
            // (see the store's claim), so they are not demanded here.
            const session = sessionFor(user!.id, input.device), fact: Record<string, unknown> = user!.emailVerified ? factor(user!, input, true) : {};
            session.value.primaryMethod = 'email-code';
            if (fact.trustedDeviceHash)
                session.value.authenticatedAt = 0;
            const stored = await store.call<AuthRecord>('codeLogin', { hash: digest(input.flowId), codeHash: digest(input.flowId + ':' + input.code), version: user!.version, ...fact, session: session.value, now: now() });
            return { user: publicUser(stored), token: session.raw, principal: principal(stored, session.value), ...(stored.newDevice ? { newDevice: true } : {}) };
        },
        async createCase(input) {
            check();
            const why = reason(input.reason);
            if (!why.trim() || !validToken(input.actorToken) || !['reset-factors', 'lock', 'unlock', 'roles'].includes(input.action) || input.action === 'roles' && (!Array.isArray(input.roles) || !input.roles.length || input.roles.length > 32 || input.roles.some(name => !Object.hasOwn(roles, name))))
                fail(400, 'invalid_case');
            // Early feedback: a role case the project would veto on approval is refused at creation too.
            if (input.action === 'roles')
                await roleChange(input.actorToken, input.accountId, input.roles!, why, input.context);
            return store.call<AuthCase>('createCase', { hash: digest(input.actorToken), accountId: id(input.accountId), action: input.action, ...(input.roles ? { roles: input.roles } : {}), reason: why, id: randomUUID(), now: now() });
        },
        async listCases(options) { check(); const page = pagination(options), cases = await store.call<AuthCase[]>('cases', page); return { cases, ...(cases.length === page.limit ? { next: cases.at(-1)!.id } : {}) }; },
        async getCase(caseId) { check(); return store.call<AuthCase | null>('case', { id: id(caseId) }); },
        async approveCase(input) {
            check();
            const why = reason(input.reason);
            if (!why.trim() || !validToken(input.actorToken))
                fail(400, 'invalid_case');
            const pending = hooks.has('beforeRoleChange') || hooks.has('onAccountStatusChanged') ? await store.call<AuthCase | null>('case', { id: id(input.caseId) }) : null;
            if (pending?.action === 'roles')
                await roleChange(input.actorToken, pending.accountId, pending.roles ?? [], why, input.context);
            const approved = await store.call<AuthCase>('approveCase', { hash: digest(input.actorToken), id: id(input.caseId), reason: why, now: now() });
            if ((approved.action === 'lock' || approved.action === 'unlock') && approved.approverId)
                await hooks.action('onAccountStatusChanged', { accountId: approved.accountId, status: approved.action === 'lock' ? 'locked' : 'active', actorId: approved.approverId, reason: why }, input.context);
            return approved;
        },
        async createImpersonation(input) {
            check();
            const why = reason(input.reason);
            if (options.allowImpersonation !== true || !why.trim() || !validToken(input.actorToken))
                fail(403, 'impersonation_denied');
            const session = sessionFor(id(input.accountId));
            session.value.expires = now() + 600000;
            session.value.authenticatedAt = 0;
            const result = await store.call<{
                user: AuthRecord;
                session: SessionRecord;
            }>('impersonate', { hash: digest(input.actorToken), accountId: input.accountId, session: session.value, reason: why, now: now() });
            return { user: publicUser(result.user), token: session.raw, principal: principal(result.user, result.session) };
        },
        async adminBulk(input) {
            check();
            const why = reason(input.reason);
            if (!validToken(input.actorToken) || !why.trim() || !['lock', 'unlock', 'revoke-sessions'].includes(input.action) || !Array.isArray(input.accountIds) || input.accountIds.length < 1 || input.accountIds.length > 50 || new Set(input.accountIds).size !== input.accountIds.length)
                fail(400, 'invalid_bulk_action');
            const accountIds = input.accountIds.map(id), actor = input.action !== 'revoke-sessions' && hooks.has('onAccountStatusChanged') ? await actorOf(input.actorToken) : undefined;
            const result = await store.call<{
                affected: number;
            }>('adminBulk', { hash: digest(input.actorToken), accountIds, action: input.action, reason: why, now: now() });
            if (actor)
                for (const accountId of accountIds)
                    await hooks.action('onAccountStatusChanged', { accountId, status: input.action === 'lock' ? 'locked' : 'active', actorId: actor.id, reason: why }, input.context);
            return result;
        },
        async dashboard() {
            check();
            return store.call<{
                users: number;
                active: number;
                locked: number;
                pendingDeletion: number;
                sessions: number;
                waitlist: number;
                daily: AuthDailyMetric[];
            }>('dashboard', { now: now() });
        },
        async listAllSessions(options) {
            check();
            const filters = options ?? {};
            if (filters.accountId !== undefined) id(filters.accountId);
            if (filters.device !== undefined && (typeof filters.device !== 'string' || filters.device.length > 128 || /[\x00-\x1f\x7f]/.test(filters.device))) fail(400, 'invalid_session_filter');
            for (const value of [filters.createdFrom, filters.createdTo]) if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) fail(400, 'invalid_session_filter');
            if (filters.createdFrom !== undefined && filters.createdTo !== undefined && filters.createdFrom > filters.createdTo) fail(400, 'invalid_session_filter');
            const page = pagination(options), sessions = await store.call<(AuthSession & {
                accountId: string;
                email: string;
            })[]>('allSessions', { ...page, accountId: filters.accountId ?? '', device: filters.device ?? '', createdFrom: filters.createdFrom ?? 0, createdTo: filters.createdTo ?? Number.MAX_SAFE_INTEGER, now: now() });
            return { sessions, ...(sessions.length === page.limit ? { next: sessions.at(-1)!.id } : {}) };
        },
        async importUsers(users, importOptions = {}) {
            check();
            if (!Array.isArray(users) || !users.length || users.length > 100)
                fail(400, 'invalid_import');
            const rows = users.map(input => {
                if (!input || !validPasswordHash(input.passwordHash) || input.emailVerified !== undefined && typeof input.emailVerified !== 'boolean')
                    fail(400, 'invalid_import');
                return { id: randomUUID(), email: permittedEmail(input.email), emailVerified: input.emailVerified ?? false, status: 'active', roles: [defaultRole], created: now(), passwordHash: input.passwordHash, version: 1, totpCounter: -1 };
            });
            // Every row before the one transaction: a denied row refuses the whole batch, naming its index.
            for (const [index, row] of rows.entries()) {
                try { await hooks.beforeRegister({ email: row.email, method: 'import' }, importOptions.context); }
                catch (error) {
                    if (error instanceof AuthError)
                        throw new AuthError(error.status, error.code, undefined, `Row ${index}: ${error.reason ?? 'Registration not permitted'}`);
                    throw error;
                }
            }
            const result = await store.call<{
                imported: number;
            }>('importUsers', { users: rows, now: now() });
            for (const user of rows)
                await hooks.action('onAccountCreated', { accountId: user.id, email: user.email, method: 'import' }, importOptions.context);
            return result;
        },
        async getProfile(raw) { const { user } = await lookupSession(raw, true); return profilePolicy.publicProfile(user.profile ?? { metadata: {} }); },
        async updateProfile(input) { const { user } = await lookupSession(input.token, true), profile = validateProfile(input.profile, user.profile); await store.call('updateProfile', { hash: digest(input.token), profile, version: user.version, now: now() }); return profilePolicy.publicProfile(profile); },
        async getConfigurationRevision() { check(); return store.call<string>('configurationRevision'); },
        getSecurityPolicy: () => ({ ...securityPolicy }),
        getHookStats: () => hooks.stats(),
        getRegistrationSchema: () => profilePolicy.publicSchema(),
        getRegistrationMode: () => mode,
        getImpersonationEnabled: () => options.allowImpersonation === true,
        async requestRegistration(input) {
            check();
            if (mode !== 'waitlist')
                fail(403, 'registration_unavailable');
            const email = permittedEmail(input.email);
            await hooks.beforeRegister({ email, method: 'waitlist', ...(input.profile ? { profile: input.profile as unknown as Record<string, unknown> } : {}) }, input.context);
            const passwordHash = await newPassword(input.password);
            return store.call<{
                id: string;
                duplicate?: boolean;
            }>('requestRegistration', { id: randomUUID(), email, passwordHash, ...(options.registrationPolicy || input.profile ? { profile: validateProfile(input.profile ?? {}) } : {}), now: now() });
        },
        async listRegistrationRequests(options) {
            check();
            const page = pagination(options), requests = await store.call<{
                id: string;
                email: string;
                created: number;
            }[]>('registrationRequests', page);
            return { requests, ...(requests.length === page.limit ? { next: requests.at(-1)!.id } : {}) };
        },
        async approveRegistration(input) {
            check();
            if (mode !== 'waitlist' || !validToken(input.actorToken))
                fail(403, 'registration_unavailable');
            const actor = hooks.has('onAccountCreated') ? await actorOf(input.actorToken) : undefined;
            const user = await store.call<AuthRecord>('approveRegistration', { hash: digest(input.actorToken), requestId: id(input.requestId), reason: reason(input.reason), now: now() });
            await hooks.action('onAccountCreated', { accountId: user.id, email: user.email, method: 'waitlist', ...(actor ? { actorId: actor.id } : {}) }, input.context);
            return publicUser(user);
        },
        async invite(input) {
            check();
            if (mode !== 'invite-only' || !validToken(input.actorToken))
                fail(403, 'registration_unavailable');
            const raw = token();
            await store.call('invite', { actorHash: digest(input.actorToken), email: permittedEmail(input.email), hash: digest(raw), now: now() });
            return { token: raw };
        },
        async completeStepUp(input) {
            const proof = validateProof(input.proof, input.method), { user, session: previous } = await lookupSession(input.token);
            if (input.method !== 'passkey' || user.id !== input.accountId)
                fail(403, 'step_up_denied');
            if (previous.impersonatorId)
                fail(403, 'impersonation_restricted');
            const attemptKeys = [await attempt('login:passkey:' + user.email)], fact = factor(user, input), session = sessionFor(user.id);
            session.value.primaryMethod = 'passkey';
            if (proof.kind === 'passkey')
                session.value.primaryCredentialId = proof.credentialId;
            const stored = await store.call<AuthRecord>('login', { accountId: user.id, proof, version: user.version, passwordHash: user.passwordHash, ...fact, session: session.value, oldHash: digest(input.token), attemptKeys, now: now() });
            return { user: publicUser(stored), token: session.raw, principal: principal(stored, session.value) };
        },
        async removePasskey(input) {
            check();
            if (!validToken(input.token) || typeof input.credentialId !== 'string' || !input.credentialId || input.credentialId.length > 2048)
                fail(400, 'invalid_passkey');
            await store.call('removeMethod', { hash: digest(input.token), credentialId: input.credentialId, now: now() });
        },
        async unlinkExternal(input) {
            check();
            external(input.provider, input.subject);
            if (!validToken(input.token))
                fail(401, 'invalid_credentials');
            await store.call('removeMethod', { hash: digest(input.token), provider: input.provider, subject: input.subject, now: now() });
        },
        async closeCase(input) {
            check();
            const why = reason(input.reason);
            if (!why.trim() || !validToken(input.actorToken))
                fail(400, 'invalid_case');
            return store.call<AuthCase>('caseEdit', { hash: digest(input.actorToken), id: id(input.caseId), reason: why, close: true, now: now() });
        },
        async addCaseNote(input) {
            check();
            const note = reason(input.note);
            if (!note.trim() || !validToken(input.actorToken))
                fail(400, 'invalid_case');
            return store.call<AuthCase>('caseEdit', { hash: digest(input.actorToken), id: id(input.caseId), reason: note, now: now() });
        },
        async cleanup(options = {}) {
            check();
            const limit = options.limit ?? 100;
            if (!Number.isInteger(limit) || limit < 1 || limit > 1000)
                fail(400, 'invalid_page');
            return store.call<{
                removed: number;
            }>('cleanup', { limit, now: now() });
        },
        async requestEmailChange(input) {
            const { user } = await lookupSession(input.token, true);
            await attempt('login:reauth:' + user.email);
            if (user.passwordHash && !await verifyPassword(input.password ?? '', user.passwordHash))
                fail(401, 'invalid_credentials');
            const email = permittedEmail(input.email), verificationToken = token(), cancelToken = token(), activateAfter = now() + 86400000;
            await store.call('requestEmailChange', { hash: digest(input.token), version: user.version, email, verificationHash: digest(verificationToken), cancelHash: digest(cancelToken), ...factor(user, input), now: now() });
            return { oldEmail: user.email, newEmail: email, verificationToken, cancelToken, activateAfter };
        },
        async confirmEmailChange(raw) {
            check();
            if (!validToken(raw))
                fail(400, 'invalid_token');
            return publicUser(await store.call<AuthRecord>('confirmEmailChange', { hash: digest(raw), now: now() }));
        },
        async cancelEmailChange(raw) {
            check();
            if (!validToken(raw))
                fail(400, 'invalid_token');
            await store.call('cancelEmailChange', { hash: digest(raw), now: now() });
        },
        async adminCreateUser(input) {
            check();
            const why = reason(input.reason);
            if (!why.trim() || !validToken(input.actorToken))
                fail(400, 'invalid_administration');
            const email = permittedEmail(input.email);
            await hooks.beforeRegister({ email, method: 'administrator' }, input.context);
            const actor = hooks.has('onAccountCreated') ? await actorOf(input.actorToken) : undefined;
            const setupToken = token(), user: AuthRecord = { id: randomUUID(), email, emailVerified: false, status: 'active', roles: [defaultRole], created: now(), passwordHash: '', version: 1, totpCounter: -1 };
            const saved = await store.call<AuthRecord>('adminCreateUser', { hash: digest(input.actorToken), user, setupHash: digest(setupToken), reason: why, now: now() });
            await hooks.action('onAccountCreated', { accountId: saved.id, email: saved.email, method: 'administrator', ...(actor ? { actorId: actor.id } : {}) }, input.context);
            return { user: publicUser(saved), setupToken };
        },
        async revokeSession(input) {
            check();
            if (!validToken(input.token))
                fail(401, 'invalid_credentials');
            await store.call('revokeSession', { hash: digest(input.token), sessionId: id(input.sessionId), now: now() });
        },
        async adminRevokeSession(input) {
            check();
            const why = reason(input.reason);
            if (!why.trim() || !validToken(input.actorToken))
                fail(400, 'invalid_administration');
            await store.call('revokeSession', { hash: digest(input.actorToken), sessionId: id(input.sessionId), admin: true, reason: why, now: now() });
        },
        async adminAddNote(input) {
            check();
            if (!validToken(input.actorToken)) fail(401, 'invalid_session');
            if (typeof input.reason !== 'string' || !input.reason.trim() || input.reason.length > 256 || /[\x00-\x1f\x7f]/.test(input.reason)) fail(400, 'invalid_reason');
            await store.call('adminAddNote', { hash: digest(input.actorToken), accountId: id(input.accountId), reason: input.reason.trim(), now: now() });
        },
        async adminReveal(input) {
            check();
            if (!validToken(input.actorToken)) fail(401, 'invalid_session');
            if (typeof input.reason !== 'string' || !input.reason.trim() || input.reason.length > 256 || /[\x00-\x1f\x7f]/.test(input.reason)) fail(400, 'invalid_reason');
            return store.call<{id:string;email:string}>('adminReveal', { hash: digest(input.actorToken), accountId: id(input.accountId), reason: input.reason.trim(), now: now() });
        },
        async adminExport(input) {
            check();
            const why = reason(input.reason);
            if (!why.trim() || !validToken(input.actorToken))
                fail(400, 'invalid_administration');
            const result = await store.call<{
                user: AuthRecord;
                sessions: AuthSession[];
                identities: {
                    provider: string;
                    subject: string;
                }[];
            }>('adminExport', { hash: digest(input.actorToken), accountId: id(input.accountId), reason: why, now: now() });
            return { ...result, user: publicUser(result.user) };
        },
        async rotateEncryptionKey() {
            check();
            const rows = await store.call<{
                type: string;
                id: string;
                field: string;
                value: string;
                context: string;
            }[]>('rotationRows', { activeKey });
            const replacements = rows.map(row => ({ ...row, replacement: seal(unseal(row.value, row.context), row.context) }));
            return store.call<{
                changed: number;
                remaining: number;
            }>('rotationApply', { activeKey, replacements, now: now() });
        },
        async issueApiKey(input) {
            check();
            if (!input || typeof input.name !== 'string' || !input.name.trim() || input.name.length > 128 || /[\x00-\x1f\x7f]/.test(input.name))
                fail(400, 'invalid_api_key_name');
            if (!Array.isArray(input.scopes) || input.scopes.length > 32 || input.scopes.some(scope => typeof scope !== 'string' || !/^[a-z][a-z0-9_.:-]{0,127}$/.test(scope)))
                fail(400, 'invalid_api_key_scopes');
            if (input.expiresInMs !== undefined && (!Number.isSafeInteger(input.expiresInMs) || input.expiresInMs < 60000 || input.expiresInMs > 157680000000))
                fail(400, 'invalid_api_key_expiry');
            if (input.quota !== undefined && (!validApiKeyQuota(input.quota) || Object.keys(input.quota).some(name => name !== 'requests' && name !== 'window')))
                fail(400, 'invalid_api_key_quota');
            // Shape only here; the store refuses an unknown or inactive user in the insert's own transaction.
            if (input.userId !== undefined && (typeof input.userId !== 'string' || !principalIdPattern.test(input.userId)))
                fail(400, 'invalid_api_key_user');
            const quota = input.quota === undefined ? null : { requests: input.quota.requests, window: input.quota.window }, userId = input.userId ?? null;
            const scopes = [...new Set(input.scopes)], keyId = randomUUID(), secret = token();
            // Same derivation `newPassword`/`hashPassword` use for account passwords
            // (scrypt-v1, bounded by the shared hash-slot budget); `validate: false`
            // skips the human-password length policy, which does not apply to a
            // generated 256-bit secret.
            const secretHash = await hashPassword(secret, false);
            const created = now(), expires = input.expiresInMs === undefined ? null : created + input.expiresInMs;
            await store.call('apiKeyIssue', { id: keyId, name: input.name, scopes, secretHash, expires, quota, userId, now: created });
            return { id: keyId, key: `uak_${keyId}.${secret}`, name: input.name, scopes, expires, quota, userId };
        },
        async listApiKeys() {
            check();
            return store.call('apiKeyList', { now: now() });
        },
        async revokeApiKey(keyId) {
            check();
            if (typeof keyId !== 'string' || !keyId)
                fail(400, 'invalid_api_key_id');
            await store.call('apiKeyRevoke', { id: keyId, now: now() });
        },
        async authenticateApiKey(value) {
            check();
            if (typeof value !== 'string' || value.length > 512)
                return null;
            const match = /^uak_([0-9a-fA-F-]{36})\.([A-Za-z0-9_-]{43})$/.exec(value);
            if (!match)
                return null;
            const [, keyId, secret] = match as unknown as [string, string, string];
            const record = await store.call<{
                id: string;
                name: string;
                scopes: string[];
                secretHash: string;
                quota: { requests: number; window: number } | null;
                userId: string | null;
            } | null>('apiKeyLookup', { id: keyId, now: now() });
            if (!record || !await verifyPassword(secret, record.secretHash))
                return null;
            // Best-effort: a failed last-used update must not fail authentication.
            store.call('apiKeyTouch', { id: keyId, now: now() }).catch(() => undefined);
            return { id: record.id, name: record.name, scopes: record.scopes, quota: record.quota, userId: record.userId };
        },
        async consumeApiKeyQuota(keyId, quota) {
            check();
            if (typeof keyId !== 'string' || !keyId || keyId.length > 64)
                fail(400, 'invalid_api_key_id');
            if (!validApiKeyQuota(quota))
                fail(400, 'invalid_api_key_quota');
            // Hashed like the attempt counter's keys; the budget is part of the key so
            // routes restating one quota share a counter while a different one does not.
            const key = createHash('sha256').update(`urlcode-auth-api-key-quota:${keyId}:${quota.requests}/${quota.window}`).digest('hex');
            return store.call<{ allowed: boolean; remaining: number; reset: number }>('apiKeyQuota', { key, requests: quota.requests, windowMs: quota.window * 1000, now: now() });
        },
        async close() {
            if (closed)
                return;
            closed = true;
            hooks.close();
            await store.close();
            for (const value of Object.values(keys))
                value.fill(0);
        },
    };
    const withFailureMetric = async <T>(method: string, run: () => Promise<T>): Promise<T> => {
        try {
            return await run();
        }
        catch (error) {
            if (error instanceof AuthError && [400, 401, 429].includes(error.status)) {
                try {
                    await store.call('signInFailure', { method, now: now() });
                }
                catch { /* Observability cannot change the authentication result. */ }
            }
            throw error;
        }
    };
    const passwordLogin = service.login, externalLogin = service.issueSession, codeLogin = service.consumeEmailCode;
    service.login = input => withFailureMetric('password', () => passwordLogin(input));
    service.issueSession = (accountId, input) => withFailureMetric(input.method === 'passkey' ? 'passkey' : 'oidc', () => externalLogin(accountId, input));
    service.consumeEmailCode = input => withFailureMetric('email-code', () => codeLogin(input));
    return service;
}
