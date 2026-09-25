import { fork } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtemp, mkdir, writeFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { AuthService, AuthSecurityPolicy } from './auth-core.ts';

interface BaselineCheck { name: string; passed: boolean; }
interface AuthBaselineResult {
    passed: boolean;
    scope: 'offline-synthetic-runtime';
    checks: BaselineCheck[];
    liveProviders: 'unverified';
    limitations: string[];
}
const limitations = ['Synthetic local probes are not an independent security assessment or deployment certification.', 'No network, live provider, mail delivery, browser, load or recovery drill is exercised.', 'These fixtures do not inspect an operator deployment, password-breach callback or SMS policy.'];
const result = (checks: BaselineCheck[]): AuthBaselineResult => ({ passed: checks.length > 0 && checks.every(item => item.passed), scope: 'offline-synthetic-runtime', checks, liveProviders: 'unverified', limitations: [...limitations] });

/** Fixed synthetic fixtures only; the deadline also bounds broken runtime startup. */
export async function runAuthBaseline(options: { timeoutMs?: number; temporaryDirectory?: string } = {}): Promise<AuthBaselineResult> {
    const timeoutMs = options.timeoutMs ?? 30000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60000) throw new Error('Invalid baseline deadline');
    const root = await mkdtemp(join(options.temporaryDirectory ?? tmpdir(), 'urlcode-auth-baseline-'));
    let child: ChildProcess | undefined;
    try {
        await chmod(root, 0o700);
        return await new Promise<AuthBaselineResult>(resolve => {
            let finished = false;
            const finish = (value: AuthBaselineResult) => { if (finished) return; finished = true; clearTimeout(timer); resolve(value); };
            const timer = setTimeout(() => finish(result([{ name: 'baseline.completed-within-deadline', passed: false }])), timeoutMs);
            try {
                child = fork(fileURLToPath(import.meta.url), [root], { env: { URLCODE_AUTH_BASELINE_CHILD: '1' }, execArgv: ['--max-old-space-size=256', ...process.execArgv.filter(value => value.startsWith('--conditions='))], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
                // Fixed probes must not surface guest/runtime diagnostics as credential-bearing output.
                child.stdout?.resume(); child.stderr?.resume();
                child.once('message', (message: AuthBaselineResult) => finish(message));
                child.once('error', () => finish(result([{ name: 'baseline.process-completed', passed: false }])));
                child.once('exit', () => { if (!finished) finish(result([{ name: 'baseline.process-completed', passed: false }])); });
            } catch { finish(result([{ name: 'baseline.process-started', passed: false }])); }
        });
    } finally {
        if (child && child.exitCode === null && child.signalCode === null) {
            const exited = new Promise<void>(resolve => child!.once('exit', () => resolve()));
            child.kill('SIGKILL');
            await exited;
        }
        await rm(root, { recursive: true, force: true });
    }
}

/** Checks the already-loaded trusted service; no account mutation or migration is requested. */
export async function validateAuthService(service: AuthService): Promise<{ passed: boolean; checks: BaselineCheck[]; revision: string; registration: string; security: AuthSecurityPolicy; roles: { count: number; permissionCount: number }; liveProviders: 'unverified' }> {
    const revision = await service.getConfigurationRevision(), registration = service.getRegistrationMode(), value = service.getSecurityPolicy(), roles = service.getRoles();
    const checks: BaselineCheck[] = [
        { name: 'configuration.revision', passed: typeof revision === 'string' && /^[a-f0-9]{64}$/.test(revision) },
        { name: 'configuration.registration', passed: ['open', 'invite-only', 'waitlist', 'off'].includes(registration) },
        { name: 'configuration.security-policy', passed: Boolean(value && typeof value.requireEmailVerification === 'boolean' && typeof value.requireMfa === 'boolean' && Number.isSafeInteger(value.deletionGraceMs) && value.deletionGraceMs >= 86400000 && value.deletionGraceMs <= 2592000000 && (value.trustedDeviceTtlMs === undefined || Number.isSafeInteger(value.trustedDeviceTtlMs) && value.trustedDeviceTtlMs >= 60000 && value.trustedDeviceTtlMs <= 2592000000) && [value.allowPasskeySecondFactor, value.allowEmailFactorRecovery, value.allowManualRecovery].every(flag => flag === undefined || flag === true)) },
    ];
    const entries = roles && typeof roles === 'object' && !Array.isArray(roles) ? Object.entries(roles) : [];
    checks.push({ name: 'configuration.roles', passed: entries.length > 0 && entries.length <= 64 && entries.every(([name, permissions]) => /^[a-z][a-z0-9_-]{0,63}$/.test(name) && Array.isArray(permissions) && permissions.length <= 128 && permissions.every(permission => typeof permission === 'string' && /^\*$|^[a-z][a-z0-9_.:-]{0,127}$/.test(permission))) });
    checks.push({ name: 'configuration.revision-stable', passed: await service.getConfigurationRevision() === revision });
    // Explicit allowlist: arbitrary operator callback properties never become diagnostic output.
    const security: AuthSecurityPolicy = { requireEmailVerification: value.requireEmailVerification, requireMfa: value.requireMfa, deletionGraceMs: value.deletionGraceMs, ...(value.allowPasskeySecondFactor === true ? { allowPasskeySecondFactor: true } : {}), ...(value.allowEmailFactorRecovery === true ? { allowEmailFactorRecovery: true } : {}), ...(value.allowManualRecovery === true ? { allowManualRecovery: true } : {}), ...(typeof value.trustedDeviceTtlMs === 'number' ? { trustedDeviceTtlMs: value.trustedDeviceTtlMs } : {}) };
    if (!checks.every(check => check.passed)) throw new Error('Invalid operator service configuration');
    return { passed: true, checks, revision, registration, security, roles: { count: entries.length, permissionCount: new Set(entries.flatMap(([, permissions]) => permissions)).size }, liveProviders: 'unverified' };
}

async function probe(root: string): Promise<AuthBaselineResult> {
    const checks: BaselineCheck[] = [], add = (name: string, passed: boolean) => checks.push({ name, passed });
    let runtime: Awaited<ReturnType<typeof import('@jimhoyd/urlcode')['createRuntime']>> | undefined, service: AuthService | undefined;
    const companions: { close(): Promise<void> }[] = [];
    try {
        const { createRuntime } = await import('@jimhoyd/urlcode'), { inspectExtensionRevision } = await import('@jimhoyd/urlcode/extensions'), { createAuthService } = await import('./auth-core.ts'), { createAuth } = await import('./auth.ts');
        // Auth requires audit and mail: the synthetic site hosts both, mail recording instead of sending.
        const { createAudit } = await import('@jimhoyd/urlcode-audit'), { createMail, recordingTransport } = await import('@jimhoyd/urlcode-mail'), { authMail } = await import('./mail-templates.ts');
        // Account screens render only through the kit, so the synthetic project declares and registers `ui` exactly as a real host must.
        const { createUiExtension } = await import('@jimhoyd/urlcode-ui/host'), { authUiTemplates } = await import('./auth-templates.ts'), { englishCatalogue } = await import('./presentation.ts');
        const project = join(root, 'project'), operator = join(root, 'operator'), origin = 'https://baseline.invalid';
        await mkdir(project, { mode: 0o700 }); await mkdir(operator, { mode: 0o700 });
        await writeFile(join(project, 'urlcode.yaml'), JSON.stringify({ version: '1', extensions: { ui: { version: '1', config: {} }, audit: { version: '1', config: {} }, mail: { version: '1', config: {} }, auth: { version: '1', config: { registration: 'open' } } }, routes: {
            '/account/*': { extension: 'auth', methods: ['GET', 'HEAD', 'POST'] },
            '/assets/ui/*': { extension: 'ui', methods: ['GET', 'HEAD'] },
            '/protected': { respond: { json: { authorized: true } }, methods: ['GET', 'POST'], policies: { extensions: { auth: { permission: 'baseline.read' } } } },
            '/public-guest': { parameters: [{ name: 'cookie', in: 'header', schema: { type: 'string', default: 'untrusted-default' } }, { name: 'authorization', in: 'header', schema: { type: 'string' } }], function: { source: 'guest.mjs' } },
        } }), { mode: 0o600 });
        await writeFile(join(project, 'guest.mjs'), 'export default (request, context) => Response.json({ cookie: request.headers.get("cookie"), authorization: request.headers.get("authorization"), header: context.inputs.header });', { mode: 0o600 });
        const revision = await inspectExtensionRevision(project), csrfKey = randomBytes(32), encryptionKey = randomBytes(32), password = 'synthetic-baseline-' + randomBytes(16).toString('hex');
        service = await createAuthService({ database: join(operator, 'ordinary.sqlite'), encryptionKey, roles: { member: ['baseline.read'], admin: ['*'] }, defaultRole: 'member' });
        const account = await service.register({ email: 'synthetic-baseline@example.test', password });
        const ui = createUiExtension({ projectSha256: revision, projectRoot: project, sources: [englishCatalogue], extensions: [authUiTemplates] });
        const audit = await createAudit({ projectSha256: revision, database: join(operator, 'audit.sqlite') });
        companions.push(audit);
        const mail = createMail({ projectSha256: revision, site: operator, contributions: [{ from: 'auth', value: authMail }], transport: recordingTransport() });
        companions.push(mail);
        const startRuntime = () => createRuntime(project, { origin, environment: {}, workers: 1, timeoutMs: 1000, extensions: [ui.registration, audit.registration, mail.registration, createAuth({ service: service!, csrfKey, projectSha256: revision, ui, audit: audit.exports, mail: mail.exports }).registration], log: () => {} });
        runtime = await startRuntime();
        type Response = Awaited<ReturnType<typeof runtime.handle>>;
        const text = (response: Response) => typeof response.body === 'string' ? response.body : response.body ? Buffer.from(response.body).toString('utf8') : '';
        const cookies = new Map<string, string>();
        const cookieValues = (response: Response) => response.headers.filter(([name]) => name.toLowerCase() === 'set-cookie').map(([, value]) => value);
        const cookieSafe = (cookie: string) => { const parts = cookie.split(';').map(value => value.trim()), attrs = new Map(parts.slice(1).map(value => { const at = value.indexOf('='); return at < 0 ? [value.toLowerCase(), ''] : [value.slice(0, at).toLowerCase(), value.slice(at + 1)]; })); return parts[0]!.startsWith('__Host-') && attrs.has('secure') && attrs.has('httponly') && attrs.get('path') === '/' && attrs.get('samesite') === 'Strict' && !attrs.has('domain'); };
        const request = async (target: string, data?: Record<string, string>, requestOrigin = origin, extra: Record<string, string> = {}) => {
            const headers = new Headers({ accept: 'application/json', ...(cookies.size ? { cookie: [...cookies].map(([name, value]) => name + '=' + value).join('; ') } : {}), ...(data ? { 'content-type': 'application/json', origin: requestOrigin } : {}), ...extra });
            const response = await runtime!.handle({ target, origin, method: data ? 'POST' : 'GET', headers, headerCounts: Object.fromEntries([...headers].map(([name]) => [name, 1])), ...(data ? { body: Buffer.from(JSON.stringify(data)) } : {}) });
            for (const value of cookieValues(response)) { const first = value.split(';')[0]!, at = first.indexOf('='); if (value.includes('Max-Age=0')) cookies.delete(first.slice(0, at)); else cookies.set(first.slice(0, at), first.slice(at + 1)); }
            return response;
        };
        add('authorization.anonymous-protected-denied', (await request('/protected')).status === 401);
        const loginPage = await request('/account/login');
        add('response.auth-no-store', loginPage.headers.some(([name, value]) => name.toLowerCase() === 'cache-control' && value === 'no-store'));
        const initial = await request('/account/csrf'), csrf = JSON.parse(text(initial)).csrf as string;
        add('response.preauth-cookie-policy', [...cookieValues(loginPage), ...cookieValues(initial)].length > 0 && [...cookieValues(loginPage), ...cookieValues(initial)].every(cookieSafe));
        add('csrf.missing-denied', (await request('/account/login', { email: account.user.email, password })).status === 403);
        add('csrf.foreign-origin-denied', (await request('/account/login', { email: account.user.email, password, csrf }, 'https://foreign.invalid')).status === 403);
        const login = await request('/account/login', { email: account.user.email, password, csrf }), sessionToken = cookies.get('__Host-urlcode-session');
        add('authentication.password-login', login.status === 200 && typeof sessionToken === 'string');
        add('response.session-cookie-policy', cookieValues(login).some(value => value.startsWith('__Host-urlcode-session=')) && cookieValues(login).every(cookieSafe));
        add('response.credentials-withheld', !text(login).includes(password) && Boolean(sessionToken) && !text(login).includes(sessionToken!) && !/"(?:token|passwordHash|encryptionKey)"/.test(text(login)));
        const sessionCsrf = JSON.parse(text(login)).csrf as string;
        add('authorization.session-protected-allowed', (await request('/protected')).status === 200);
        add('csrf.protected-mutation-denied', (await request('/protected', {})).status === 403);
        add('csrf.protected-mutation-authorized', (await request('/protected', {}, origin, { 'x-csrf-token': sessionCsrf })).status === 200);
        const guest = await request('/public-guest', undefined, origin, { authorization: 'Bearer synthetic-baseline-bearer' }), guestValue = JSON.parse(text(guest));
        add('guest.credentials-and-derived-context-withheld', guest.status === 200 && guestValue.cookie === null && guestValue.authorization === null && JSON.stringify(guestValue.header) === '{}' && !text(guest).includes(sessionToken!) && !text(guest).includes('synthetic-baseline-bearer'));
        await service.revokeSessions(account.user.id);
        add('session.revocation-enforced', (await request('/protected')).status === 401);
        await runtime.close(); runtime = undefined; await service.close(); service = undefined;
        service = await createAuthService({ database: join(operator, 'required.sqlite'), encryptionKey, roles: { member: ['baseline.read'], admin: ['*'] }, defaultRole: 'member', requireEmailVerification: true, requireMfa: true });
        const restricted = await service.bootstrapAdmin({ email: 'synthetic-restricted@example.test', password });
        runtime = await startRuntime(); cookies.clear(); cookies.set('__Host-urlcode-session', restricted.token);
        add('enrollment.required-policies-declared', service.getSecurityPolicy().requireEmailVerification && service.getSecurityPolicy().requireMfa);
        add('enrollment.restricted-authority-withheld', restricted.principal.roles.length === 0 && restricted.principal.permissions.length === 0 && restricted.principal.restrictions?.includes('verify-email') === true && restricted.principal.restrictions.includes('enroll-mfa'));
        add('enrollment.protected-route-denied', (await request('/protected')).status === 403);
        add('enrollment.account-page-available', (await request('/account/account')).status === 200);
    } catch { add('baseline.probes-completed', false); }
    finally {
        try { await runtime?.close(); } catch { add('cleanup.runtime-closed', false); }
        try { await service?.close(); } catch { add('cleanup.service-closed', false); }
        for (const companion of companions.reverse())
            try { await companion.close(); } catch { add('cleanup.companions-closed', false); }
    }
    return result(checks);
}
if (process.env.URLCODE_AUTH_BASELINE_CHILD === '1' && process.send && process.argv[2]) {
    void probe(process.argv[2]).then(value => process.send!(value), () => process.send!(result([{ name: 'baseline.probes-completed', passed: false }])));
}
