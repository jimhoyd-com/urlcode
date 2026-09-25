/**
 * A real site for the console: the project declares ui, audit, mail, auth and admin, host.mjs composes them through
 * composeHost exactly as `urlcode extensions add admin` sets a site up, and requests go through the runtime, so auth's
 * route policy on /admin/* (session, CSRF, principal) runs before admin sees anything.
 */
import type { TestContext } from 'node:test';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRuntime } from '@jimhoyd/urlcode';
import type { Runtime } from '@jimhoyd/urlcode';
import { inspectExtensionRevision } from '@jimhoyd/urlcode/extensions';
import type { HandlerResult } from '@jimhoyd/urlcode/extensions';
import { composeHost } from '@jimhoyd/urlcode/host';
import ui from '@jimhoyd/urlcode-ui/extension';
import audit from '@jimhoyd/urlcode-audit/extension';
import mail from '@jimhoyd/urlcode-mail/extension';
import { recordingTransport } from '@jimhoyd/urlcode-mail';
import type { MailEnvelope, MailTransport } from '@jimhoyd/urlcode-mail';
import auth from '@jimhoyd/urlcode-auth/extension';
import { createAuthService } from '@jimhoyd/urlcode-auth';
import type { AuthExports, AuthOptions, AuthService, AuthCase } from '@jimhoyd/urlcode-auth';
import type { AuditExports } from '@jimhoyd/urlcode-audit';
import admin from '../../src/extension.ts';
import type { AdminHostOptions } from '../../src/extension.ts';
import { cleanup } from '../cleanup.ts';

export const origin = 'https://example.test', password = 'correct horse battery staple';
/** The operator methods a test uses to set a site up; `createAuthService` returns them all, its public type omits the administrative ones. */
export type Operator = AuthService & {
    adminSetRoles(input: { actorToken: string; accountId: string; roles: string[]; reason?: string }): Promise<unknown>;
    createCase(input: { actorToken: string; accountId: string; action: 'reset-factors' | 'lock' | 'unlock' | 'roles'; roles?: string[]; reason: string }): Promise<AuthCase>;
    listRegistrationRequests(input: { limit?: number }): Promise<{ requests: { id: string; email: string }[] }>;
};
export interface SiteOptions {
    roles?: Record<string, string[]>;
    auth?: Partial<AuthOptions>;
    /** false: mail without a transport (delivery unavailable). Default: a recording transport. */
    transport?: MailTransport | false;
    health?: AdminHostOptions['health'];
    /** Replaces the /admin/* route (for the activation refusal). */
    adminRoute?: Record<string, unknown>;
    /** Extra routes. */
    routes?: Record<string, unknown>;
    now?: () => number;
    /** extensions.ui.config, and files written under the site directory before the host starts. */
    uiConfig?: Record<string, unknown>;
    files?: Record<string, string>;
    /** Operator alias origins the runtime also serves. */
    aliasOrigins?: string[];
}
export interface CallOptions { fields?: Record<string, string>; html?: boolean; form?: boolean; origin?: string; csrf?: string | false; headers?: Record<string, string>; method?: string }
export interface AdminSite {
    root: string;
    runtime: Runtime;
    service: Operator;
    sent: readonly MailEnvelope[];
    auth: AuthExports;
    audit: AuditExports;
    /** GET, or POST when `fields` is given; POSTs carry the caller's CSRF token in the body unless `csrf: false`. */
    call(path: string, token: string | undefined, options?: CallOptions): Promise<HandlerResult>;
    csrf(token: string): Promise<string>;
    signIn(email: string): Promise<string>;
}
export const text = (response: HandlerResult): string => typeof response.body === 'string' ? response.body : Buffer.from(response.body ?? new Uint8Array()).toString();
export const json = <T = Record<string, unknown>>(response: HandlerResult): T => JSON.parse(text(response)) as T;
export const header = (response: HandlerResult, name: string): string | undefined => response.headers.find(([key]) => key.toLowerCase() === name)?.[1];

