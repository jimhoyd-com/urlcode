import {adminAccountOperation} from './admin-account-store.ts';
import {abuseOperation} from './abuse-store.ts';
import {abuseKey} from './abuse.ts';
import type {AuthAbusePolicy} from './abuse.ts';
import { queryUsers } from './user-query.ts';
import type { UserQuery } from './user-query.ts';
import {manualRecoveryOperation} from './manual-recovery-store.ts';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { DatabaseSync, type SQLOutputValue } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { open, lstat, realpath } from 'node:fs/promises';
import type { RegistrationProfile } from './registration.ts';
import type { EventEmitter } from 'node:events';
import { resolve, dirname, basename, join } from 'node:path';
export class AuthError extends Error {
    readonly status: number;
    readonly code: string;
    // `cause` carries operator diagnostics only. Responses are built from `status`
    // and `code`, so nothing recorded here reaches a client.
    constructor(status: number, code: string, cause?: unknown) { super(code, cause === undefined ? undefined : { cause }); this.status = status; this.code = code; }
}
export interface AuthRecord {
    mfaPasskeys?: string[];
    mfaRecoveryRequired?: boolean;
    id: string;
    email: string;
    emailVerified: boolean;
    status: 'active' | 'locked' | 'pending-delete';
    deleteAfter?: number;
    roles: string[];
    created: number;
    passwordHash: string;
    version: number;
    totpSecret?: string;
    totpPending?: string;
    totpPendingUntil?: number;
    totpCounter: number;
    profile?: RegistrationProfile;
    newDevice?: boolean;
    /** Transient result flag: this operation was the account's first mailbox proof and removed its earlier methods. Never stored. */
    mailboxClaimed?: boolean;
}
export interface SessionRecord {
    primaryMethod?: string;
    primaryCredentialId?: string;
    mfaAuthenticatedAt?: number;
    mfaVersion?: number;
    recoveryEnrollment?: number;
    id: string;
    hash: string;
    accountId: string;
    created: number;
    authenticatedAt: number;
    expires: number;
    lastSeen?: number;
    deviceLabel?: string;
    deviceHash?: string;
    impersonatorId?: string;
    actorVersion?: number;
}
export interface StoreOptions {
    approveConfigurationChangeFrom?: string;
    configurationTag?: string;
    configurationChangeAt: number;
    database: string;
    roles: Record<string, string[]>;
    defaultRole: string;
    sessionIdleMs: number;
    sessionTtlMs: number;
    securityPolicy: {
        abuse?:AuthAbusePolicy;
        allowPasskeySecondFactor?: true;
        trustedDeviceTtlMs?: number;
        allowEmailFactorRecovery?: true;
        allowManualRecovery?: true;
        requireEmailVerification: boolean;
        requireMfa: boolean;
        deletionGraceMs: number;
    };
    registration: {
        disposableDomainsRevision?: string;
        mode: string;
        allowed: string[];
        blocked: string[];
        allowedEmails: string[];
        blockedEmails: string[];
        allowImpersonation: boolean;
    };
    activeKey: string;
    keyFingerprints: Record<string, string>;
}
export interface AuthStore {
    call<T = unknown>(operation: string, args?: Record<string, unknown>): Promise<T>;
    close(): Promise<void>;
}
/** Startup codes the worker reports for itself; anything else is an unavailable store. */
const startupCodes = ['auth_configuration_changed', 'configuration_approval_mismatch', 'configuration_roles_invalid', 'configuration_admin_required'];
/**
 * Describes the phase a worker was still in when its startup bound elapsed.
 * Thread scheduling and database initialization fail for unrelated reasons, and a
 * bare timeout cannot tell them apart; naming the phase makes the next occurrence
 * diagnosable from the failure alone. `onlineMs` is undefined when the worker
 * thread never began executing JavaScript.
 */
export function startupPhase(onlineMs: number | undefined, elapsedMs: number, stage?: string): string {
    return onlineMs === undefined
        ? `worker thread did not begin executing within ${elapsedMs}ms`
        : `worker thread began executing after ${onlineMs}ms, then did not report readiness for a further ${elapsedMs - onlineMs}ms${stage ? ` (last startup stage reached: ${stage})` : ' (no startup stage reached: the database open itself had not returned)'}`;
}
/**
 * Resolves once the worker reports readiness, and otherwise rejects with what it
 * reached. A worker that fails or exits before reporting is rejected at once
 * rather than waiting out `boundMs`, whose expiry is reported with its phase and
 * timings. Separated from Worker construction so every branch is testable.
 */
export function awaitStoreStartup(worker: EventEmitter, boundMs: number): Promise<void> {
    const started = performance.now(), elapsed = () => Math.round(performance.now() - started);
    let onlineMs: number | undefined, stage: string | undefined;
    worker.once('online', () => { onlineMs = elapsed(); });
    return new Promise<void>((accept, reject) => {
        const unavailable = (detail: string) => new AuthError(503, 'auth_store_unavailable', new Error(detail));
        const timer = setTimeout(() => { worker.removeAllListeners('message'); reject(unavailable(startupPhase(onlineMs, elapsed(), stage))); }, boundMs);
        worker.on('message', function report(message: { ready?: boolean; error?: string; stage?: string }) {
            if (message.stage) {
                stage = message.stage;
                return;
            }
            worker.off('message', report);
            clearTimeout(timer);
            if (message.ready)
                accept();
            else if (startupCodes.includes(message.error ?? ''))
                reject(new AuthError(503, message.error!));
            else
                reject(unavailable(`worker reported ${message.error ?? 'no readiness'} after ${elapsed()}ms`));
        });
        worker.once('error', (error: unknown) => { clearTimeout(timer); reject(unavailable(`worker failed after ${elapsed()}ms: ${error instanceof Error ? error.message : String(error)}`)); });
        worker.once('exit', (code: number) => { clearTimeout(timer); reject(unavailable(`worker exited with code ${code} after ${elapsed()}ms without reporting readiness`)); });
    });
}
export function patched(version: string): boolean { const [a = 0, b = 0, c = 0] = version.split('.').map(Number); return a > 3 || a === 3 && (b > 51 || b === 51 && c >= 3 || b === 50 && c >= 7 || b === 44 && c >= 6); }
/**
 * Worker readiness budget. Defaults to 15000ms; URLCODE_AUTH_STORE_STARTUP_MS may
 * raise it (up to 120000ms) for slow shared CI runners. Values that are not
 * integers at or above the default are ignored, so it can never tighten the
 * production bound.
 */
