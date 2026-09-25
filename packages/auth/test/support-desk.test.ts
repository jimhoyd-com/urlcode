// The second consumer of AuthExports v1 (test/fixtures/support-desk): a site's own administrative extension, not
// admin, that works entirely through account(), csrf, urls and administration.
import { cleanup } from './cleanup.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomBytes } from 'node:crypto';
import { startServer } from '@jimhoyd/urlcode';
import { inspectExtensionRevision } from '@jimhoyd/urlcode/extensions';
import { composeHost } from '@jimhoyd/urlcode/host';
import ui from '@jimhoyd/urlcode-ui/extension';
import audit from '@jimhoyd/urlcode-audit/extension';
import mail from '@jimhoyd/urlcode-mail/extension';
import auth from '../src/extension.ts';
import { createAuthService, internal } from '../src/auth-core.ts';
import { FRESHNESS_WINDOW_MS } from '../src/freshness.ts';
import desk from './fixtures/support-desk/extension.ts';

const origin = 'https://example.test', password = 'correct horse battery staple';

test('a support desk lists cases, adds a note with auth\'s CSRF token and sends a stale write to step-up', async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'urlcode-auth-support-desk-'));
    cleanup(t, () => rm(root, { recursive: true, force: true }));
    const project = join(root, 'app');
    await mkdir(project);
    await writeFile(join(project, 'urlcode.yaml'), JSON.stringify({ version: '1', extensions: { ui: { version: '1', config: {} }, audit: { version: '1', config: {} }, mail: { version: '1', config: {} }, auth: { version: '1', config: { registration: 'open' } }, 'support-desk': { version: '1', config: {} } }, routes: {
        '/assets/ui/*': { extension: 'ui', methods: ['GET', 'HEAD'] },
        '/account/*': { extension: 'auth', methods: ['GET', 'HEAD', 'POST'] },
        '/desk/*': { extension: 'support-desk', methods: ['GET', 'HEAD', 'POST'], auth: { permission: 'auth.cases.read' } },
    } }));
    const sha = await inspectExtensionRevision(project);
    const previous = process.env.PROJECT_SHA256;
    process.env.PROJECT_SHA256 = sha;
    cleanup(t, () => { if (previous === undefined) delete process.env.PROJECT_SHA256; else process.env.PROJECT_SHA256 = previous; });
    let clock = Date.now();
    const service = internal(await createAuthService({ database: join(root, 'accounts.sqlite'), encryptionKey: randomBytes(32), roles: { member: [], support: ['auth.cases.read', 'auth.cases.manage', 'auth.users.manage'], admin: ['*'] }, defaultRole: 'member', registrationMode: 'open', now: () => clock }));
    cleanup(t, () => service.close());
    const host = await composeHost(pathToFileURL(join(root, 'host.mjs')), [ui(), audit(), mail({ transport: null }), auth({ service, csrfKey: randomBytes(32) }), desk()]);
    cleanup(t, () => host.close?.());
    const server = await startServer({ project, origin, port: 0, extensions: host.extensions!, log: () => {} });
    cleanup(t, () => server.close());
    const admin = await service.bootstrapAdmin({ email: 'owner@example.test', password });
    const agent = await service.register({ email: 'agent@example.test', password }), member = await service.register({ email: 'member@example.test', password });
    await service.adminSetRoles({ actorToken: admin.token, accountId: agent.user.id, roles: ['support'] });
    const opened = await service.createCase({ actorToken: admin.token, accountId: member.user.id, action: 'lock', reason: 'Reported abuse' });
    const signIn = () => service.login({ email: 'agent@example.test', password });
    const call = (path: string, token: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) => fetch(`http://127.0.0.1:${server.address.port}${path}`, { method: init.method ?? 'GET', redirect: 'manual', headers: { accept: 'application/json', cookie: '__Host-urlcode-session=' + token, ...init.headers }, ...(init.body !== undefined ? { body: init.body } : {}) });
    const session = await signIn();
    const listed = await call('/desk/cases', session.token);
    assert.equal(listed.status, 200);
    const { cases, csrf } = await listed.json() as { cases: { id: string; notes: number }[]; csrf: string };
    assert.deepEqual(cases, [{ id: opened.id, notes: 0 }]);
    // The desk's HTML form posts auth's session-bound token in the body; auth's authorize() verifies it there.
    const form = await (await call('/desk/cases', session.token, { headers: { accept: 'text/html' } })).text();
    assert.ok(form.includes(`name="csrf" value="${csrf}"`));
    const noted = await call('/desk/cases/note', session.token, { method: 'POST', headers: { origin, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ csrf, caseId: opened.id, note: 'Called the reporter' }).toString() });
    assert.equal(noted.status, 200);
    assert.deepEqual(await noted.json(), { notes: 1 });
    // Without the token the write never reaches the desk.
    assert.equal((await call('/desk/cases/note', session.token, { method: 'POST', headers: { origin, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ caseId: opened.id, note: 'Forged' }).toString() })).status, 403);
    // A proof older than the freshness window: the desk redirects to auth's step-up with the way back.
    clock = Date.now() - FRESHNESS_WINDOW_MS - 1000;
    const stale = await signIn();
    clock = Date.now();
    const staleCsrf = (await (await call('/desk/cases', stale.token)).json() as { csrf: string }).csrf;
    const redirected = await call('/desk/cases/note', stale.token, { method: 'POST', headers: { origin, 'x-csrf-token': staleCsrf, 'content-type': 'application/json' }, body: JSON.stringify({ caseId: opened.id, note: 'Late' }) });
    assert.equal(redirected.status, 303);
    assert.equal(redirected.headers.get('location'), '/account/step-up?returnTo=%2Fdesk%2Fcases');
    // A signed-in account without auth.cases.read is refused by auth's policy before the desk sees it.
    const outsider = await service.login({ email: 'member@example.test', password });
    assert.equal((await call('/desk/cases', outsider.token)).status, 403);
    assert.equal((await service.getCase(opened.id))!.notes?.length, 1);
    // The desk imports auth only as types.
    const source = await readFile(new URL('./fixtures/support-desk/extension.ts', import.meta.url), 'utf8');
    assert.ok([...source.matchAll(/^import (.*) from '([^']+)';$/gm)].filter(match => match[2]!.includes('src/')).every(match => match[1]!.startsWith('type ')));
});
