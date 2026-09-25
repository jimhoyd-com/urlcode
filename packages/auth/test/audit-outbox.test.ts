// Auth is the audit extension's first producer (packages/audit SECURITY.md): every audit event is written to
// auth_audit_outbox in the transaction of the change it records, the change is refused at the backlog cap, and the
// audit extension drains the outbox, storing each event once, even across a crash between capture and drain.
import { cleanup } from './cleanup.ts';
import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { composeHost } from '@jimhoyd/urlcode/host';
import { defineExtension } from '@jimhoyd/urlcode/extensions';
import ui from '@jimhoyd/urlcode-ui/extension';
import type { AuditExports } from '@jimhoyd/urlcode-audit';
import audit from '@jimhoyd/urlcode-audit/extension';
import mail from '@jimhoyd/urlcode-mail/extension';
import { createAuthService, internal } from '../src/auth-core.ts';
import type { AuthOptions, AuthServiceInternal } from '../src/auth-core.ts';
import auth from '../src/extension.ts';
import { outbox } from './support/outbox.ts';

const password = 'correct horse battery staple', key = new Uint8Array(32).fill(7), sha = 'a'.repeat(64);
async function directory(t: TestContext, prefix: string) {
    const root = await mkdtemp(join(tmpdir(), prefix));
    cleanup(t, () => rm(root, { recursive: true, force: true }));
    return root;
}
const options = (database: string): AuthOptions => ({ database, encryptionKey: key, roles: { member: [], admin: ['*'] }, defaultRole: 'member', registrationMode: 'open' });
function withSha(t: TestContext) {
    const previous = process.env.PROJECT_SHA256;
    process.env.PROJECT_SHA256 = sha;
    t.after(() => { if (previous === undefined) delete process.env.PROJECT_SHA256; else process.env.PROJECT_SHA256 = previous; });
}
/** A dependant that reads the audit exports the way admin does, through ctx.get. */
function auditReader(): { entry: ReturnType<ReturnType<typeof defineExtension>>; exports(): AuditExports } {
    let captured: AuditExports | undefined;
    const reader = defineExtension({ name: 'reader', description: 'Reads audit', requires: ['audit'], schema: { type: 'object' }, host(ctx) {
        captured = ctx.get<AuditExports>('audit');
        return { registration: { name: 'reader', version: '1', projectSha256: ctx.projectSha256, targets: ['node'], schema: { type: 'object' }, activate: () => ({ handle: () => ({ status: 404, headers: [] }) }) } };
    } });
    return { entry: reader(), exports: () => captured! };
}
/** audit, mail, ui, auth (and the reader) over `root`'s files; `activate` activates audit so its drain runs. */
async function compose(t: TestContext, root: string, service: AuthServiceInternal) {
    withSha(t);
    const reader = auditReader();
    const composed = await composeHost(pathToFileURL(join(root, 'host.mjs')), [audit({ database: join(root, 'audit.sqlite') }), mail({ transport: null }), ui(), auth({ service, csrfKey: randomBytes(32) }), reader.entry]);
    return {
        composed, reader: reader.exports(),
        async activate() {
            const instance = await composed.extensions!.find(extension => extension.name === 'audit')!.activate({}, { origin: 'https://example.test', target: 'node', projectSha256: sha, mounts: [], root });
            cleanup(t, () => instance.close?.());
        },
    };
}