export async function adminSite(t: TestContext, options: SiteOptions = {}): Promise<AdminSite> {
    const root = await mkdtemp(join(tmpdir(), 'urlcode-admin-site-'));
    cleanup(t, () => rm(root, { recursive: true, force: true }));
    const project = join(root, 'app');
    await mkdir(project);
    await writeFile(join(project, 'urlcode.yaml'), JSON.stringify({ version: '1',
        extensions: { ui: { version: '1', config: options.uiConfig ?? {} }, audit: { version: '1', config: {} }, mail: { version: '1', config: {} }, auth: { version: '1', config: { registration: options.auth?.registrationMode ?? 'open' } }, admin: { version: '1', config: {} } },
        routes: {
            '/assets/ui/*': { extension: 'ui', methods: ['GET', 'HEAD'] },
            '/account/*': { extension: 'auth', methods: ['GET', 'HEAD', 'POST'] },
            '/admin/*': options.adminRoute ?? { extension: 'admin', methods: ['GET', 'HEAD', 'POST'], auth: { onDeny: 404 } },
            ...options.routes,
        } }));
    for (const [path, content] of Object.entries(options.files ?? {})) { await mkdir(join(root, path, '..'), { recursive: true }); await writeFile(join(root, path), content); }
    const sha = await inspectExtensionRevision(project), previous = process.env.PROJECT_SHA256;
    process.env.PROJECT_SHA256 = sha;
    cleanup(t, () => { if (previous === undefined) delete process.env.PROJECT_SHA256; else process.env.PROJECT_SHA256 = previous; });
    const service = await createAuthService({ database: join(root, 'accounts.sqlite'), encryptionKey: randomBytes(32), roles: options.roles ?? { member: ['site.read'], admin: ['*'] }, defaultRole: 'member', registrationMode: 'open', ...(options.now ? { now: options.now } : {}), ...options.auth }) as Operator;
    cleanup(t, () => service.close());
    const recording = options.transport === undefined ? recordingTransport() : undefined;
    let exported: { auth?: AuthExports; audit?: AuditExports } = {};
    // Admin's own entry, observed: the test reads the auth and audit exports admin is handed.
    const entry = admin(options.health ? { health: options.health } : {});
    const observed = { ...entry, definition: { ...entry.definition, host(ctx: Parameters<typeof entry.definition.host>[0], hostOptions: AdminHostOptions) { exported = { auth: ctx.get<AuthExports>('auth'), audit: ctx.get<AuditExports>('audit') }; return entry.definition.host(ctx, hostOptions); } } };
    const host = await composeHost(pathToFileURL(join(root, 'host.mjs')), [ui(), audit(), mail({ transport: options.transport === false ? null : options.transport ?? recording! }), auth({ service, csrfKey: randomBytes(32) }), observed]);
    cleanup(t, () => host.close?.());
    const runtime = await createRuntime(project, { origin, ...(options.aliasOrigins ? { aliasOrigins: options.aliasOrigins } : {}), extensions: host.extensions!, log: () => {} });
    cleanup(t, () => runtime.close());
    async function call(path: string, token: string | undefined, callOptions: CallOptions = {}): Promise<HandlerResult> {
        const { fields, html = false, form = html } = callOptions;
        const method = callOptions.method ?? (fields ? 'POST' : 'GET');
        const headers = new Headers({ accept: html ? 'text/html' : 'application/json', ...(token ? { cookie: '__Host-urlcode-session=' + token } : {}), ...callOptions.headers });
        let body: Uint8Array | undefined;
        if (fields) {
            const csrf = callOptions.csrf === false ? undefined : callOptions.csrf ?? (token ? await site.csrf(token) : undefined);
            const values = { ...fields, ...(csrf ? { csrf } : {}) };
            headers.set('origin', callOptions.origin ?? origin);
            headers.set('content-type', form ? 'application/x-www-form-urlencoded' : 'application/json');
            body = new TextEncoder().encode(form ? new URLSearchParams(values).toString() : JSON.stringify(values));
        }
        return runtime.handle({ target: path, method, headers, ...(body ? { body } : {}) });
    }
    const site: AdminSite = {
        root, runtime, service, sent: recording?.sent ?? [], auth: exported.auth!, audit: exported.audit!, call,
        async csrf(token) {
            const response = await call('/admin', token);
            if (response.status !== 200) throw new Error(`No console for this session (${response.status})`);
            return json<{ csrf: string }>(response).csrf;
        },
        async signIn(email) { return (await service.login({ email, password })).token; },
    };
    return site;
}
/** The first URL in a message body. */
export function linkIn(envelope: MailEnvelope): URL {
    const link = envelope.text.match(/https?:\/\/\S+/)?.[0]?.replace(/[.,;:]+$/, '');
    if (!link) throw new Error(`No link in ${envelope.template}`);
    return new URL(link);
}