export function storeStartupBudgetMs(env: Record<string, string | undefined> = process.env): number {
    const raw = env.URLCODE_AUTH_STORE_STARTUP_MS;
    if (raw === undefined || !/^\d{1,6}$/.test(raw)) return 15000;
    return Math.min(120000, Math.max(15000, Number(raw)));
}
export async function openAuthStore(options: StoreOptions): Promise<AuthStore> {
    if (!isMainThread)
        throw new AuthError(503, 'auth_store_unavailable');
    if (!patched(process.versions.sqlite || ''))
        throw new AuthError(503, 'patched_sqlite_required');
    const requested = resolve(options.database), parent = await realpath(dirname(requested)), database = join(parent, basename(requested));
    try {
        const file = await open(database, 'wx', 0o600);
        await file.close();
    }
    catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST'))
            throw error;
    }
    const info = await lstat(database);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || (process.platform !== 'win32' && (info.mode & 0o077) !== 0))
        throw new AuthError(400, 'invalid_auth_database');
    const worker = new Worker(new URL(import.meta.url), { workerData: { ...options, database, authStore: true }, env: {}, execArgv: [], stdout: true, stderr: true, resourceLimits: { maxOldGenerationSizeMb: 64 } });
    worker.stdout.resume();
    worker.stderr.resume();
    let sequence = 0, closed = false;
    const pending = new Map<number, {
        resolve: (v: unknown) => void;
        reject: (e: Error) => void;
        timer: NodeJS.Timeout;
    }>();
    const fail = () => {
        closed = true;
        for (const p of pending.values()) {
            clearTimeout(p.timer);
            p.reject(new AuthError(503, 'auth_store_unavailable'));
        }
        pending.clear();
    };
    worker.on('error', fail);
    worker.on('exit', fail);
    try {
        await awaitStoreStartup(worker, storeStartupBudgetMs());
    } catch (error) {
        // A rejected open must release SQLite handles before its caller can
        // retry, restore or remove the database (Windows cannot unlink them).
        await worker.terminate();
        throw error;
    }
    worker.on('message', (message: {
        id: number;
        value?: unknown;
        error?: {
            status: number;
            code: string;
        };
    }) => {
        const p = pending.get(message.id);
        if (!p)
            return;
        pending.delete(message.id);
        clearTimeout(p.timer);
        if (message.error)
            p.reject(new AuthError(message.error.status, message.error.code));
        else
            p.resolve(message.value);
    });
    return { call<T>(operation: string, args: Record<string, unknown> = {}): Promise<T> {
            if (closed)
                return Promise.reject(new AuthError(503, 'auth_store_closed'));
            if (pending.size >= 32)
                return Promise.reject(new AuthError(503, 'auth_store_busy'));
            return new Promise<T>((accept, reject) => { const id = ++sequence, timer = setTimeout(() => { fail(); void worker.terminate(); }, 10000); pending.set(id, { resolve: value => accept(value as T), reject, timer }); worker.postMessage({ id, operation, args }); });
        }, async close() {
            if (closed)
                return;
            closed = true;
            fail();
            await worker.terminate();
        } };
}
if (!isMainThread && workerData?.authStore) {
    const port = parentPort!;
    const options = workerData as StoreOptions;
    let db: DatabaseSync;
    let initializing = true;
    let dispatchTransaction = false;
    let configurationRevision = '';
    const roles = options.roles, permissions = (names: string[]): string[] => [...new Set(names.flatMap(name => roles[name] || []))];
    const admin = (names: string[]) => permissions(names).includes('*');
    const error = (status: number, code: string): never => { throw new AuthError(status, code); };
    const num = (value: SQLOutputValue | undefined): number => Number(value);
    const decode = (row: Record<string, SQLOutputValue> | undefined): AuthRecord | null => row ? JSON.parse(String(row.data)) as AuthRecord : null;
    const account = (id: string) => decode(db.prepare('SELECT data FROM auth_accounts WHERE id=?').get(id));
    const save = (record: AuthRecord) => db.prepare('UPDATE auth_accounts SET data=?,status=?,administrator=? WHERE id=?').run(JSON.stringify(record), record.status, Number(admin(record.roles)), record.id);
    const metric = (event: 'signup' | 'success' | 'failure', method: string, now: number, count = 1) => {
        const day = Math.floor(now / 86400000);
        if (!['password', 'passkey', 'oidc', 'email-code', 'unknown'].includes(method))
            method = 'unknown';
        db.prepare('DELETE FROM auth_daily_metrics WHERE day<?').run(day - 29);
        db.prepare('INSERT INTO auth_daily_metrics(day,method,event,count) VALUES(?,?,?,?) ON CONFLICT(day,method,event) DO UPDATE SET count=count+excluded.count').run(day, method, event, count);
    };
    const methodActivity = (kind:string, methodId:string, accountId:string, time:number, added=false) => {
        db.prepare('INSERT INTO auth_method_activity(kind,method_id,account_id,added,last_used) VALUES(?,?,?,?,?) ON CONFLICT(kind,method_id) DO UPDATE SET last_used=excluded.last_used').run(kind,methodId,accountId,added?time:null,added?null:time);
    };
    const audit = (actor: string, action: string, subject: string, now: number, reason = '') => {
        db.prepare('INSERT INTO auth_audit(actor,action,subject,created,reason) VALUES(?,?,?,?,?)').run(actor, action, subject, now, reason);
        db.prepare('DELETE FROM auth_audit WHERE id <= (SELECT max(id)-100000 FROM auth_audit)').run();
        if (['account.register', 'admin.bootstrap', 'registration.approved', 'admin.account_created', 'account.external_register', 'accounts.imported'].includes(action))
            metric('signup', action === 'account.external_register' ? 'oidc' : action === 'accounts.imported' ? 'unknown' : 'password', now, action === 'accounts.imported' ? Number(subject) : 1);
    };
    const transaction = <T>(fn: () => T): T => {
        if (dispatchTransaction)
            return fn();
        db.exec('BEGIN IMMEDIATE');
        try {
            const activeKey = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='auth_meta'").get() ? db.prepare("SELECT value FROM auth_meta WHERE key='activeEncryptionKey'").get()?.value : undefined;
            if (activeKey && activeKey !== options.activeKey && !initializing)
                error(503, 'stale_encryption_key');
            const result = fn();
            db.exec('COMMIT');
            return result;
        }
        catch (e) {
            db.exec('ROLLBACK');
            throw e;
        }
    };
    const active = (id: string): AuthRecord => {
        const user = account(id);
        if (!user || user.status !== 'active')
            error(401, 'invalid_credentials');
        return user!;
    };
    const session = (hash: string, now: number): {
        user: AuthRecord;
        session: SessionRecord;
    } | null => {
        const found = db.prepare('SELECT id,hash,account_id AS accountId,created,authenticated_at AS authenticatedAt,expires,last_seen AS lastSeen,device_label AS deviceLabel,impersonator_id AS impersonatorId,actor_version AS actorVersion,recovery_enrollment AS recoveryEnrollment,primary_method AS primaryMethod,primary_credential AS primaryCredentialId,mfa_authenticated_at AS mfaAuthenticatedAt,mfa_version AS mfaVersion FROM auth_sessions WHERE hash=? AND expires>?').get(hash, now);
        if (!found || now - Number(found.lastSeen) >= options.sessionIdleMs)
            return null;
        const user = account(String(found.accountId));
        if (found.impersonatorId) {
            const actor = account(String(found.impersonatorId)), p = actor ? permissions(actor.roles) : [];
            if (!actor || actor.status !== 'active' || actor.version !== found.actorVersion || !p.includes('*') && !p.includes('auth.users.impersonate') || !user || permissions(user.roles).some(permission => permission === '*' || permission.startsWith('auth.') || permission.startsWith('admin.')))
                return null;
        }
        return user?.status === 'active' ? { user, session: found as unknown as SessionRecord } : null;
    };
    const passkeyFactor = (user: AuthRecord) => Boolean(options.securityPolicy.allowPasskeySecondFactor && user.mfaPasskeys?.length);
    const restricted = (user: AuthRecord) => user.mfaRecoveryRequired || options.securityPolicy.requireEmailVerification && !user.emailVerified || options.securityPolicy.requireMfa && !user.totpSecret && !passkeyFactor(user);
    const fresh = (hash: string, now: number, enrollment = false) => {
        const found = session(hash, now);
        if (found?.session.impersonatorId)
            error(403, 'impersonation_restricted');
        if (!found || now - found.session.authenticatedAt > 300000)
            error(401, 'fresh_authentication_required');
        if (enrollment && found!.user.mfaRecoveryRequired && !found!.session.recoveryEnrollment)
            error(403, 'recovery_enrollment_proof_required');
        if (restricted(found!.user) && (!enrollment || options.securityPolicy.requireEmailVerification && !found!.user.emailVerified))
            error(403, 'enrollment_required');
        return found!;
    };
    const authorizeCase = (actor: AuthRecord, target: AuthRecord, nextRoles?: string[]) => {
        if (restricted(actor))
            error(403, 'enrollment_required');
        if (target.status === 'pending-delete')
            error(409, 'account_pending_deletion');
        const p = permissions(actor.roles);
        if (actor.id === target.id || !p.includes('*') && (!p.includes('auth.cases.manage') || !p.includes('auth.users.manage')))
            error(403, 'permission_denied');
        for (const permission of [...permissions(target.roles), ...permissions(nextRoles ?? target.roles)])
            if (!p.includes('*') && !p.includes(permission))
                error(403, 'delegation_ceiling_exceeded');
    };
    const passkeyProof = (user: AuthRecord, value: unknown, update: boolean) => {
        const proof = value as {
            kind?: string;
            version?: number;
            credentialId?: string;
            publicKeyHash?: string;
            expectedCounter?: number;
            newCounter?: number;
        };
        const credential = proof && db.prepare('SELECT data,counter FROM auth_passkeys WHERE id=? AND account_id=?').get(String(proof.credentialId), user.id);
        if (!credential || proof.kind !== 'passkey' || proof.version !== user.version || num(credential.counter) !== proof.expectedCounter || createHash('sha256').update(String(JSON.parse(String(credential.data)).publicKey)).digest('hex') !== proof.publicKeyHash || !Number.isSafeInteger(proof.newCounter) || proof.newCounter! < 0 || !(proof.expectedCounter === 0 && proof.newCounter === 0) && proof.newCounter! <= proof.expectedCounter!)
            error(401, 'stale_auth_proof');
        if (update)
            db.prepare('UPDATE auth_passkeys SET counter=? WHERE id=? AND account_id=? AND counter=?').run(proof.newCounter!, String(proof.credentialId), user.id, proof.expectedCounter!);
        return proof.credentialId!;
    };
    const takeSecondFactor = (user: AuthRecord, args: Record<string, unknown>, now: number, enrollmentId?: string) => {
        if (!options.securityPolicy.allowPasskeySecondFactor)
            error(401, 'invalid_second_factor');
        const row = db.prepare('SELECT * FROM auth_second_factor_proofs WHERE hash=? AND browser=? AND account_id=? AND expires>?').get(String(args.secondFactorHash), String(args.secondFactorBrowser), user.id, now);
        if (!row || row.version !== user.version)
            error(401, 'invalid_second_factor');
        const proof = JSON.parse(String(row!.proof)), primaryCredential = (args.session as SessionRecord | undefined)?.primaryCredentialId;
        if (enrollmentId ? proof.credentialId !== enrollmentId : !user.mfaPasskeys?.includes(proof.credentialId))
            error(401, 'invalid_second_factor');
        if (primaryCredential === proof.credentialId)
            error(401, 'independent_second_factor_required');
        passkeyProof(user, proof, true);
        methodActivity('passkey',String(proof.credentialId),user.id,now);
        db.prepare('DELETE FROM auth_second_factor_proofs WHERE hash=?').run(String(args.secondFactorHash));
    };
    const consumeFactor = (user: AuthRecord, args: Record<string, unknown>, now: number): boolean => {
        if (args.secondFactorHash) {
            takeSecondFactor(user, args, now);
            return true;
        }
        if (args.trustedDeviceHash) {
            if (!options.securityPolicy.trustedDeviceTtlMs || user.mfaRecoveryRequired || !user.totpSecret && !passkeyFactor(user) || !db.prepare('SELECT id FROM auth_trusted_devices WHERE hash=? AND account_id=? AND version=? AND expires>?').get(String(args.trustedDeviceHash), user.id, user.version, now))
                error(401, 'invalid_trusted_device');
            if (!args.session || args.oldHash)
                error(401, 'invalid_trusted_device');
            (args.session as unknown as SessionRecord).authenticatedAt = 0;
            return false;
        }
        if (!user.totpSecret) {
            if (passkeyFactor(user))
                error(401, 'second_factor_required');
            return false;
        }
        if (args.recoveryHash) {
            if (db.prepare('DELETE FROM auth_recovery WHERE hash=? AND account_id=?').run(String(args.recoveryHash), user.id).changes !== 1)
                error(401, 'invalid_credentials');
        }
        else {
            const counter = Number(args.counter);
            if (!Number.isSafeInteger(counter) || counter <= user.totpCounter)
                error(401, 'invalid_credentials');
            user.totpCounter = counter;
            save(user);
        }
        return true;
    };
    const realMfa = (hash: string, now: number) => {
        const found = fresh(hash, now);
        if (!found.session.mfaAuthenticatedAt || now - found.session.mfaAuthenticatedAt > 300000 || found.session.mfaVersion !== found.user.version)
            error(403, 'fresh_second_factor_required');
        return found;
    };
    const addSession = (value: SessionRecord) => {
        let newDevice = false;
        if (value.deviceHash) {
            newDevice = !db.prepare('SELECT hash FROM auth_devices WHERE account_id=? AND hash=?').get(value.accountId, value.deviceHash);
            db.prepare('INSERT INTO auth_devices VALUES(?,?,?,?) ON CONFLICT(account_id,hash) DO UPDATE SET label=excluded.label,last_seen=excluded.last_seen').run(value.accountId, value.deviceHash, value.deviceLabel ?? 'Browser', value.created);
            db.prepare('DELETE FROM auth_devices WHERE account_id=? AND hash NOT IN (SELECT hash FROM auth_devices WHERE account_id=? ORDER BY last_seen DESC,hash LIMIT 20)').run(value.accountId, value.accountId);
        }
        db.prepare('DELETE FROM auth_sessions WHERE hash IN (SELECT hash FROM auth_sessions WHERE expires<=? LIMIT 1000)').run(value.created);
        db.prepare('DELETE FROM auth_sessions WHERE account_id=? AND id NOT IN (SELECT id FROM auth_sessions WHERE account_id=? ORDER BY created DESC,id DESC LIMIT 19)').run(value.accountId, value.accountId);
        db.prepare('INSERT INTO auth_sessions(hash,id,account_id,created,authenticated_at,expires,impersonator_id,actor_version,last_seen,device_label,recovery_enrollment,primary_method,primary_credential,mfa_authenticated_at,mfa_version) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(value.hash, value.id, value.accountId, value.created, value.authenticatedAt, value.expires, value.impersonatorId ?? null, value.actorVersion ?? null, value.created, value.deviceLabel ?? null, value.recoveryEnrollment ?? 0, value.primaryMethod ?? 'unknown', value.primaryCredentialId ?? null, value.mfaAuthenticatedAt ?? 0, value.mfaVersion ?? 0);
        return newDevice;
    };
    /**
     * First mailbox proof for an account whose email was never verified. Without
     * required verification anyone can register an address they do not control
     * and then add sign-in methods to it; the party who later proves the mailbox
     * must not inherit them. Every method, factor, device trust, pending flow and
     * session established before this proof is removed in the caller's
     * transaction. `clearPassword` also discards the password when the proof did
     * not come with a replacement (the caller then issues its own session, or the
     * prover sets a password through reset).
     */
    const claimMailbox = (user: AuthRecord, proof: 'password-reset' | 'email-code' | 'verify-email', now: number, clearPassword: boolean) => {
        const count = (table: string) => num(db.prepare('SELECT count(*) AS n FROM ' + table + ' WHERE account_id=?').get(user.id)?.n);
        const removed = { passkeys: count('auth_passkeys'), identities: count('auth_external'), recoveryCodes: count('auth_recovery'), trustedDevices: count('auth_trusted_devices'), sessions: count('auth_sessions'), authenticator: Boolean(user.totpSecret || user.totpPending), password: clearPassword && Boolean(user.passwordHash) };
        delete user.totpSecret;
        delete user.totpPending;
        delete user.totpPendingUntil;
        delete user.mfaPasskeys;
        delete user.mfaRecoveryRequired;
        user.totpCounter = -1;
        if (clearPassword)
            user.passwordHash = '';
        user.emailVerified = true;
        user.version++;
        save(user);
        for (const table of ['auth_sessions', 'auth_tokens', 'auth_recovery', 'auth_method_activity', 'auth_passkeys', 'auth_external', 'auth_email_codes', 'auth_email_changes', 'auth_factor_recovery', 'auth_second_factor_proofs', 'auth_trusted_devices', 'auth_devices'])
            db.prepare('DELETE FROM ' + table + ' WHERE account_id=?').run(user.id);
        audit(user.id, 'account.claimed', user.id, now, JSON.stringify({ proof, removed }));
    };
    try {
        db = new DatabaseSync(options.database, { allowExtension: false });
        port.postMessage({ stage: 'database opened' });
        db.exec('PRAGMA busy_timeout=1000; PRAGMA foreign_keys=ON; PRAGMA trusted_schema=OFF;');
        const version = db.prepare('PRAGMA user_version').get()?.user_version, application = db.prepare('PRAGMA application_id').get()?.application_id;
        const empty = db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table'").get()?.n === 0;
        if (!(version === 1 && application === 1430345032) && !(version === 0 && application === 0 && empty))
            error(503, 'unsupported_auth_database');
        db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
        port.postMessage({ stage: 'journal mode set' });
        if (empty)
            transaction(() => {
                db.exec(`CREATE TABLE auth_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
   CREATE TABLE auth_accounts(id TEXT PRIMARY KEY,email TEXT NOT NULL UNIQUE,status TEXT NOT NULL,administrator INTEGER NOT NULL,data TEXT NOT NULL);
   CREATE INDEX auth_admin ON auth_accounts(administrator,status);
   CREATE TABLE auth_sessions(hash TEXT PRIMARY KEY,id TEXT NOT NULL UNIQUE,account_id TEXT NOT NULL REFERENCES auth_accounts(id) ON DELETE CASCADE,created INTEGER NOT NULL,authenticated_at INTEGER NOT NULL,expires INTEGER NOT NULL,impersonator_id TEXT,actor_version INTEGER,last_seen INTEGER NOT NULL DEFAULT 0,device_label TEXT);
   CREATE INDEX auth_session_account ON auth_sessions(account_id,created);CREATE INDEX auth_session_expiry ON auth_sessions(expires);
   CREATE TABLE auth_tokens(hash TEXT PRIMARY KEY,account_id TEXT NOT NULL REFERENCES auth_accounts(id) ON DELETE CASCADE,purpose TEXT NOT NULL,expires INTEGER NOT NULL,version INTEGER NOT NULL);
   CREATE INDEX auth_token_account ON auth_tokens(account_id,purpose);CREATE INDEX auth_token_expiry ON auth_tokens(expires);
   CREATE TABLE auth_recovery(hash TEXT PRIMARY KEY,account_id TEXT NOT NULL REFERENCES auth_accounts(id) ON DELETE CASCADE);
   CREATE INDEX auth_recovery_account ON auth_recovery(account_id);
   CREATE TABLE auth_attempts(key TEXT PRIMARY KEY,count INTEGER NOT NULL,expires INTEGER NOT NULL);CREATE INDEX auth_attempt_expiry ON auth_attempts(expires);
   CREATE TABLE auth_audit(id INTEGER PRIMARY KEY AUTOINCREMENT,actor TEXT NOT NULL,action TEXT NOT NULL,subject TEXT NOT NULL,created INTEGER NOT NULL,reason TEXT NOT NULL);
   CREATE TABLE auth_flows(id TEXT PRIMARY KEY,kind TEXT NOT NULL,data TEXT NOT NULL,expires INTEGER NOT NULL);CREATE INDEX auth_flow_expiry ON auth_flows(expires);
   CREATE TABLE auth_external(provider TEXT NOT NULL,subject TEXT NOT NULL,account_id TEXT NOT NULL REFERENCES auth_accounts(id) ON DELETE CASCADE,PRIMARY KEY(provider,subject));CREATE INDEX auth_external_account ON auth_external(account_id);
   CREATE TABLE auth_passkeys(id TEXT PRIMARY KEY,account_id TEXT NOT NULL REFERENCES auth_accounts(id) ON DELETE CASCADE,data TEXT NOT NULL,counter INTEGER NOT NULL);CREATE INDEX auth_passkey_account ON auth_passkeys(account_id);
   PRAGMA application_id=1430345032;PRAGMA user_version=1;`);
            });
        db.exec('CREATE TABLE IF NOT EXISTS auth_daily_metrics(day INTEGER NOT NULL,method TEXT NOT NULL,event TEXT NOT NULL,count INTEGER NOT NULL,PRIMARY KEY(day,method,event));CREATE TABLE IF NOT EXISTS auth_devices(account_id TEXT NOT NULL REFERENCES auth_accounts(id) ON DELETE CASCADE,hash TEXT NOT NULL,label TEXT NOT NULL,last_seen INTEGER NOT NULL,PRIMARY KEY(account_id,hash));CREATE TABLE IF NOT EXISTS auth_email_changes(account_id TEXT PRIMARY KEY REFERENCES auth_accounts(id) ON DELETE CASCADE,email TEXT NOT NULL,verification_hash TEXT UNIQUE NOT NULL,cancel_hash TEXT UNIQUE NOT NULL,activate_after INTEGER NOT NULL,expires INTEGER NOT NULL,version INTEGER NOT NULL);CREATE TABLE IF NOT EXISTS auth_email_codes(hash TEXT PRIMARY KEY,account_id TEXT NOT NULL UNIQUE REFERENCES auth_accounts(id) ON DELETE CASCADE,code_hash TEXT NOT NULL,expires INTEGER NOT NULL,attempts INTEGER NOT NULL,version INTEGER NOT NULL);CREATE TABLE IF NOT EXISTS auth_cases(id TEXT PRIMARY KEY,data TEXT NOT NULL);CREATE TABLE IF NOT EXISTS auth_invites(hash TEXT PRIMARY KEY,email TEXT NOT NULL UNIQUE,expires INTEGER NOT NULL);CREATE TABLE IF NOT EXISTS auth_waitlist(id TEXT PRIMARY KEY,email TEXT NOT NULL UNIQUE,password_hash TEXT NOT NULL,created INTEGER NOT NULL,profile TEXT);');
        if (!db.prepare('PRAGMA table_info(auth_sessions)').all().some(row => row.name === 'impersonator_id'))
            db.exec('ALTER TABLE auth_sessions ADD COLUMN impersonator_id TEXT;ALTER TABLE auth_sessions ADD COLUMN actor_version INTEGER;');
        if (!db.prepare('PRAGMA table_info(auth_waitlist)').all().some(row => row.name === 'profile'))
            db.exec('ALTER TABLE auth_waitlist ADD COLUMN profile TEXT;');
        if (!db.prepare('PRAGMA table_info(auth_sessions)').all().some(row => row.name === 'last_seen'))
            db.exec('ALTER TABLE auth_sessions ADD COLUMN last_seen INTEGER NOT NULL DEFAULT 0;ALTER TABLE auth_sessions ADD COLUMN device_label TEXT;UPDATE auth_sessions SET last_seen=created;');
        if (!db.prepare('PRAGMA table_info(auth_waitlist)').all().some(row => row.name === 'email_verified'))
            db.exec('ALTER TABLE auth_waitlist ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 0;ALTER TABLE auth_waitlist ADD COLUMN passkey TEXT;');
        db.exec('CREATE TABLE IF NOT EXISTS auth_manual_recovery(hash TEXT PRIMARY KEY,case_id TEXT NOT NULL UNIQUE REFERENCES auth_cases(id) ON DELETE CASCADE,account_id TEXT NOT NULL REFERENCES auth_accounts(id) ON DELETE CASCADE,version INTEGER NOT NULL,approver_id TEXT NOT NULL,maker_version INTEGER NOT NULL,approver_version INTEGER NOT NULL,active INTEGER NOT NULL,expires INTEGER NOT NULL);CREATE INDEX IF NOT EXISTS auth_manual_recovery_expiry ON auth_manual_recovery(expires);');
        db.exec('CREATE TABLE IF NOT EXISTS auth_factor_recovery(account_id TEXT PRIMARY KEY REFERENCES auth_accounts(id) ON DELETE CASCADE,verification_hash TEXT NOT NULL UNIQUE,cancel_hash TEXT NOT NULL UNIQUE,browser_hash TEXT NOT NULL,version INTEGER NOT NULL,complete_after INTEGER,expires INTEGER NOT NULL);CREATE INDEX IF NOT EXISTS auth_factor_recovery_expiry ON auth_factor_recovery(expires);');
        if (!db.prepare('PRAGMA table_info(auth_sessions)').all().some(row => row.name === 'primary_method'))
            db.exec("ALTER TABLE auth_sessions ADD COLUMN primary_method TEXT NOT NULL DEFAULT 'unknown';ALTER TABLE auth_sessions ADD COLUMN primary_credential TEXT;ALTER TABLE auth_sessions ADD COLUMN mfa_authenticated_at INTEGER NOT NULL DEFAULT 0;ALTER TABLE auth_sessions ADD COLUMN mfa_version INTEGER NOT NULL DEFAULT 0;");
        db.exec('CREATE TABLE IF NOT EXISTS auth_second_factor_proofs(hash TEXT PRIMARY KEY,browser TEXT NOT NULL,account_id TEXT NOT NULL REFERENCES auth_accounts(id) ON DELETE CASCADE,version INTEGER NOT NULL,proof TEXT NOT NULL,expires INTEGER NOT NULL);CREATE INDEX IF NOT EXISTS auth_second_factor_expiry ON auth_second_factor_proofs(expires);CREATE TABLE IF NOT EXISTS auth_trusted_devices(hash TEXT PRIMARY KEY,id TEXT NOT NULL UNIQUE,account_id TEXT NOT NULL REFERENCES auth_accounts(id) ON DELETE CASCADE,version INTEGER NOT NULL,label TEXT NOT NULL,created INTEGER NOT NULL,expires INTEGER NOT NULL);CREATE INDEX IF NOT EXISTS auth_trusted_expiry ON auth_trusted_devices(expires);');
        db.exec('CREATE TABLE IF NOT EXISTS auth_admin_operations(id TEXT PRIMARY KEY,data TEXT NOT NULL,expires INTEGER NOT NULL);CREATE INDEX IF NOT EXISTS auth_admin_operations_expiry ON auth_admin_operations(expires);');
        db.exec('CREATE TABLE IF NOT EXISTS auth_method_activity(kind TEXT NOT NULL,method_id TEXT NOT NULL,account_id TEXT NOT NULL REFERENCES auth_accounts(id) ON DELETE CASCADE,added INTEGER,last_used INTEGER,PRIMARY KEY(kind,method_id));CREATE INDEX IF NOT EXISTS auth_method_activity_account ON auth_method_activity(account_id);');
        db.exec('CREATE TABLE IF NOT EXISTS auth_abuse(key TEXT PRIMARY KEY,count INTEGER NOT NULL,expires INTEGER NOT NULL,blocked_until INTEGER NOT NULL);CREATE INDEX IF NOT EXISTS auth_abuse_expiry ON auth_abuse(expires);');
        db.exec('CREATE TABLE IF NOT EXISTS auth_signups(hash TEXT PRIMARY KEY,browser TEXT NOT NULL,email TEXT NOT NULL,account_id TEXT NOT NULL,step TEXT NOT NULL,expires INTEGER NOT NULL,code_hash TEXT NOT NULL,code_expires INTEGER NOT NULL,attempts INTEGER NOT NULL,eligible INTEGER NOT NULL,invitation_hash TEXT NOT NULL,credential TEXT,challenge TEXT);CREATE INDEX IF NOT EXISTS auth_signups_expiry ON auth_signups(expires);');
        if (!db.prepare('PRAGMA table_info(auth_sessions)').all().some(row => row.name === 'recovery_enrollment'))
            db.exec('ALTER TABLE auth_sessions ADD COLUMN recovery_enrollment INTEGER NOT NULL DEFAULT 0');
        const configuration = createHash('sha256').update(JSON.stringify({ roles: Object.fromEntries(Object.keys(roles).sort().map(name => [name, [...roles[name]!].sort()])), defaultRole: options.defaultRole, registration: options.registration, ...(options.configurationTag !== undefined ? { configurationTag: options.configurationTag } : {}), ...(options.sessionTtlMs !== 86400000 || options.sessionIdleMs !== 1800000 ? { sessionLimits: { absoluteMs: options.sessionTtlMs, idleMs: options.sessionIdleMs } } : {}), ...(options.securityPolicy.allowManualRecovery || options.securityPolicy.allowPasskeySecondFactor || options.securityPolicy.trustedDeviceTtlMs || options.securityPolicy.allowEmailFactorRecovery || options.securityPolicy.requireEmailVerification || options.securityPolicy.requireMfa || options.securityPolicy.deletionGraceMs !== 604800000 ? { securityPolicy: options.securityPolicy } : {}) })).digest('hex');
        configurationRevision = transaction(() => {
            const previous = db.prepare("SELECT value FROM auth_meta WHERE key='configuration'").get()?.value;
            const currentDefinition = db.prepare("SELECT value FROM auth_meta WHERE key='configurationDefinition'").get()?.value ?? previous;
            const sameDefinition = Boolean(previous) && currentDefinition === configuration;
            let nextRevision = String(previous ?? configuration);
            const approval = options.approveConfigurationChangeFrom;
            const lastMigration = JSON.parse(String(db.prepare("SELECT value FROM auth_meta WHERE key='configurationMigration'").get()?.value ?? 'null')) as {
                from: string;
                to: string;
            } | null;
            if (approval && approval !== previous && !(sameDefinition && lastMigration?.from === approval && lastMigration.to === previous))
                error(503, 'configuration_approval_mismatch');
            if (previous && !sameDefinition) {
                nextRevision = createHash('sha256').update('urlcode-auth-configuration-v1\0' + String(previous) + '\0' + configuration).digest('hex');
                if (approval !== previous)
                    error(503, 'auth_configuration_changed');
                const priorAdministrators = num(db.prepare("SELECT count(*) AS n FROM auth_accounts WHERE administrator=1 AND status='active'").get()?.n);
                let nextAdministrators = 0;
                for (const row of db.prepare('SELECT data FROM auth_accounts').iterate()) {
                    const user = JSON.parse(String(row.data)) as AuthRecord;
                    if (!Array.isArray(user.roles) || user.roles.some(role => !Object.hasOwn(roles, role)) || !Number.isSafeInteger(user.version) || user.version >= Number.MAX_SAFE_INTEGER)
                        error(503, 'configuration_roles_invalid');
                    if (user.status === 'active' && admin(user.roles))
                        nextAdministrators++;
                }
                if (priorAdministrators > 0 && nextAdministrators === 0)
                    error(503, 'configuration_admin_required');
                const counts: Record<string, number> = {};
                for (const table of ['auth_sessions', 'auth_tokens', 'auth_flows', 'auth_email_codes', 'auth_invites', 'auth_email_changes', 'auth_waitlist', 'auth_signups', 'auth_factor_recovery', 'auth_second_factor_proofs', 'auth_trusted_devices', 'auth_manual_recovery','auth_abuse','auth_admin_operations'])
                    counts[table] = num(db.prepare('SELECT count(*) AS n FROM ' + table).get()?.n);
                const adminRoles = Object.keys(roles).filter(role => roles[role]!.includes('*'));
                const adminSql = adminRoles.length ? "EXISTS(SELECT 1 FROM json_each(auth_accounts.data,'$.roles') WHERE value IN (" + adminRoles.map(() => '?').join(',') + '))' : '0';
                db.prepare("UPDATE auth_accounts SET data=json_set(json_remove(data,'$.totpPending','$.totpPendingUntil'),'$.version',json_extract(data,'$.version')+1),administrator=" + adminSql).run(...adminRoles);
                db.prepare("DELETE FROM auth_tokens WHERE purpose<>'cancel-deletion' OR expires<=? OR NOT EXISTS(SELECT 1 FROM auth_accounts WHERE auth_accounts.id=auth_tokens.account_id AND status='pending-delete')").run(options.configurationChangeAt);
                db.prepare("UPDATE auth_tokens SET version=(SELECT json_extract(data,'$.version') FROM auth_accounts WHERE id=auth_tokens.account_id) WHERE purpose='cancel-deletion'").run();
                const cancellationTokens = num(db.prepare('SELECT count(*) AS n FROM auth_tokens').get()?.n);
                counts.auth_tokens = (counts.auth_tokens ?? 0) - cancellationTokens;
                for (const table of ['auth_sessions', 'auth_flows', 'auth_email_codes', 'auth_invites', 'auth_email_changes', 'auth_waitlist', 'auth_signups', 'auth_factor_recovery', 'auth_second_factor_proofs', 'auth_trusted_devices', 'auth_manual_recovery','auth_abuse','auth_admin_operations'])
                    db.prepare('DELETE FROM ' + table).run();
                counts.auth_cases = Number(db.prepare("UPDATE auth_cases SET data=json_set(data,'$.status','closed') WHERE json_extract(data,'$.status')='pending'").run().changes);
                counts.auth_cases += Number(db.prepare("UPDATE auth_cases SET data=json_set(data,'$.status','closed','$.recovery.state','cancelled') WHERE json_extract(data,'$.action')='restore-access' AND json_extract(data,'$.recovery.state') IN ('delivery','ready')").run().changes);
                db.prepare("UPDATE auth_meta SET value=? WHERE key='configuration'").run(nextRevision);
                db.prepare("INSERT INTO auth_meta VALUES('configurationMigration',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify({ from: previous, to: nextRevision }));
                audit('operator', 'configuration.changed', nextRevision, options.configurationChangeAt, JSON.stringify({ from: previous, revoked: counts, preservedCancellationTokens: cancellationTokens }));
            }
            else if (!previous) {
                if (approval || num(db.prepare('SELECT count(*) AS n FROM auth_accounts').get()?.n) > 0)
                    error(503, 'configuration_approval_mismatch');
                db.prepare("INSERT INTO auth_meta VALUES('configuration',?)").run(configuration);
            }
            const cipherKey = (value: string) => value.includes('.') ? value.split('.')[0]! : 'legacy';
            const required = new Set<string>();
            for (const row of db.prepare('SELECT data FROM auth_accounts').iterate()) {
                const user = JSON.parse(String(row.data)) as AuthRecord;
                for (const value of [user.totpSecret, user.totpPending])
                    if (value)
                        required.add(cipherKey(value));
            }
            for (const row of db.prepare('SELECT data FROM auth_flows').iterate())
                required.add(cipherKey(String(row.data)));
            const known = JSON.parse(String(db.prepare("SELECT value FROM auth_meta WHERE key='encryptionKeys'").get()?.value ?? '{}')) as Record<string, string>;
            const currentActive = db.prepare("SELECT value FROM auth_meta WHERE key='activeEncryptionKey'").get()?.value;
            const usedKeys = new Set<string>(JSON.parse(String(db.prepare("SELECT value FROM auth_meta WHERE key='usedEncryptionKeys'").get()?.value ?? '[]')) as string[]);
            if (typeof currentActive === 'string')
                usedKeys.add(currentActive);
            if (currentActive && currentActive !== options.activeKey && usedKeys.has(options.activeKey))
                error(503, 'stale_encryption_key');
            for (const name of required)
                if (!options.keyFingerprints[name])
                    error(503, 'auth_configuration_changed');
            for (const [name, fingerprint] of Object.entries(options.keyFingerprints))
                if (known[name] && known[name] !== fingerprint)
                    error(503, 'auth_configuration_changed');
            db.prepare("INSERT INTO auth_meta VALUES('encryptionKeys',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify({ ...known, ...options.keyFingerprints }));
            usedKeys.add(options.activeKey);
            db.prepare("INSERT INTO auth_meta VALUES('usedEncryptionKeys',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify([...usedKeys]));
            db.prepare("INSERT INTO auth_meta VALUES('activeEncryptionKey',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(options.activeKey);
            db.prepare("INSERT INTO auth_meta VALUES('configurationDefinition',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(configuration);
            return nextRevision;
        });
        initializing = false;
        port.postMessage({ ready: true });
    }
    catch (e) {
        port.postMessage({ error: e instanceof AuthError ? e.code : 'auth_store_unavailable' });
        port.close();
    }
    port.on('message', ({ id, operation, args }: {
        id: number;
        operation: string;
        args: Record<string, unknown>;
    }) => {
        try {
            db.exec('BEGIN IMMEDIATE');
            dispatchTransaction = true;
            if (db.prepare("SELECT value FROM auth_meta WHERE key='configuration'").get()?.value !== configurationRevision)
                error(503, 'stale_auth_configuration');
            if (db.prepare("SELECT value FROM auth_meta WHERE key='activeEncryptionKey'").get()?.value !== options.activeKey)
                error(503, 'stale_encryption_key');
            const now = Number(args.now);
            let value: unknown;
            const manual=manualRecoveryOperation(operation,args,{db,now,enabled:options.securityPolicy.allowManualRecovery===true,account,active,fresh,authorizeCase,save,addSession,audit,isAdministrator:user=>admin(user.roles),isRestricted:restricted,fail:error});
            const abuse=abuseOperation(operation,args,db,options.securityPolicy.abuse,error);
            const administration=adminAccountOperation(operation,args,{db,now,deletionGraceMs:options.securityPolicy.deletionGraceMs,roles:options.roles,account,fresh,isRestricted:restricted,save,audit,fail:error});
            if(manual)value=manual.value;else if(abuse)value=abuse.value;else if(administration)value=administration.value;else switch (operation) {
                case 'factorRecoveryBegin': {
                    if (!options.securityPolicy.allowEmailFactorRecovery)
                        error(403, 'factor_recovery_disabled');
                    db.prepare('DELETE FROM auth_factor_recovery WHERE account_id IN (SELECT account_id FROM auth_factor_recovery WHERE expires<=? LIMIT 1000)').run(now);
                    const user = decode(db.prepare('SELECT data FROM auth_accounts WHERE email=?').get(String(args.email)));
                    if (!user || user.status !== 'active' || !user.emailVerified || (!user.totpSecret && !passkeyFactor(user) && !user.mfaRecoveryRequired)) {
                        value = false;
                        break;
                    }
                    if (db.prepare('SELECT account_id FROM auth_factor_recovery WHERE account_id=?').get(user.id)) {
                        value = false;
                        break;
                    }
                    if (num(db.prepare('SELECT count(*) AS n FROM auth_factor_recovery').get()?.n) >= 10000)
                        error(503, 'auth_capacity_reached');
                    db.prepare('INSERT INTO auth_factor_recovery VALUES(?,?,?,?,?,NULL,?)').run(user.id, String(args.verification), String(args.cancellation), String(args.browser), user.version, now + 172800000);
                    audit(user.id, 'factor_recovery.requested', user.id, now);
                    value = true;
                    break;
                }
                case 'factorRecoveryConfirm': {
                    if (!options.securityPolicy.allowEmailFactorRecovery)
                        error(403, 'factor_recovery_disabled');
                    const row = db.prepare('SELECT * FROM auth_factor_recovery WHERE verification_hash=? AND browser_hash=? AND expires>?').get(String(args.verification), String(args.browser), now);
                    if (!row)
                        error(400, 'invalid_recovery_token');
                    const user = active(String(row!.account_id));
                    if (user.version !== row!.version || !user.emailVerified || (!user.totpSecret && !passkeyFactor(user) && !user.mfaRecoveryRequired))
                        error(409, 'recovery_account_changed');
                    const completeAfter = row!.complete_after === null ? now + 86400000 : num(row!.complete_after), expires = row!.complete_after === null ? now + 172800000 : num(row!.expires);
                    db.prepare('UPDATE auth_factor_recovery SET complete_after=?,expires=? WHERE account_id=?').run(completeAfter, expires, user.id);
                    audit(user.id, 'factor_recovery.email_proved', user.id, now);
                    value = { completeAfter, expires };
                    break;
                }
                case 'factorRecoveryCancel': {
                    if (!options.securityPolicy.allowEmailFactorRecovery)
                        error(403, 'factor_recovery_disabled');
                    const row = db.prepare('SELECT account_id FROM auth_factor_recovery WHERE cancel_hash=? AND expires>?').get(String(args.cancellation), now);
                    if (!row)
                        error(400, 'invalid_recovery_token');
                    db.prepare('DELETE FROM auth_factor_recovery WHERE account_id=?').run(String(row!.account_id));
                    audit(String(row!.account_id), 'factor_recovery.cancelled', String(row!.account_id), now);
                    value = true;
                    break;
                }
                case 'factorRecoveryComplete': {
                    if (!options.securityPolicy.allowEmailFactorRecovery)
                        error(403, 'factor_recovery_disabled');
                    const row = db.prepare('SELECT * FROM auth_factor_recovery WHERE verification_hash=? AND browser_hash=? AND expires>?').get(String(args.verification), String(args.browser), now);
                    if (!row)
                        error(400, 'invalid_recovery_token');
                    if (row!.complete_after === null || num(row!.complete_after) > now)
                        error(409, 'factor_recovery_cooldown');
                    const user = active(String(row!.account_id));
                    if (user.version !== row!.version || !user.emailVerified || (!user.totpSecret && !passkeyFactor(user) && !user.mfaRecoveryRequired))
                        error(409, 'recovery_account_changed');
                    delete user.totpSecret;
                    delete user.mfaPasskeys;
                    delete user.totpPending;
                    delete user.totpPendingUntil;
                    user.totpCounter = -1;
                    user.mfaRecoveryRequired = true;
                    user.version++;
                    save(user);
                    for (const table of ['auth_sessions', 'auth_tokens', 'auth_recovery', 'auth_email_codes', 'auth_email_changes', 'auth_factor_recovery'])
                        db.prepare('DELETE FROM ' + table + ' WHERE account_id=?').run(user.id);
                    const sessionValue = { ...args.session as unknown as SessionRecord, accountId: user.id, recoveryEnrollment: 1 };
                    addSession(sessionValue);
                    audit(user.id, 'factor_recovery.enrollment_required', user.id, now);
                    value = user;
                    break;
                }
                case 'configurationRevision':
                    value = configurationRevision;
                    break;
                case 'account':
                    value = account(String(args.id));
                    break;
                case 'email':
                    value = decode(db.prepare('SELECT data FROM auth_accounts WHERE email=?').get(String(args.email)));
                    break;
                case 'authenticate':
                    value = transaction(() => {
                        const found = session(String(args.hash), now);
                        if (found && now - Number(found.session.lastSeen) >= Math.min(60000, options.sessionIdleMs / 4))
                            db.prepare('UPDATE auth_sessions SET last_seen=? WHERE hash=?').run(now, String(args.hash));
                        return found;
                    });
                    break;
                case 'attempt': {
                    // `limit`/`windowMs` let callers run several independent budgets (a tight
                    // per-client+email ceiling alongside a much higher per-email-only ceiling for
                    // distributed guessing, or a long-window per-account cap) through this one
                    // counter primitive instead of a single fixed ceiling shared by everything.
                    const limit = Number.isSafeInteger(args.limit) && Number(args.limit) > 0 ? Number(args.limit) : 10, windowMs = Number.isSafeInteger(args.windowMs) && Number(args.windowMs) > 0 ? Number(args.windowMs) : 900000;
                    value = transaction(() => {
                        db.prepare('DELETE FROM auth_attempts WHERE key IN (SELECT key FROM auth_attempts WHERE expires<=? LIMIT 1000)').run(now);
                        const prior = db.prepare('SELECT count FROM auth_attempts WHERE key=? AND expires>?').get(String(args.key), now);
                        if (prior && num(prior.count) >= limit)
                            error(429, 'authentication_rate_limited');
                        if (!prior && num(db.prepare('SELECT count(*) AS n FROM auth_attempts').get()?.n) >= 100000)
                            error(503, 'auth_capacity_reached');
                        db.prepare('INSERT INTO auth_attempts VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET count=CASE WHEN expires<=? THEN 1 ELSE count+1 END,expires=CASE WHEN expires<=? THEN ? ELSE expires END').run(String(args.key), now + windowMs, now, now, now + windowMs);
                        return true;
                    });
                    break;
                }
                case 'factorProof': {
                    if (!options.securityPolicy.allowPasskeySecondFactor)
                        error(403, 'second_factor_unavailable');
                    const proof = args.proof as {
                        credentialId: string;
                    }, row = db.prepare('SELECT account_id FROM auth_passkeys WHERE id=?').get(proof.credentialId);
                    if (!row)
                        error(401, 'invalid_second_factor');
                    const user = active(String(row!.account_id));
                    passkeyProof(user, proof, false);
                    db.prepare('DELETE FROM auth_second_factor_proofs WHERE hash IN (SELECT hash FROM auth_second_factor_proofs WHERE expires<=? LIMIT 1000)').run(now);
                    if (num(db.prepare('SELECT count(*) AS n FROM auth_second_factor_proofs').get()?.n) >= 10000)
                        error(503, 'auth_capacity_reached');
                    db.prepare('INSERT INTO auth_second_factor_proofs VALUES(?,?,?,?,?,?)').run(String(args.hash), String(args.browser), user.id, user.version, JSON.stringify(proof), now + 300000);
                    value = true;
                    break;
                }
                case 'setPasskeyFactor': {
                    if (!options.securityPolicy.allowPasskeySecondFactor)
                        error(403, 'second_factor_unavailable');
                    const found = args.enabled ? fresh(String(args.hash), now, true) : realMfa(String(args.hash), now), user = found.user;
                    if (!db.prepare('SELECT id FROM auth_passkeys WHERE id=? AND account_id=?').get(String(args.credentialId), user.id))
                        error(404, 'sign_in_method_not_found');
                    if (args.enabled) {
                        if ((!found.session.primaryMethod || found.session.primaryMethod === 'unknown') && !found.session.recoveryEnrollment || found.session.primaryCredentialId === args.credentialId)
                            error(401, 'independent_second_factor_required');
                        takeSecondFactor(user, { ...args, session: found.session }, now, String(args.credentialId));
                        user.mfaPasskeys = [...new Set([...(user.mfaPasskeys ?? []), String(args.credentialId)])];
                        delete user.mfaRecoveryRequired;
                    }
                    else {
                        if (options.securityPolicy.requireMfa && !user.totpSecret && user.mfaPasskeys?.length === 1 && user.mfaPasskeys.includes(String(args.credentialId)))
                            error(409, 'last_required_factor');
                        user.mfaPasskeys = (user.mfaPasskeys ?? []).filter(id => id !== args.credentialId);
                    }
                    user.version++;
                    save(user);
                    db.prepare('DELETE FROM auth_sessions WHERE account_id=? AND hash<>?').run(user.id, String(args.hash));
                    db.prepare('UPDATE auth_sessions SET mfa_authenticated_at=?,mfa_version=?,recovery_enrollment=0 WHERE hash=?').run(now, user.version, String(args.hash));
                    audit(user.id, args.enabled ? 'passkey.factor_enabled' : 'passkey.factor_disabled', user.id, now);
                    value = true;
                    break;
                }
                case 'rememberDevice': {
                    if (!options.securityPolicy.trustedDeviceTtlMs)
                        error(403, 'trusted_device_unavailable');
                    const { user } = realMfa(String(args.hash), now);
                    if (!user.totpSecret && !passkeyFactor(user))
                        error(403, 'second_factor_required');
                    if (Number(args.expires) > now + options.securityPolicy.trustedDeviceTtlMs! || Number(args.expires) <= now)
                        error(400, 'invalid_trusted_device');
                    db.prepare('DELETE FROM auth_trusted_devices WHERE account_id=? AND (expires<=? OR version<>?)').run(user.id, now, user.version);
                    if (num(db.prepare('SELECT count(*) AS n FROM auth_trusted_devices WHERE account_id=?').get(user.id)?.n) >= 20)
                        error(409, 'trusted_device_limit');
                    db.prepare('INSERT INTO auth_trusted_devices VALUES(?,?,?,?,?,?,?)').run(String(args.deviceHash), String(args.deviceId), user.id, user.version, String(args.label), now, Number(args.expires));
                    audit(user.id, 'device.trusted', String(args.deviceId), now);
                    value = true;
                    break;
                }
                case 'trustedDevices': {
                    const found = session(String(args.hash), now);
                    if (!found || found.session.impersonatorId)
                        error(401, 'invalid_credentials');
                    value = db.prepare('SELECT id,label,created,expires FROM auth_trusted_devices WHERE account_id=? AND version=? AND expires>? ORDER BY created DESC LIMIT 20').all(found!.user.id, found!.user.version, now);
                    break;
                }
                case 'revokeTrustedDevice': {
                    const { user } = realMfa(String(args.hash), now);
                    db.prepare('DELETE FROM auth_trusted_devices WHERE id=? AND account_id=?').run(String(args.deviceId), user.id);
                    audit(user.id, 'device.trust_revoked', String(args.deviceId), now);
                    value = true;
                    break;
                }
                case 'signupBegin': {
                    db.prepare('DELETE FROM auth_signups WHERE hash IN (SELECT hash FROM auth_signups WHERE expires<=? LIMIT 1000)').run(now);
                    if (num(db.prepare('SELECT count(*) AS n FROM auth_signups').get()?.n) >= 10000)
                        error(503, 'auth_capacity_reached');
                    const existing = Boolean(db.prepare('SELECT id FROM auth_accounts WHERE email=?').get(String(args.email)));
                    const eligible = Boolean(args.eligible) && (options.registration.mode !== 'invite-only' || Boolean(db.prepare('SELECT hash FROM auth_invites WHERE hash=? AND email=? AND expires>?').get(String(args.invitationHash), String(args.email), now)));
                    db.prepare('INSERT INTO auth_signups VALUES(?,?,?,?,?,?,?,?,0,?,?,NULL,NULL)').run(String(args.hash), String(args.browser), String(args.email), String(args.accountId), String(args.step), Number(args.expires), String(args.codeHash), now + 600000, Number(eligible && !existing), String(args.invitationHash));
                    value = { existing, eligible };
                    break;
                }
                case 'signupRead':
                    value = db.prepare('SELECT account_id,email,step,expires,challenge FROM auth_signups WHERE hash=? AND browser=? AND expires>?').get(String(args.hash), String(args.browser), now) ?? null;
                    break;
                case 'signupVerify': {
                    const row = db.prepare("SELECT * FROM auth_signups WHERE hash=? AND browser=? AND expires>? AND step='verify-email' AND code_expires>? AND attempts<5").get(String(args.hash), String(args.browser), now, now);
                    value = null;
                    if (row) {
                        db.prepare('UPDATE auth_signups SET attempts=attempts+1 WHERE hash=?').run(String(args.hash));
                        if (row.code_hash === args.codeHash) {
                            db.prepare("UPDATE auth_signups SET step='credential',code_hash='' WHERE hash=?").run(String(args.hash));
                            value = { ...row, step: 'credential' };
                        }
                    }
                    break;
                }
                case 'signupChallenge': {
                    const result = db.prepare("UPDATE auth_signups SET challenge=? WHERE hash=? AND browser=? AND expires>? AND step='credential'").run(String(args.challenge), String(args.hash), String(args.browser), now);
                    if (!result.changes)
                        error(400, 'invalid_signup_flow');
                    value = true;
                    break;
                }
                case 'signupCredential': {
                    const row = db.prepare("SELECT * FROM auth_signups WHERE hash=? AND browser=? AND expires>? AND step='credential'").get(String(args.hash), String(args.browser), now);
                    if (!row || args.credential && (!row.challenge || row.challenge !== args.challenge))
                        error(400, 'invalid_signup_flow');
                    const credential = args.credential ? { passkey: args.credential } : { passwordHash: args.passwordHash };
                    db.prepare("UPDATE auth_signups SET step='profile',credential=?,challenge=NULL WHERE hash=?").run(JSON.stringify(credential), String(args.hash));
                    value = true;
                    break;
                }
                case 'signupComplete': {
                    const row = db.prepare("SELECT * FROM auth_signups WHERE hash=? AND browser=? AND expires>? AND step='profile'").get(String(args.hash), String(args.browser), now);
                    if (!row)
                        error(400, 'invalid_signup_flow');
                    db.prepare('DELETE FROM auth_signups WHERE hash=?').run(String(args.hash));
                    if (!row!.eligible || db.prepare('SELECT id FROM auth_accounts WHERE email=?').get(String(row!.email))) {
                        value = null;
                        break;
                    }
                    const credential = JSON.parse(String(row!.credential));
                    if (options.registration.mode === 'waitlist') {
                        if (db.prepare('SELECT id FROM auth_waitlist WHERE email=?').get(String(row!.email))) {
                            value = null;
                            break;
                        }
                        if (num(db.prepare('SELECT count(*) AS n FROM auth_waitlist').get()?.n) >= 10000)
                            error(503, 'auth_capacity_reached');
                        db.prepare('INSERT INTO auth_waitlist(id,email,password_hash,created,profile,email_verified,passkey) VALUES(?,?,?,?,?,?,?)').run(String(row!.account_id), String(row!.email), credential.passwordHash ?? '', now, JSON.stringify(args.profile), Number(options.securityPolicy.requireEmailVerification), credential.passkey ? JSON.stringify(credential.passkey) : null);
                        audit('anonymous', 'registration.requested', String(row!.account_id), now);
                        value = null;
                        break;
                    }
                    if (num(db.prepare('SELECT count(*) AS n FROM auth_accounts').get()?.n) >= 100000)
                        error(503, 'auth_capacity_reached');
                    if (options.registration.mode === 'invite-only' && db.prepare('DELETE FROM auth_invites WHERE hash=? AND email=? AND expires>?').run(String(row!.invitation_hash), String(row!.email), now).changes !== 1)
                        error(403, 'registration_unavailable');
                    const user: AuthRecord = { id: String(row!.account_id), email: String(row!.email), emailVerified: options.securityPolicy.requireEmailVerification, status: 'active', roles: [options.defaultRole], created: now, passwordHash: credential.passwordHash ?? '', version: 1, totpCounter: -1, profile: args.profile as unknown as RegistrationProfile };
                    db.prepare('INSERT INTO auth_accounts VALUES(?,?,?,?,?)').run(user.id, user.email, user.status, 0, JSON.stringify(user));
                    if (credential.passkey) {
                        const passkey = credential.passkey;
                        if (db.prepare('SELECT id FROM auth_passkeys WHERE id=?').get(passkey.id))
                            error(409, 'credential_already_registered');
                        db.prepare('INSERT INTO auth_passkeys VALUES(?,?,?,?)').run(passkey.id, user.id, JSON.stringify(passkey), passkey.counter);
                        methodActivity('passkey', String(passkey.id), user.id, now, true);
                    }
                    if (credential.passkey)
                        Object.assign(args.session!, { primaryMethod: 'passkey', primaryCredentialId: credential.passkey.id });
                    if ((args.session as unknown as SessionRecord).accountId !== user.id)
                        error(400, 'invalid_signup_flow');
                    const newDevice = addSession(args.session as unknown as SessionRecord);
                    audit(user.id, 'account.register', user.id, now);
                    value = { ...user, ...(newDevice ? { newDevice: true } : {}) };
                    break;
                }
                case 'create':
                    value = transaction(() => {
                        if (args.bootstrap && num(db.prepare('SELECT count(*) AS n FROM auth_accounts').get()?.n) !== 0)
                            error(409, 'bootstrap_unavailable');
                        if (num(db.prepare('SELECT count(*) AS n FROM auth_accounts').get()?.n) >= 100000)
                            error(503, 'auth_capacity_reached');
                        const user = args.user as unknown as AuthRecord;
                        if (args.invitationHash) {
                            const invite = db.prepare('DELETE FROM auth_invites WHERE hash=? AND email=? AND expires>?').run(String(args.invitationHash), user.email, now);
                            if (invite.changes !== 1)
                                error(403, 'registration_unavailable');
                        }
                        if (db.prepare('SELECT id FROM auth_accounts WHERE email=?').get(user.email)) {
                            // Do not tell the caller the address is taken (JSON-API.md's
                            // no-enumeration guarantee): report the attempt without creating a
                            // second account, and let the caller build an identically shaped
                            // response backed by an unpersisted session (auth-core.ts `create`).
                            audit('anonymous', 'registration.duplicate', user.email, now);
                            return null;
                        }
                        db.prepare('INSERT INTO auth_accounts VALUES(?,?,?,?,?)').run(user.id, user.email, user.status, Number(admin(user.roles)), JSON.stringify(user));
                        const newDevice = addSession(args.session as unknown as SessionRecord);
                        audit(user.id, args.bootstrap ? 'admin.bootstrap' : 'account.register', user.id, now);
                        return { ...user, ...(typeof newDevice !== 'undefined' && newDevice ? { newDevice: true } : {}) };
                    });
                    break;
                case 'login':
                    value = transaction(() => {
                        const user = active(String(args.accountId));
                        if(args.abuseKey&&db.prepare('SELECT key FROM auth_abuse WHERE key=? AND blocked_until>? AND expires>?').get(String(args.abuseKey),now,now))error(429,'auth_backoff');
                        if (args.proof) {
                            const proof = args.proof as {
                                kind: string;
                                version: number;
                                provider?: string;
                                subject?: string;
                                credentialId?: string;
                                publicKeyHash?: string;
                                expectedCounter?: number;
                                newCounter?: number;
                            };
                            if (user.version !== proof.version)
                                error(401, 'stale_auth_proof');
                            if (proof.kind === 'oidc') {
                                methodActivity('oidc',String(proof.provider)+'\0'+String(proof.subject),user.id,now);
                                if (!db.prepare('SELECT account_id FROM auth_external WHERE provider=? AND subject=? AND account_id=?').get(String(proof.provider), String(proof.subject), user.id))
                                    error(401, 'stale_auth_proof');
                            }
                            else if (proof.kind === 'passkey') {
                                methodActivity('passkey',String(proof.credentialId),user.id,now);
                                const credential = db.prepare('SELECT data,counter FROM auth_passkeys WHERE id=? AND account_id=?').get(String(proof.credentialId), user.id);
                                if (!credential || num(credential.counter) !== proof.expectedCounter || createHash('sha256').update(String(JSON.parse(String(credential.data)).publicKey)).digest('hex') !== proof.publicKeyHash)
                                    error(401, 'stale_auth_proof');
                                db.prepare('UPDATE auth_passkeys SET counter=? WHERE id=? AND account_id=? AND counter=?').run(Number(proof.newCounter), String(proof.credentialId), user.id, Number(proof.expectedCounter));
                            }
                            else
                                error(400, 'invalid_auth_proof');
                        }
                        if (args.oldHash) {
                            const previous = session(String(args.oldHash), now);
                            if (previous?.session.recoveryEnrollment)
                                (args.session as unknown as SessionRecord).recoveryEnrollment = 1;
                            if (!previous || previous.user.id !== user.id || previous.session.impersonatorId)
                                error(401, 'invalid_credentials');
                        }
                        if (user.version !== args.version || user.passwordHash !== args.passwordHash)
                            error(401, 'invalid_credentials');
                        const actualMfa = consumeFactor(user, args, now);
                        if (args.upgradedHash) {
                            user.passwordHash = String(args.upgradedHash);
                            user.version++;
                            save(user);
                        }
                        if (args.oldHash)
                            db.prepare('DELETE FROM auth_sessions WHERE hash=? AND account_id=?').run(String(args.oldHash), user.id);
                        if (actualMfa)
                            Object.assign(args.session!, { mfaAuthenticatedAt: now, mfaVersion: user.version });
                        const newDevice = addSession(args.session as unknown as SessionRecord);
                        for (const key of (args.attemptKeys as string[] | undefined) ?? (args.attemptKey ? [String(args.attemptKey)] : []))
                            db.prepare('DELETE FROM auth_attempts WHERE key=?').run(key);
                        if(args.abuseKey)db.prepare('DELETE FROM auth_abuse WHERE key=?').run(String(args.abuseKey));
                        audit(user.id, args.oldHash ? 'session.step_up' : 'session.login', user.id, now);
                        if (!args.oldHash)
                            metric('success', args.proof ? String((args.proof as {
                                kind: string;
                            }).kind) : 'password', now);
                        return { ...user, ...(typeof newDevice !== 'undefined' && newDevice ? { newDevice: true } : {}) };
                    });
                    break;
                case 'logout':
                    value = transaction(() => {
                        const found = session(String(args.hash), now);
                        db.prepare('DELETE FROM auth_sessions WHERE hash=?').run(String(args.hash));
                        if (found)
                            audit(found.session.impersonatorId ?? found.user.id, 'session.logout', found.session.id, now);
                        return true;
                    });
                    break;
                case 'revoke':
                    value = transaction(() => {
                        const user = account(String(args.accountId));
                        if (user) {
                            user.version++;
                            save(user);
                        }
                        db.prepare('DELETE FROM auth_sessions WHERE account_id=?').run(String(args.accountId));
                        audit(String(args.accountId), 'session.revoke_all', String(args.accountId), now);
                        return true;
                    });
                    break;
                case 'issueToken':
                    value = transaction(() => {
                        const user = decode(db.prepare('SELECT data FROM auth_accounts WHERE email=?').get(String(args.email)));
                        if (!user || user.status !== 'active')
                            return false;
                        db.prepare('DELETE FROM auth_tokens WHERE hash IN (SELECT hash FROM auth_tokens WHERE expires<=? LIMIT 1000)').run(now);
                        db.prepare('DELETE FROM auth_tokens WHERE account_id=? AND purpose=?').run(user.id, String(args.purpose));
                        db.prepare('INSERT INTO auth_tokens VALUES(?,?,?,?,?)').run(String(args.hash), user.id, String(args.purpose), now + 1800000, user.version);
                        audit(user.id, 'token.issue', String(args.purpose), now);
                        return true;
                    });
                    break;
                case 'consumeToken':
                    value = transaction(() => {
                        const token = db.prepare('SELECT * FROM auth_tokens WHERE hash=? AND purpose=? AND expires>?').get(String(args.hash), String(args.purpose), now);
                        if (!token)
                            error(400, 'invalid_token');
                        const user = active(String(token!.account_id));
                        if (user.version !== token!.version)
                            error(400, 'invalid_token');
                        db.prepare('DELETE FROM auth_tokens WHERE hash=?').run(String(args.hash));
                        let claimed = false;
                        if (args.purpose === 'verify-email') {
                            // A verifier presenting a live session of this same account is
                            // the party that established its pre-verification methods, so
                            // verification keeps them. Any other verifier claims the account.
                            const holder = !user.emailVerified && args.sessionHash ? session(String(args.sessionHash), now) : null;
                            if (!user.emailVerified && !(holder && holder.user.id === user.id && !holder.session.impersonatorId)) {
                                claimMailbox(user, 'verify-email', now, true);
                                claimed = true;
                            }
                            user.emailVerified = true;
                            if (options.securityPolicy.requireEmailVerification)
                                db.prepare('DELETE FROM auth_sessions WHERE account_id=?').run(user.id);
                        }
                        else {
                            if (!user.emailVerified)
                                claimMailbox(user, 'password-reset', now, true);
                            user.passwordHash = String(args.passwordHash);
                            db.prepare('DELETE FROM auth_abuse WHERE key=?').run(abuseKey('password',user.email));
                            db.prepare('DELETE FROM auth_attempts WHERE key=?').run(createHash('sha256').update('urlcode-auth-attempt:login:'+user.email).digest('hex'));
                            db.prepare('DELETE FROM auth_sessions WHERE account_id=?').run(user.id);
                        }
                        user.version++;
                        save(user);
                        audit(user.id, args.purpose === 'verify-email' ? 'email.verified' : 'password.reset', user.id, now);
                        return claimed ? { ...user, mailboxClaimed: true } : user;
                    });
                    break;
                case 'totpBegin':
                    value = transaction(() => {
                        const { user } = fresh(String(args.hash), now, true);
                        if (user.totpSecret)
                            error(409, 'totp_already_enabled');
                        user.totpPending = String(args.secret);
                        user.totpPendingUntil = now + 600000;
                        user.version++;
                        save(user);
                        audit(user.id, 'totp.begin', user.id, now);
                        return user;
                    });
                    break;
                case 'totpConfirm':
                    value = transaction(() => {
                        const { user } = fresh(String(args.hash), now, true);
                        if (user.version !== args.version || !user.totpPending || !user.totpPendingUntil || user.totpPendingUntil <= now)
                            error(400, 'invalid_totp_setup');
                        user.totpSecret = user.totpPending!;
                        delete user.mfaRecoveryRequired;
                        delete user.totpPending;
                        delete user.totpPendingUntil;
                        user.totpCounter = Number(args.counter);
                        user.version++;
                        save(user);
                        db.prepare('DELETE FROM auth_recovery WHERE account_id=?').run(user.id);
                        for (const hash of args.recoveryHashes as string[])
                            db.prepare('INSERT INTO auth_recovery VALUES(?,?)').run(hash, user.id);
                        db.prepare('DELETE FROM auth_sessions WHERE account_id=? AND hash<>?').run(user.id, String(args.hash));
                        db.prepare('UPDATE auth_sessions SET mfa_authenticated_at=?,mfa_version=? WHERE hash=?').run(now, user.version, String(args.hash));
                        audit(user.id, 'totp.enabled', user.id, now);
                        return true;
                    });
                    break;
                case 'totpDisable':
                    value = transaction(() => {
                        const { user } = fresh(String(args.hash), now);
                        if (user.version !== args.version || !user.totpSecret)
                            error(401, 'invalid_credentials');
                        consumeFactor(user, args, now);
                        delete user.totpSecret;
                        user.totpCounter = -1;
                        user.version++;
                        save(user);
                        db.prepare('DELETE FROM auth_recovery WHERE account_id=?').run(user.id);
                        db.prepare('DELETE FROM auth_sessions WHERE account_id=? AND hash<>?').run(user.id, String(args.hash));
                        audit(user.id, 'totp.disabled', user.id, now);
                        return true;
                    });
                    break;
                case 'admin':
                    value = transaction(() => {
                        const actor = fresh(String(args.hash), now).user, target = account(String(args.accountId));
                        if (!target)
                            error(404, 'account_not_found');
                        if (target!.status === 'pending-delete')
                            error(409, 'account_pending_deletion');
                        const actorPermissions = permissions(actor.roles);
                        if (!actorPermissions.includes('*') && !actorPermissions.includes('auth.users.manage'))
                            error(403, 'permission_denied');
                        if (actor.id === target!.id)
                            error(403, 'self_administration_denied');
                        const nextRoles = (args.roles as string[] | undefined) || target!.roles;
                        for (const p of [...permissions(target!.roles), ...permissions(nextRoles)])
                            if (!actorPermissions.includes('*') && !actorPermissions.includes(p))
                                error(403, 'delegation_ceiling_exceeded');
                        const nextStatus = (args.status as 'active' | 'locked' | undefined) || target!.status;
                        if (admin(target!.roles) && target!.status === 'active' && (!admin(nextRoles) || nextStatus !== 'active') && num(db.prepare("SELECT count(*) AS n FROM auth_accounts WHERE administrator=1 AND status='active'").get()?.n) <= 1)
                            error(409, 'last_administrator_required');
                        target!.roles = nextRoles;
                        target!.status = nextStatus;
                        target!.version++;
                        save(target!);
                        db.prepare('DELETE FROM auth_sessions WHERE account_id=?').run(target!.id);
                        audit(actor.id, args.roles ? 'admin.roles' : 'admin.status', target!.id, now, String(args.reason || ''));
                        return target;
                    });
                    break;
                case 'adminRevoke':
                    value = transaction(() => {
                        const actor = fresh(String(args.hash), now).user, p = permissions(actor.roles);
                        if (!p.includes('*') && !p.includes('auth.sessions.manage'))
                            error(403, 'permission_denied');
                        const target = account(String(args.accountId));
                        if (!target)
                            error(404, 'account_not_found');
                        for (const permission of permissions(target!.roles))
                            if (!p.includes('*') && !p.includes(permission))
                                error(403, 'delegation_ceiling_exceeded');
                        target!.version++;
                        save(target!);
                        db.prepare('DELETE FROM auth_sessions WHERE account_id=?').run(target!.id);
                        audit(actor.id, 'admin.sessions.revoke', target!.id, now, String(args.reason || ''));
                        return true;
                    });
                    break;
                case 'putFlow':
                    value = transaction(() => {
                        db.prepare('DELETE FROM auth_flows WHERE id IN (SELECT id FROM auth_flows WHERE expires<=? LIMIT 1000)').run(now);
                        if (num(db.prepare('SELECT count(*) AS n FROM auth_flows').get()?.n) >= 10000)
                            error(503, 'auth_capacity_reached');
                        db.prepare('INSERT INTO auth_flows VALUES(?,?,?,?)').run(String(args.id), String(args.kind), String(args.data), Number(args.expires));
                        return true;
                    });
                    break;
                case 'consumeFlow':
                    value = transaction(() => {
                        const row = db.prepare('SELECT data FROM auth_flows WHERE id=? AND kind=? AND expires>?').get(String(args.id), String(args.kind), now);
                        if (!row)
                            return null;
                        db.prepare('DELETE FROM auth_flows WHERE id=?').run(String(args.id));
                        return row.data;
                    });
                    break;
                // Read-only counterpart to `consumeFlow`, used to check the browser binding
                // before spending the flow (see auth-flows.ts): a request from the wrong browser
                // must not burn a flow the right browser still needs.
                case 'peekFlow': {
                    const row = db.prepare('SELECT data FROM auth_flows WHERE id=? AND kind=? AND expires>?').get(String(args.id), String(args.kind), now);
                    value = row ? row.data : null;
                    break;
                }
                case 'external': {
                    const row = db.prepare('SELECT account_id FROM auth_external WHERE provider=? AND subject=?').get(String(args.provider), String(args.subject));
                    value = row ? account(String(row.account_id)) : null;
                    break;
                }
                case 'linkExternal':
                    value = transaction(() => {
                        const { user } = fresh(String(args.hash), now);
                        if (num(db.prepare('SELECT count(*) AS n FROM auth_external WHERE account_id=?').get(user.id)?.n) >= 16)
                            error(409, 'credential_limit');
                        if (db.prepare('SELECT account_id FROM auth_external WHERE provider=? AND subject=?').get(String(args.provider), String(args.subject)))
                            error(409, 'identity_already_linked');
                        db.prepare('INSERT INTO auth_external VALUES(?,?,?)').run(String(args.provider), String(args.subject), user.id);
                        methodActivity('oidc', String(args.provider)+'\0'+String(args.subject), user.id, now, true);
                        user.version++;
                        save(user);
                        audit(user.id, 'identity.linked', user.id, now);
                        return true;
                    });
                    break;
                case 'createExternal':
                    value = transaction(() => {
                        const user = args.user as unknown as AuthRecord;
                        if (num(db.prepare('SELECT count(*) AS n FROM auth_accounts').get()?.n) >= 100000)
                            error(503, 'auth_capacity_reached');
                        if (db.prepare('SELECT id FROM auth_accounts WHERE email=?').get(user.email))
                            error(409, 'explicit_identity_link_required');
                        if (db.prepare('SELECT account_id FROM auth_external WHERE provider=? AND subject=?').get(String(args.provider), String(args.subject)))
                            error(409, 'identity_already_linked');
                        db.prepare('INSERT INTO auth_accounts VALUES(?,?,?,?,?)').run(user.id, user.email, user.status, 0, JSON.stringify(user));
                        db.prepare('INSERT INTO auth_external VALUES(?,?,?)').run(String(args.provider), String(args.subject), user.id);
                        methodActivity('oidc', String(args.provider)+'\0'+String(args.subject), user.id, now, true);
                        audit(user.id, 'account.external_register', user.id, now);
                        return user;
                    });
                    break;
                case 'addPasskey':
                    value = transaction(() => {
                        const { user } = fresh(String(args.hash), now, true), credential = args.credential as Record<string, unknown>;
                        if (num(db.prepare('SELECT count(*) AS n FROM auth_passkeys WHERE account_id=?').get(user.id)?.n) >= 16)
                            error(409, 'credential_limit');
                        if (db.prepare('SELECT id FROM auth_passkeys WHERE id=?').get(String(credential.id)))
                            error(409, 'credential_already_registered');
                        db.prepare('INSERT INTO auth_passkeys VALUES(?,?,?,?)').run(String(credential.id), user.id, JSON.stringify(credential), Number(credential.counter));
                        methodActivity('passkey', String(credential.id), user.id, now, true);
                        user.version++;
                        save(user);
                        audit(user.id, 'passkey.added', user.id, now);
                        return true;
                    });
                    break;
                case 'getPasskey': {
                    const row = db.prepare('SELECT * FROM auth_passkeys WHERE id=?').get(String(args.id));
                    const owner = row ? account(String(row.account_id)) : null;
                    value = row && owner ? { accountId: String(row.account_id), credential: { ...JSON.parse(String(row.data)), counter: Number(row.counter) }, proof: { kind: 'passkey', version: owner.version, credentialId: String(row.id), publicKeyHash: createHash('sha256').update(String(JSON.parse(String(row.data)).publicKey)).digest('hex'), expectedCounter: Number(row.counter) } } : null;
                    break;
                }
                case 'listPasskeys':
                    value = db.prepare('SELECT data,counter FROM auth_passkeys WHERE account_id=? LIMIT 16').all(String(args.accountId)).map(row => ({ ...JSON.parse(String(row.data)), counter: Number(row.counter), secondFactor: Boolean(options.securityPolicy.allowPasskeySecondFactor && account(String(args.accountId))?.mfaPasskeys?.includes(String(JSON.parse(String(row.data)).id))) }));
                    break;
                case 'updateProfile':
                    value = transaction(() => {
                        const { user } = fresh(String(args.hash), now);
                        if (user.version !== args.version)
                            error(409, 'account_changed');
                        user.profile = args.profile as unknown as RegistrationProfile;
                        user.version++;
                        save(user);
                        audit(user.id, 'profile.updated', user.id, now);
                        return true;
                    });
                    break;
                case 'impersonate':
                    value = transaction(() => {
                        const actor = fresh(String(args.hash), now).user, target = active(String(args.accountId)), p = permissions(actor.roles);
                        if (!options.registration.allowImpersonation || actor.id === target.id || !p.includes('*') && !p.includes('auth.users.impersonate') || permissions(target.roles).some(permission => permission === '*' || permission.startsWith('auth.') || permission.startsWith('admin.')))
                            error(403, 'impersonation_denied');
                        const issued = { ...args.session as unknown as SessionRecord, impersonatorId: actor.id, actorVersion: actor.version };
                        addSession(issued);
                        audit(actor.id, 'impersonation.started', target.id, now, String(args.reason));
                        return { user: target, session: issued };
                    });
                    break;
                case 'createCase':
                    value = transaction(() => {
                        const actor = fresh(String(args.hash), now).user, target = account(String(args.accountId));
                        if (!target)
                            error(404, 'account_not_found');
                        authorizeCase(actor, target!, args.roles as string[] | undefined);
                        if (num(db.prepare('SELECT count(*) AS n FROM auth_cases').get()?.n) >= 10000)
                            error(503, 'auth_capacity_reached');
                        const item = { id: String(args.id), accountId: target!.id, action: String(args.action), ...(args.roles ? { roles: args.roles } : {}), reason: String(args.reason), makerId: actor.id, status: 'pending', created: now, expires: now + 3600000, targetVersion: target!.version };
                        db.prepare('INSERT INTO auth_cases VALUES(?,?)').run(item.id, JSON.stringify(item));
                        audit(actor.id, 'case.created', target!.id, now, String(args.reason));
                        return item;
                    });
                    break;
                case 'case': {
                    const row = db.prepare('SELECT data FROM auth_cases WHERE id=?').get(String(args.id));
                    value = row ? JSON.parse(String(row.data)) : null;
                    break;
                }
                case 'cases':
                    value = db.prepare("SELECT data FROM auth_cases WHERE id>? AND json_extract(data,'$.action')!='restore-access' ORDER BY id LIMIT ?").all(String(args.after), Number(args.limit)).map(row => JSON.parse(String(row.data)));
                    break;
                case 'approveCase':
                    value = transaction(() => {
                        const approver = fresh(String(args.hash), now).user, row = db.prepare('SELECT data FROM auth_cases WHERE id=?').get(String(args.id));
                        if (!row)
                            error(404, 'case_not_found');
                        const item = JSON.parse(String(row!.data)) as {
                            id: string;
                            accountId: string;
                            action: string;
                            roles?: string[];
                            makerId: string;
                            approverId?: string;
                            status: string;
                            expires: number;
                            targetVersion: number;
                        };
                        if(item.action==='restore-access')error(400,'recovery_approval_required');
                        if (item.status !== 'pending' || item.expires <= now)
                            error(409, 'case_unavailable');
                        if (item.makerId === approver.id)
                            error(403, 'distinct_approver_required');
                        const maker = active(item.makerId), target = account(item.accountId);
                        if (!target || target.version !== item.targetVersion)
                            error(409, 'case_target_changed');
                        authorizeCase(maker, target!, item.roles);
                        authorizeCase(approver, target!, item.roles);
                        const nextRoles = item.action === 'roles' ? item.roles! : target!.roles, nextStatus = item.action === 'lock' ? 'locked' : item.action === 'unlock' ? 'active' : target!.status;
                        if (admin(target!.roles) && target!.status === 'active' && (!admin(nextRoles) || nextStatus !== 'active') && num(db.prepare("SELECT count(*) AS n FROM auth_accounts WHERE administrator=1 AND status='active'").get()?.n) <= 1)
                            error(409, 'last_administrator_required');
                        if (item.action === 'reset-factors') {
                            if (!target!.passwordHash && num(db.prepare('SELECT count(*) AS n FROM auth_external WHERE account_id=?').get(target!.id)?.n) === 0 && num(db.prepare('SELECT count(*) AS n FROM auth_passkeys WHERE account_id=?').get(target!.id)?.n) > 0)
                                error(409, 'last_sign_in_method');
                            delete target!.totpSecret;
                            delete target!.mfaPasskeys;
                            delete target!.totpPending;
                            delete target!.totpPendingUntil;
                            target!.totpCounter = -1;
                            db.prepare('DELETE FROM auth_recovery WHERE account_id=?').run(target!.id);
                            db.prepare('DELETE FROM auth_passkeys WHERE account_id=?').run(target!.id);
                            db.prepare("DELETE FROM auth_method_activity WHERE kind='passkey' AND account_id=?").run(target!.id);
                        }
                        target!.roles = nextRoles;
                        target!.status = nextStatus;
                        target!.version++;
                        save(target!);
                        db.prepare('DELETE FROM auth_sessions WHERE account_id=?').run(target!.id);
                        item.status = 'applied';
                        item.approverId = approver.id;
                        db.prepare('UPDATE auth_cases SET data=? WHERE id=?').run(JSON.stringify(item), item.id);
                        audit(approver.id, 'case.approved', target!.id, now, String(args.reason));
                        audit(maker.id, 'case.executed', target!.id, now, item.id);
                        return item;
                    });
                    break;
                case 'importUsers':
                    value = transaction(() => {
                        const users = args.users as unknown as AuthRecord[];
                        if (num(db.prepare('SELECT count(*) AS n FROM auth_accounts').get()?.n) + users.length > 100000)
                            error(503, 'auth_capacity_reached');
                        const seen = new Set<string>();
                        for (const user of users) {
                            if (seen.has(user.email) || db.prepare('SELECT id FROM auth_accounts WHERE email=?').get(user.email))
                                error(409, 'import_collision');
                            seen.add(user.email);
                        }
                        for (const user of users)
                            db.prepare('INSERT INTO auth_accounts VALUES(?,?,?,?,?)').run(user.id, user.email, user.status, 0, JSON.stringify(user));
                        audit('operator', 'accounts.imported', String(users.length), now);
                        return { imported: users.length };
                    });
                    break;
                case 'invite':
                    value = transaction(() => {
                        const actor = fresh(String(args.actorHash), now).user, p = permissions(actor.roles);
                        if (!p.includes('*') && !p.includes('auth.users.create'))
                            error(403, 'permission_denied');
                        for (const permission of permissions([options.defaultRole]))
                            if (!p.includes('*') && !p.includes(permission))
                                error(403, 'delegation_ceiling_exceeded');
                        db.prepare('DELETE FROM auth_invites WHERE expires<=?').run(now);
                        if (num(db.prepare('SELECT count(*) AS n FROM auth_invites').get()?.n) >= 10000)
                            error(503, 'auth_capacity_reached');
                        db.prepare('DELETE FROM auth_invites WHERE email=?').run(String(args.email));
                        db.prepare('INSERT INTO auth_invites VALUES(?,?,?)').run(String(args.hash), String(args.email), now + 86400000);
                        audit(actor.id, 'registration.invited', String(args.email), now);
                        return true;
                    });
                    break;
                case 'requestRegistration':
                    value = transaction(() => {
                        if (num(db.prepare('SELECT count(*) AS n FROM auth_waitlist').get()?.n) >= 10000)
                            error(503, 'auth_capacity_reached');
                        // Same status/body either way (JSON-API.md's no-enumeration guarantee):
                        // an address already on the list or already an account is reported as a
                        // duplicate to the caller who requested it here, but the HTTP response is
                        // identical for both outcomes (see auth.ts's `/register` waitlist branch).
                        if (db.prepare('SELECT id FROM auth_waitlist WHERE email=?').get(String(args.email)) || db.prepare('SELECT id FROM auth_accounts WHERE email=?').get(String(args.email))) {
                            audit('anonymous', 'registration.duplicate', String(args.email), now);
                            return { id: args.id, duplicate: true };
                        }
                        db.prepare('INSERT INTO auth_waitlist(id,email,password_hash,created,profile) VALUES(?,?,?,?,?)').run(String(args.id), String(args.email), String(args.passwordHash), now, args.profile ? JSON.stringify(args.profile) : null);
                        return { id: args.id, duplicate: false };
                    });
                    break;
                case 'registrationRequests':
                    value = db.prepare('SELECT id,email,created FROM auth_waitlist WHERE id>? ORDER BY id LIMIT ?').all(String(args.after), Number(args.limit));
                    break;
                case 'approveRegistration':
                    value = transaction(() => {
                        const actor = fresh(String(args.hash), now).user, p = permissions(actor.roles);
                        if (!p.includes('*') && !p.includes('auth.users.manage'))
                            error(403, 'permission_denied');
                        for (const permission of permissions([options.defaultRole]))
                            if (!p.includes('*') && !p.includes(permission))
                                error(403, 'delegation_ceiling_exceeded');
                        const request = db.prepare('SELECT * FROM auth_waitlist WHERE id=?').get(String(args.requestId));
                        if (!request)
                            error(404, 'registration_request_not_found');
                        if (num(db.prepare('SELECT count(*) AS n FROM auth_accounts').get()?.n) >= 100000)
                            error(503, 'auth_capacity_reached');
                        const user: AuthRecord = { id: String(request!.id), email: String(request!.email), emailVerified: Boolean(request!.email_verified), status: 'active', roles: [options.defaultRole], created: now, passwordHash: String(request!.password_hash), version: 1, totpCounter: -1, ...(request!.profile ? { profile: JSON.parse(String(request!.profile)) as RegistrationProfile } : {}) };
                        if (db.prepare('SELECT id FROM auth_accounts WHERE email=?').get(user.email))
                            error(409, 'registration_unavailable');
                        db.prepare('INSERT INTO auth_accounts VALUES(?,?,?,?,?)').run(user.id, user.email, user.status, 0, JSON.stringify(user));
                        if (request!.passkey) {
                            const passkey = JSON.parse(String(request!.passkey));
                            if (db.prepare('SELECT id FROM auth_passkeys WHERE id=?').get(passkey.id))
                                error(409, 'credential_already_registered');
                            db.prepare('INSERT INTO auth_passkeys VALUES(?,?,?,?)').run(passkey.id, user.id, JSON.stringify(passkey), passkey.counter);
                        methodActivity('passkey', String(passkey.id), user.id, now, true);
                        }
                        db.prepare('DELETE FROM auth_waitlist WHERE id=?').run(user.id);
                        audit(actor.id, 'registration.approved', user.id, now, String(args.reason || ''));
                        return user;
                    });
                    break;
                case 'rotationRows': {
                    const rows: {
                        type: string;
                        id: string;
                        field: string;
                        value: string;
                        context: string;
                    }[] = [];
                    const prefix = String(args.activeKey) + '.';
                    for (const row of db.prepare('SELECT id,data FROM auth_accounts').iterate()) {
                        const user = JSON.parse(String(row.data)) as AuthRecord;
                        for (const field of ['totpSecret', 'totpPending'] as const) {
                            const value = user[field];
                            if (value && !value.startsWith(prefix) && rows.length < 100)
                                rows.push({ type: 'account', id: user.id, field, value, context: 'totp:' + user.id });
                        }
                        if (rows.length >= 100)
                            break;
                    }
                    if (rows.length < 100)
                        for (const row of db.prepare('SELECT id,kind,data FROM auth_flows WHERE substr(data,1,?)<>? LIMIT ?').all(prefix.length, prefix, 100 - rows.length))
                            rows.push({ type: 'flow', id: String(row.id), field: 'data', value: String(row.data), context: 'flow:' + row.id + ':' + row.kind });
                    value = rows;
                    break;
                }
                case 'rotationApply':
                    value = transaction(() => {
                        let changed = 0;
                        for (const row of args.replacements as {
                            type: string;
                            id: string;
                            field: 'totpSecret' | 'totpPending';
                            value: string;
                            replacement: string;
                        }[]) {
                            if (row.type === 'account') {
                                const user = account(row.id);
                                if (user && user[row.field] === row.value) {
                                    user[row.field] = row.replacement;
                                    save(user);
                                    changed++;
                                }
                            }
                            else
                                changed += Number(db.prepare('UPDATE auth_flows SET data=? WHERE id=? AND data=?').run(row.replacement, row.id, row.value).changes);
                        }
                        const prefix = String(args.activeKey) + '.';
                        let remaining = 0;
                        for (const row of db.prepare('SELECT data FROM auth_accounts').iterate()) {
                            const user = JSON.parse(String(row.data)) as AuthRecord;
                            for (const field of ['totpSecret', 'totpPending'] as const)
                                if (user[field] && !user[field]!.startsWith(prefix))
                                    remaining++;
                        }
                        remaining += num(db.prepare('SELECT count(*) AS n FROM auth_flows WHERE substr(data,1,?)<>?').get(prefix.length, prefix)?.n);
                        audit('operator', 'encryption.rotated', String(changed), now);
                        return { changed, remaining };
                    });
                    break;
                case 'identities':
                    value = db.prepare('SELECT provider,subject FROM auth_external WHERE account_id=? LIMIT 16').all(String(args.accountId));
                    break;
                case 'issueEmailCode':
                    value = transaction(() => {
                        const user = decode(db.prepare('SELECT data FROM auth_accounts WHERE email=?').get(String(args.email)));
                        if (!user || user.status !== 'active')
                            return false;
                        db.prepare('DELETE FROM auth_email_codes WHERE account_id=?').run(user.id);
                        db.prepare('INSERT INTO auth_email_codes VALUES(?,?,?,?,0,?)').run(String(args.hash), user.id, String(args.codeHash), now + 600000, user.version);
                        audit(user.id, 'email_code.issued', user.id, now);
                        return true;
                    });
                    break;
                case 'checkEmailCode':
                    value = transaction(() => {
                        const row = db.prepare('SELECT * FROM auth_email_codes WHERE hash=? AND expires>?').get(String(args.hash), now);
                        if (!row || num(row.attempts) >= 5)
                            return null;
                        db.prepare('UPDATE auth_email_codes SET attempts=attempts+1 WHERE hash=?').run(String(args.hash));
                        if (row.code_hash !== args.codeHash)
                            return null;
                        const user = account(String(row.account_id));
                        return user && user.status === 'active' && user.version === row.version ? user : null;
                    });
                    break;
                case 'codeLogin':
                    value = transaction(() => {
                        const row = db.prepare('SELECT * FROM auth_email_codes WHERE hash=? AND code_hash=? AND expires>? AND attempts<=5').get(String(args.hash), String(args.codeHash), now);
                        if (!row)
                            error(400, 'invalid_code');
                        const user = active(String(row!.account_id));
                        if (user.version !== args.version || user.version !== row!.version)
                            error(400, 'invalid_code');
                        // A first mailbox proof removes every factor established before it,
                        // so those factors are neither required nor accepted here.
                        const claiming = !user.emailVerified;
                        const actualMfa = claiming ? false : consumeFactor(user, args, now);
                        db.prepare('DELETE FROM auth_email_codes WHERE hash=?').run(String(args.hash));
                        if (claiming)
                            claimMailbox(user, 'email-code', now, true);
                        if (actualMfa)
                            Object.assign(args.session!, { mfaAuthenticatedAt: now, mfaVersion: user.version });
                        const newDevice = addSession(args.session as unknown as SessionRecord);
                        audit(user.id, 'session.email_login', user.id, now);
                        metric('success', 'email-code', now);
                        return { ...user, ...(typeof newDevice !== 'undefined' && newDevice ? { newDevice: true } : {}) };
                    });
                    break;
                case 'changePassword':
                    value = transaction(() => {
                        const { user } = fresh(String(args.hash), now);
                        if (user.version !== args.version)
                            error(401, 'invalid_credentials');
                        consumeFactor(user, args, now);
                        user.passwordHash = String(args.passwordHash);
                        user.version++;
                        save(user);
                        db.prepare('DELETE FROM auth_sessions WHERE account_id=?').run(user.id);
                        db.prepare('DELETE FROM auth_tokens WHERE account_id=?').run(user.id);
                        audit(user.id, 'password.changed', user.id, now);
                        return true;
                    });
                    break;
                case 'deleteAccount':
                    value = transaction(() => {
                        const { user } = fresh(String(args.hash), now);
                        if (user.version !== args.version)
                            error(401, 'invalid_credentials');
                        consumeFactor(user, args, now);
                        if (admin(user.roles) && num(db.prepare("SELECT count(*) AS n FROM auth_accounts WHERE administrator=1 AND status='active'").get()?.n) <= 1)
                            error(409, 'last_administrator_required');
                        user.status = 'pending-delete';
                        user.deleteAfter = now + options.securityPolicy.deletionGraceMs;
                        user.version++;
                        save(user);
                        db.prepare('DELETE FROM auth_sessions WHERE account_id=?').run(user.id);
                        db.prepare('DELETE FROM auth_tokens WHERE account_id=?').run(user.id);
                        db.prepare("INSERT INTO auth_tokens VALUES(?,?,'cancel-deletion',?,?)").run(String(args.cancelHash), user.id, user.deleteAfter, user.version);
                        audit(user.id, 'account.deletion_scheduled', user.id, now);
                        return { deleteAfter: user.deleteAfter };
                    });
                    break;
                case 'cancelDeletion':
                    value = transaction(() => {
                        const row = db.prepare("SELECT * FROM auth_tokens WHERE hash=? AND purpose='cancel-deletion' AND expires>?").get(String(args.hash), now);
                        if (!row)
                            error(400, 'invalid_token');
                        const user = account(String(row!.account_id));
                        if (!user || user.status !== 'pending-delete' || user.version !== row!.version)
                            error(400, 'invalid_token');
                        user!.status = 'active';
                        delete user!.deleteAfter;
                        user!.version++;
                        save(user!);
                        db.prepare('DELETE FROM auth_tokens WHERE hash=?').run(String(args.hash));
                        audit(user!.id, 'account.deletion_cancelled', user!.id, now);
                        return true;
                    });
                    break;
                case 'purgeDeleted':
                    value = transaction(() => {
                        let purged = 0;
                        const deleted: string[] = [];
                        for (const row of db.prepare("SELECT data FROM auth_accounts WHERE status='pending-delete' AND json_extract(data,'$.deleteAfter')<=? LIMIT ?").all(now, Number(args.limit))) {
                            const user = decode(row)!;
                            if (!user.deleteAfter || user.deleteAfter > now)
                                continue;
                            if (admin(user.roles) && num(db.prepare("SELECT count(*) AS n FROM auth_accounts WHERE administrator=1 AND status='active'").get()?.n) === 0)
                                continue;
                            db.prepare('DELETE FROM auth_accounts WHERE id=?').run(user.id);
                            audit('operator', 'account.deleted', user.id, now);
                            purged++;
                            deleted.push(user.id);
                        }
                        return { purged, deleted };
                    });
                    break;
                case 'users':
                    try { value = queryUsers(db, args as UserQuery); } catch { error(400, 'invalid_user_cursor_or_filter'); }
                    break;
                case 'removeMethod':
                    value = transaction(() => {
                        const { user } = fresh(String(args.hash), now);
                        const count = Number(Boolean(user.passwordHash)) + num(db.prepare('SELECT count(*) AS n FROM auth_passkeys WHERE account_id=?').get(user.id)?.n) + num(db.prepare('SELECT count(*) AS n FROM auth_external WHERE account_id=?').get(user.id)?.n);
                        if (count <= 1)
                            error(409, 'last_sign_in_method');
                        if (args.credentialId && user.mfaPasskeys?.includes(String(args.credentialId))) {
                            if (options.securityPolicy.requireMfa && !user.totpSecret && user.mfaPasskeys.length === 1)
                                error(409, 'last_required_factor');
                            user.mfaPasskeys = user.mfaPasskeys.filter(id => id !== args.credentialId);
                        }
                        if (!user.passwordHash && !user.totpSecret && user.mfaPasskeys?.length) {
                            const keys = db.prepare('SELECT id FROM auth_passkeys WHERE account_id=?').all(user.id).map(row => String(row.id)).filter(id => id !== args.credentialId);
                            const external = db.prepare('SELECT provider,subject FROM auth_external WHERE account_id=?').all(user.id).filter(row => row.provider !== args.provider || row.subject !== args.subject);
                            if (!external.length && !keys.some(primary => user.mfaPasskeys!.some(factor => factor !== primary && keys.includes(factor))))
                                error(409, 'last_sign_in_method');
                        }
                        const removed = args.credentialId ? db.prepare('DELETE FROM auth_passkeys WHERE id=? AND account_id=?').run(String(args.credentialId), user.id) : db.prepare('DELETE FROM auth_external WHERE provider=? AND subject=? AND account_id=?').run(String(args.provider), String(args.subject), user.id);
                        if (removed.changes !== 1)
                            error(404, 'sign_in_method_not_found');
                        db.prepare('DELETE FROM auth_method_activity WHERE kind=? AND method_id=? AND account_id=?').run(args.credentialId?'passkey':'oidc',args.credentialId?String(args.credentialId):String(args.provider)+'\0'+String(args.subject),user.id);
                        user.version++;
                        save(user);
                        db.prepare('DELETE FROM auth_sessions WHERE account_id=? AND hash<>?').run(user.id, String(args.hash));
                        audit(user.id, args.credentialId ? 'passkey.removed' : 'identity.unlinked', user.id, now);
                        return true;
                    });
                    break;
                case 'caseEdit':
                    value = transaction(() => {
                        const actor = fresh(String(args.hash), now).user, row = db.prepare('SELECT data FROM auth_cases WHERE id=?').get(String(args.id));
                        if (!row)
                            error(404, 'case_not_found');
                        const item = JSON.parse(String(row!.data)) as {
                            accountId: string;
                            action?:string;recovery?:{state:string};
                            status: string;
                            roles?: string[];
                            notes?: {
                                actorId: string;
                                note: string;
                                created: number;
                            }[];
                        };
                        const target = account(item.accountId);
                        if (!target)
                            error(404, 'account_not_found');
                        authorizeCase(actor, target!, item.roles);
                        if (item.status !== 'pending'&&!(item.action==='restore-access'&&item.status==='applied'&&['delivery','ready'].includes(item.recovery?.state??'')))
                            error(409, 'case_unavailable');
                        if (args.close){
                            item.status = 'closed';if(item.action==='restore-access'&&item.recovery){item.recovery.state='cancelled';db.prepare('DELETE FROM auth_manual_recovery WHERE case_id=?').run(String(args.id));}
                        }
                        else {
                            if ((item.notes?.length ?? 0) >= 20)
                                error(409, 'case_note_limit');
                            item.notes = [...(item.notes ?? []), { actorId: actor.id, note: String(args.reason), created: now }];
                        }
                        db.prepare('UPDATE auth_cases SET data=? WHERE id=?').run(JSON.stringify(item), String(args.id));
                        audit(actor.id, args.close ? 'case.closed' : 'case.note_added', item.accountId, now, String(args.reason));
                        return item;
                    });
                    break;
                case 'cleanup':
                    value = transaction(() => {
                        let remaining = Number(args.limit), removed = 0;
                        for (const [table, predicate, params] of [['auth_sessions', 'expires<=? OR last_seen<=?', [now, now - options.sessionIdleMs]], ['auth_tokens', 'expires<=?', [now]], ['auth_flows', 'expires<=?', [now]], ['auth_signups', 'expires<=?', [now]], ['auth_second_factor_proofs', 'expires<=?', [now]], ['auth_trusted_devices', 'expires<=?', [now]], ['auth_factor_recovery', 'expires<=?', [now]], ['auth_manual_recovery', 'expires<=?', [now]], ['auth_email_codes', 'expires<=?', [now]], ['auth_email_changes', 'expires<=?', [now]], ['auth_invites', 'expires<=?', [now]], ['auth_attempts', 'expires<=?', [now]], ['auth_abuse','expires<=?',[now]], ['auth_admin_operations','expires<=?',[now]], ['auth_cases', "json_extract(data,'$.expires')<=?", [now - 2592000000]]] as [
                            string,
                            string,
                            number[]
                        ][]) {
                            if (remaining <= 0)
                                break;
                            const changed = Number(db.prepare('DELETE FROM ' + table + ' WHERE rowid IN (SELECT rowid FROM ' + table + ' WHERE ' + predicate + ' LIMIT ?)').run(...params, remaining).changes);
                            removed += changed;
                            remaining -= changed;
                        }
                        return { removed };
                    });
                    break;
                case 'requestEmailChange':
                    value = transaction(() => {
                        const { user } = fresh(String(args.hash), now);
                        if (user.version !== args.version)
                            error(409, 'account_changed');
                        // The second factor is consumed before anything about the requested email
                        // is disclosed (including whether it is already taken): otherwise a signed-
                        // in caller could probe address availability without ever supplying a valid
                        // second-factor proof.
                        consumeFactor(user, args, now);
                        if (user.email === args.email)
                            error(400, 'email_unchanged');
                        if (db.prepare('SELECT account_id FROM auth_email_changes WHERE account_id=? AND expires>?').get(user.id, now))
                            error(409, 'email_change_pending');
                        if (db.prepare('SELECT id FROM auth_accounts WHERE email=?').get(String(args.email)))
                            error(409, 'email_unavailable');
                        db.prepare('DELETE FROM auth_email_changes WHERE account_id=?').run(user.id);
                        db.prepare('INSERT INTO auth_email_changes VALUES(?,?,?,?,?,?,?)').run(user.id, String(args.email), String(args.verificationHash), String(args.cancelHash), now + 86400000, now + 172800000, user.version);
                        audit(user.id, 'email.change_requested', user.id, now);
                        return true;
                    });
                    break;
                case 'confirmEmailChange':
                    value = transaction(() => {
                        const row = db.prepare('SELECT * FROM auth_email_changes WHERE verification_hash=? AND expires>?').get(String(args.hash), now);
                        if (!row)
                            error(400, 'invalid_token');
                        if (num(row!.activate_after) > now)
                            error(409, 'email_change_cooldown');
                        const user = active(String(row!.account_id));
                        if (user.version !== row!.version)
                            error(409, 'account_changed');
                        if (db.prepare('SELECT id FROM auth_accounts WHERE email=?').get(String(row!.email)))
                            error(409, 'email_unavailable');
                        user.email = String(row!.email);
                        user.emailVerified = true;
                        user.version++;
                        db.prepare('UPDATE auth_accounts SET email=? WHERE id=?').run(user.email, user.id);
                        save(user);
                        db.prepare('DELETE FROM auth_sessions WHERE account_id=?').run(user.id);
                        db.prepare('DELETE FROM auth_tokens WHERE account_id=?').run(user.id);
                        db.prepare('DELETE FROM auth_email_codes WHERE account_id=?').run(user.id);
                        db.prepare('DELETE FROM auth_email_changes WHERE account_id=?').run(user.id);
                        audit(user.id, 'email.changed', user.id, now);
                        return user;
                    });
                    break;
                case 'cancelEmailChange':
                    value = transaction(() => {
                        const row = db.prepare('SELECT account_id FROM auth_email_changes WHERE cancel_hash=? AND expires>?').get(String(args.hash), now);
                        if (!row)
                            error(400, 'invalid_token');
                        db.prepare('DELETE FROM auth_email_changes WHERE account_id=?').run(String(row!.account_id));
                        audit(String(row!.account_id), 'email.change_cancelled', String(row!.account_id), now);
                        return true;
                    });
                    break;
                case 'adminCreateUser':
                    value = transaction(() => {
                        const actor = fresh(String(args.hash), now).user, p = permissions(actor.roles);
                        if (!p.includes('*') && !p.includes('auth.users.create'))
                            error(403, 'permission_denied');
                        for (const permission of permissions([options.defaultRole]))
                            if (!p.includes('*') && !p.includes(permission))
                                error(403, 'delegation_ceiling_exceeded');
                        const user = args.user as unknown as AuthRecord;
                        if (num(db.prepare('SELECT count(*) AS n FROM auth_accounts').get()?.n) >= 100000)
                            error(503, 'auth_capacity_reached');
                        if (db.prepare('SELECT id FROM auth_accounts WHERE email=?').get(user.email))
                            error(409, 'registration_unavailable');
                        db.prepare('INSERT INTO auth_accounts VALUES(?,?,?,?,?)').run(user.id, user.email, user.status, 0, JSON.stringify(user));
                        db.prepare("INSERT INTO auth_tokens VALUES(?,?,'reset-password',?,?)").run(String(args.setupHash), user.id, now + 1800000, user.version);
                        audit(actor.id, 'admin.account_created', user.id, now, String(args.reason));
                        return user;
                    });
                    break;
                case 'revokeSession':
                    value = transaction(() => {
                        const actor = fresh(String(args.hash), now).user, row = db.prepare('SELECT account_id FROM auth_sessions WHERE id=?').get(String(args.sessionId));
                        if (!row)
                            error(404, 'session_not_found');
                        const target = account(String(row!.account_id))!;
                        if (args.admin) {
                            const p = permissions(actor.roles);
                            if (!p.includes('*') && !p.includes('auth.sessions.manage'))
                                error(403, 'permission_denied');
                            for (const permission of permissions(target.roles))
                                if (!p.includes('*') && !p.includes(permission))
                                    error(403, 'delegation_ceiling_exceeded');
                        }
                        else if (target.id !== actor.id)
                            error(403, 'permission_denied');
                        db.prepare('DELETE FROM auth_sessions WHERE id=?').run(String(args.sessionId));
                        audit(actor.id, args.admin ? 'admin.session_revoked' : 'session.revoked', target.id, now, String(args.reason ?? ''));
                        return true;
                    });
                    break;
                case 'adminAddNote': {
                    const actor = fresh(String(args.hash), now).user, target = account(String(args.accountId));
                    if (!target) error(404, 'account_not_found');
                    const granted = permissions(actor.roles);
                    if (!granted.includes('*') && !granted.includes('auth.users.manage')) error(403, 'permission_denied');
                    for (const permission of permissions(target!.roles)) if (!granted.includes('*') && !granted.includes(permission)) error(403, 'delegation_ceiling_exceeded');
                    audit(actor.id, 'admin.note', target!.id, now, String(args.reason));
                    value = true;
                    break;
                }
                case 'adminReveal': {
                    const actor = fresh(String(args.hash), now).user, target = account(String(args.accountId));
                    if (!target) error(404, 'account_not_found');
                    const granted = permissions(actor.roles);
                    if (!granted.includes('*') && (!granted.includes('auth.users.read') || !granted.includes('auth.users.reveal'))) error(403, 'permission_denied');
                    for (const permission of permissions(target!.roles)) if (!granted.includes('*') && !granted.includes(permission)) error(403, 'delegation_ceiling_exceeded');
                    audit(actor.id, 'admin.identifier_revealed', target!.id, now, String(args.reason));
                    value = { id: target!.id, email: target!.email };
                    break;
                }
                case 'adminExport':
                    value = transaction(() => {
                        const actor = fresh(String(args.hash), now).user, target = account(String(args.accountId));
                        if (!target)
                            error(404, 'account_not_found');
                        const p = permissions(actor.roles);
                        if (!p.includes('*') && !p.includes('auth.users.export'))
                            error(403, 'permission_denied');
                        for (const permission of permissions(target!.roles))
                            if (!p.includes('*') && !p.includes(permission))
                                error(403, 'delegation_ceiling_exceeded');
                        audit(actor.id, 'admin.account_exported', target!.id, now, String(args.reason));
                        return { user: target, sessions: db.prepare('SELECT id,created,authenticated_at AS authenticatedAt,expires,last_seen AS lastSeen,device_label AS deviceLabel FROM auth_sessions WHERE account_id=? AND expires>? AND last_seen>? LIMIT 20').all(target!.id, now, now - options.sessionIdleMs), identities: db.prepare('SELECT provider,subject FROM auth_external WHERE account_id=? LIMIT 16').all(target!.id) };
                    });
                    break;
                case 'signInFailure':
                    value = transaction(() => { metric('failure', String(args.method), now); return true; });
                    break;
                case 'adminBulk':
                    value = transaction(() => {
                        const actor = fresh(String(args.hash), now).user, p = permissions(actor.roles), action = String(args.action);
                        if (!p.includes('*') && !p.includes(action === 'revoke-sessions' ? 'auth.sessions.manage' : 'auth.users.manage'))
                            error(403, 'permission_denied');
                        const targets = (args.accountIds as string[]).map(account);
                        for (const target of targets) {
                            if (!target)
                                error(404, 'account_not_found');
                            if (target!.id === actor.id)
                                error(403, 'self_administration_denied');
                            if (target!.status === 'pending-delete')
                                error(409, 'account_pending_deletion');
                            for (const permission of permissions(target!.roles))
                                if (!p.includes('*') && !p.includes(permission))
                                    error(403, 'delegation_ceiling_exceeded');
                        }
                        if (action === 'lock') {
                            const remaining = num(db.prepare("SELECT count(*) AS n FROM auth_accounts WHERE administrator=1 AND status='active'").get()?.n) - targets.filter(target => target!.status === 'active' && admin(target!.roles)).length;
                            if (remaining < 1 && targets.some(target => target!.status === 'active' && admin(target!.roles)))
                                error(409, 'last_administrator_required');
                        }
                        for (const target of targets) {
                            if (action !== 'revoke-sessions')
                                target!.status = action === 'lock' ? 'locked' : 'active';
                            target!.version++;
                            save(target!);
                            db.prepare('DELETE FROM auth_sessions WHERE account_id=?').run(target!.id);
                            audit(actor.id, 'admin.bulk.' + action, target!.id, now, String(args.reason));
                        }
                        return { affected: targets.length };
                    });
                    break;
                case 'dashboard': {
                    const counts = db.prepare("SELECT count(*) AS users,coalesce(sum(status='active'),0) AS active,coalesce(sum(status='locked'),0) AS locked,coalesce(sum(status='pending-delete'),0) AS pendingDeletion FROM auth_accounts").get()!;
                    const firstDay = Math.floor(now / 86400000) - 29;
                    const daily = Array.from({ length: 30 }, (_, offset) => ({ day: new Date((firstDay + offset) * 86400000).toISOString().slice(0, 10), signUps: 0, signIns: 0, failedSignIns: 0, methods: [] as {
                            method: string;
                            signUps: number;
                            signIns: number;
                            failedSignIns: number;
                        }[] }));
                    for (const row of db.prepare("SELECT day,method,sum(CASE WHEN event='signup' THEN count ELSE 0 END) AS signUps,sum(CASE WHEN event='success' THEN count ELSE 0 END) AS signIns,sum(CASE WHEN event='failure' THEN count ELSE 0 END) AS failedSignIns FROM auth_daily_metrics WHERE day>=? AND day<=? GROUP BY day,method ORDER BY day,method LIMIT 150").all(firstDay, firstDay + 29)) {
                        const bucket = daily[num(row.day) - firstDay]!;
                        const method = { method: String(row.method), signUps: num(row.signUps), signIns: num(row.signIns), failedSignIns: num(row.failedSignIns) };
                        bucket.signUps += method.signUps;
                        bucket.signIns += method.signIns;
                        bucket.failedSignIns += method.failedSignIns;
                        bucket.methods.push(method);
                    }
                    value = { ...counts, daily, sessions: num(db.prepare('SELECT count(*) AS n FROM auth_sessions WHERE expires>? AND last_seen>?').get(now, now - options.sessionIdleMs)?.n), waitlist: num(db.prepare('SELECT count(*) AS n FROM auth_waitlist').get()?.n) };
                    break;
                }
                case 'allSessions':
                    value = db.prepare(`SELECT s.id,s.account_id AS accountId,a.email,s.created,s.authenticated_at AS authenticatedAt,s.expires,s.last_seen AS lastSeen,s.device_label AS deviceLabel FROM auth_sessions s JOIN auth_accounts a ON a.id=s.account_id WHERE s.id>? AND s.expires>? AND s.last_seen>? AND (?='' OR s.account_id=?) AND instr(lower(COALESCE(s.device_label,'')),lower(?))>0 AND s.created>=? AND s.created<=? ORDER BY s.id LIMIT ?`).all(String(args.after), now, now - options.sessionIdleMs, String(args.accountId), String(args.accountId), String(args.device), Number(args.createdFrom), Number(args.createdTo), Number(args.limit));
                    break;
                case 'devices':
                    value = db.prepare('SELECT hash AS id,label,last_seen AS lastSeen FROM auth_devices WHERE account_id=? ORDER BY last_seen DESC LIMIT 20').all(String(args.accountId));
                    break;
                case 'sessions':
                    value = db.prepare('SELECT id,created,authenticated_at AS authenticatedAt,expires,last_seen AS lastSeen,device_label AS deviceLabel FROM auth_sessions WHERE account_id=? AND expires>? AND last_seen>? ORDER BY created DESC LIMIT 20').all(String(args.accountId), now, now - options.sessionIdleMs);
                    break;
                case 'audit':
                    value = db.prepare("SELECT id,actor,action,subject,created,reason FROM auth_audit WHERE id>? AND (?='' OR actor=?) AND (?='' OR subject=?) AND (?='' OR action=?) AND created>=? AND created<=? ORDER BY id LIMIT ?").all(Number(args.after || 0), String(args.actor), String(args.actor), String(args.subject), String(args.subject), String(args.action), String(args.action), Number(args.from), Number(args.to), Number(args.limit));
                    break;
                default: error(400, 'unsupported_auth_operation');
            }
            db.exec('COMMIT');
            dispatchTransaction = false;
            port.postMessage({ id, value });
        }
        catch (e) {
            if (dispatchTransaction) {
                try {
                    db.exec('ROLLBACK');
                }
                catch { /* Closed database remains unavailable. */ }
                dispatchTransaction = false;
            }
            port.postMessage({ id, error: { status: e instanceof AuthError ? e.status : 503, code: e instanceof AuthError ? e.code : 'auth_store_unavailable' } });
        }
    });
}