test('each audited change writes its event in its own transaction; a refused change writes none', async (t) => {
    const root = await directory(t, 'urlcode-auth-outbox-');
    const service = internal(await createAuthService(options(join(root, 'auth.sqlite'))));
    cleanup(t, () => service.close());
    const admin = await service.bootstrapAdmin({ email: 'owner@example.test', password }), member = await service.register({ email: 'member@example.test', password });
    assert.deepEqual((await outbox(service)).map(event => [event.source, event.action, event.actor, event.subject]), [['auth', 'admin.bootstrap', admin.user.id, admin.user.id], ['auth', 'account.register', member.user.id, member.user.id]]);
    // Demoting the only administrator is refused inside the transaction, so it records nothing.
    await assert.rejects(service.adminSetRoles({ actorToken: admin.token, accountId: admin.user.id, roles: ['member'] }));
    await service.adminSetRoles({ actorToken: admin.token, accountId: member.user.id, roles: ['admin'], reason: 'Second administrator' });
    const events = await outbox(service);
    assert.equal(events.length, 3);
    assert.deepEqual({ action: events[2]!.action, actor: events[2]!.actor, subject: events[2]!.subject, reason: events[2]!.reason }, { action: 'admin.roles', actor: admin.user.id, subject: member.user.id, reason: 'Second administrator' });
    for (const event of events)
        assert.match(event.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.equal(await service.auditOutbox.backlog(), 3);
    // ack removes delivered events; unknown ids are ignored.
    await service.auditOutbox.ack([events[0]!.id, randomUUID()]);
    assert.deepEqual((await service.auditOutbox.peek(100)).map(event => event.id), [events[1]!.id, events[2]!.id]);
    assert.equal((await service.auditOutbox.peek(1)).length, 1);
});

test('the pending cue arrives only after a commit that wrote events', async (t) => {
    const root = await directory(t, 'urlcode-auth-outbox-cue-');
    const service = internal(await createAuthService(options(join(root, 'auth.sqlite'))));
    cleanup(t, () => service.close());
    let cues = 0;
    const off = service.auditOutbox.onPending(() => { cues++; });
    const settle = () => new Promise<void>(resolve => setTimeout(resolve, 20));
    await service.register({ email: 'first@example.test', password });
    await settle();
    assert.equal(cues, 1);
    await assert.rejects(service.login({ email: 'first@example.test', password: 'the wrong passphrase here' }));
    await service.getUser('nobody');
    await settle();
    assert.equal(cues, 1, 'a refusal and a read post no cue');
    off();
    await service.register({ email: 'second@example.test', password });
    await settle();
    assert.equal(cues, 1, 'a removed listener hears nothing');
});

test('at the 10000-event backlog the change is refused with 503 audit_backlog and not applied', async (t) => {
    const root = await directory(t, 'urlcode-auth-outbox-cap-'), database = join(root, 'auth.sqlite');
    const first = await createAuthService(options(database));
    await first.register({ email: 'existing@example.test', password });
    await first.close();
    const db = new DatabaseSync(database);
    const insert = db.prepare('INSERT INTO auth_audit_outbox(id,event) VALUES(?,?)');
    db.exec('BEGIN');
    for (let index = 1; index < 10000; index++)
        insert.run(randomUUID(), JSON.stringify({ id: randomUUID(), source: 'auth', action: 'synthetic.filler', actor: 'operator', subject: '', at: 1 }));
    db.exec('COMMIT');
    db.close();
    const service = await createAuthService(options(database));
    cleanup(t, () => service.close());
    await assert.rejects(service.register({ email: 'refused@example.test', password }), { status: 503, code: 'audit_backlog' });
    assert.deepEqual((await service.listUsers()).users.map(user => user.email), ['existing@example.test']);
    // Reads still work, and draining one event lets the next change through.
    const full = internal(service), [oldest] = await full.auditOutbox.peek(1);
    await full.auditOutbox.ack([oldest!.id]);
    await service.register({ email: 'accepted@example.test', password });
});

test('events captured before a crash are drained by the next host exactly once', async (t) => {
    const root = await directory(t, 'urlcode-auth-outbox-crash-');
    // Host A: audit is hosted but never activated, so nothing drains; its store worker then goes away with the host.
    const serviceA = internal(await createAuthService(options(join(root, 'auth.sqlite'))));
    const hostA = await compose(t, root, serviceA);
    const captured = [await serviceA.register({ email: 'a@example.test', password }), await serviceA.register({ email: 'b@example.test', password })];
    const pending = await serviceA.auditOutbox.peek(100);
    assert.equal(pending.length, 2);
    await serviceA.close();
    await hostA.composed.close?.();
    // Host B on the same files: activating audit drains the outbox into the log, each event once.
    const serviceB = internal(await createAuthService(options(join(root, 'auth.sqlite'))));
    const hostB = await compose(t, root, serviceB);
    cleanup(t, async () => { await hostB.composed.close?.(); await serviceB.close(); });
    await hostB.activate();
    await hostB.reader.flush();
    const page = await hostB.reader.query({ source: 'auth', limit: 100 });
    assert.deepEqual(page.events.map(event => event.id).sort(), pending.map(event => event.id).sort());
    assert.deepEqual(page.events.map(event => event.subject).sort(), captured.map(result => result.user.id).sort());
    assert.equal(await serviceB.auditOutbox.backlog(), 0);
    // A new change is drained too, and nothing is stored twice.
    await serviceB.register({ email: 'c@example.test', password });
    await hostB.reader.flush();
    const after = await hostB.reader.query({ source: 'auth', limit: 100 });
    assert.equal(after.events.length, 3);
    assert.equal(new Set(after.events.map(event => event.id)).size, 3);
});

test('an event the CLI wrote with no host running is drained by the next host', async (t) => {
    const root = await directory(t, 'urlcode-auth-outbox-cli-'), database = join(root, 'auth.sqlite'), operator = join(root, 'operator.mjs');
    await mkdir(join(root, 'app'));
    await writeFile(join(root, 'app', 'urlcode.yaml'), JSON.stringify({ version: '1', routes: {} }));
    await writeFile(operator, `import {createAuthService} from ${JSON.stringify(new URL('../src/auth-core.ts', import.meta.url).href)}; export default await createAuthService({database:${JSON.stringify(database)},encryptionKey:new Uint8Array(32).fill(7),roles:{member:[],admin:['*']},defaultRole:'member',registrationMode:'open'});`);
    const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
    const bootstrap = spawnSync(process.execPath, [cli, 'bootstrap', '--operator-file', operator], { input: JSON.stringify({ email: 'owner@example.test', password }), encoding: 'utf8', timeout: 30000 });
    assert.equal(bootstrap.status, 0, bootstrap.stderr);
    const owner = JSON.parse(bootstrap.stdout) as { id: string };
    const service = internal(await createAuthService(options(database)));
    const hosted = await compose(t, root, service);
    cleanup(t, async () => { await hosted.composed.close?.(); await service.close(); });
    await hosted.activate();
    await hosted.reader.flush();
    const page = await hosted.reader.query({ action: 'admin.bootstrap' });
    assert.equal(page.events.length, 1);
    assert.equal(page.events[0]!.actor, owner.id);
    assert.equal(page.events[0]!.source, 'auth');
});
