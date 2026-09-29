// Declared transfers (#902 item 2): `POST <mount>/transfers/<name>` moves a whole amount from one record's balance to
// another's in one transaction, replacing the host transaction the simulated-credit counterexample of #835 needed.
// Proved: the sum is conserved under interleaved and cross-connection transfers, an overdraft and every other refusal
// writes nothing, who may debit whom (owned, shared, membership-gated), same-record and non-integer refusals,
// Idempotency-Key replay, audit atomicity under an injected failure, the records export, and activation's rules.
// #928: the sum holds across every write, not only transfers: a record opens at 0, no body sets the balance, and no
// delete path (HTTP, host transaction, operator CLI) removes a record still holding one.
import test from 'node:test';
import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAudit } from '@jimhoyd/urlcode-audit';
import type { AuditExports } from '@jimhoyd/urlcode-audit';
import { StoreError, deleteOwnerless, normalize } from '../src/index.ts';
import type { CollectionSpec } from '../src/index.ts';
import { cleanup } from './cleanup.ts';
import { direct, pin, race } from './direct.ts';
import type { Answer } from './direct.ts';
import { counts, execute, outbox, records, seed } from './rows.ts';

const balanceSchema = (minimum: number) => ({ type: 'object', additionalProperties: false, required: ['name', 'balance'], properties: { name: { type: 'string', maxLength: 20 }, balance: { type: 'integer', minimum, maximum: 1_000_000 } } });
/**
 * Shared accounts: every account opens at 0 (#928) and only transfers change a balance. fund is the issuer the tests
 * open each account with, from a bank record that may go down to -1,000,000, so the sum over the collection stays 0.
 */
const accounts = { mount: '/api/accounts', idempotency: { maxKeys: 1000 }, schema: balanceSchema(-1_000_000), defaults: { balance: 0 }, readOnlyProperties: ['balance'], transfers: { move: { amount: 'balance' }, fund: { amount: 'balance', min: -1_000_000 } } };
const treasurers = { membership: true, key: 'userId', schema: { type: 'object', additionalProperties: false, required: ['userId'], properties: { userId: { type: 'string', maxLength: 128 } } } };
/**
 * Owned wallets: pay debits the caller's own wallet and may credit anyone's, never below 0. issue is the members-only
 * issuer: a treasurer's wallet may go down to -1,000,000, which is the supply outstanding, so the sum stays 0.
 */
const wallets = {
  mount: '/api/wallets', ownership: 'owner', idempotency: { maxKeys: 1000 }, schema: balanceSchema(-1_000_000), defaults: { balance: 0 }, readOnlyProperties: ['balance'],
  transfers: { pay: { amount: 'balance' }, issue: { amount: 'balance', min: -1_000_000, members: 'treasurers' } },
};
const config = { collections: { accounts, treasurers, wallets } };
const mounts = ['/api/accounts', '/api/wallets'];
const code = (answer: Answer) => (answer.body?.error as { code?: string } | undefined)?.code;
const sum = (database: string, collection: string) => records(database, collection).reduce((total, record) => total + (record.balance as number), 0);
/** Every balance but the bank's, which holds minus the funded total. */
const balances = (database: string, collection: string) => Object.fromEntries(records(database, collection).filter(record => record.name !== 'bank').map(record => [record.name, record.balance]));

/** The total the accounts other than the bank hold: what was funded. */
const held = (database: string) => Object.values(balances(database, 'accounts')).reduce((total: number, balance) => total + (balance as number), 0);
/** Opens each named account at 0 and funds it with 100 from the bank. */
async function funded(store: Awaited<ReturnType<typeof direct>>, names: string[], who: string | null = null) {
  const open = async (name: string) => (await store.call('POST', '/api/accounts', { who, body: { name } })).body!.id as string;
  const bank = await open('bank'), ids: Record<string, string> = { bank };
  for (const name of names) {
    ids[name] = await open(name);
    assert.equal((await store.call('POST', '/api/accounts/transfers/fund', { who, body: { from: bank, to: ids[name], amount: 100 } })).status, 200);
  }
  return ids;
}
async function opened(t: TestContext, names: string[]) {
  const store = await direct(t, config, { mounts, principalMounts: ['/api/wallets'] });
  return { store, ids: await funded(store, names) };
}

test('a transfer moves a whole amount between two records, keeps the sum, and answers both as they are now', async t => {
  const { store, ids } = await opened(t, ['a', 'b']);
  const moved = await store.call('POST', '/api/accounts/transfers/move', { body: { from: ids.a, to: ids.b, amount: 30 } });
  assert.equal(moved.status, 200);
  assert.deepEqual([(moved.body!.from as { balance: number }).balance, (moved.body!.to as { balance: number }).balance], [70, 130]);
  const a = await store.call('GET', `/api/accounts/${ids.a}`), b = await store.call('GET', `/api/accounts/${ids.b}`);
  assert.equal(moved.header('etag'), a.header('etag'), 'the ETag is the debited record\'s');
  assert.deepEqual([(moved.body!.from as { updatedAt: string }).updatedAt, (moved.body!.to as { updatedAt: string }).updatedAt], [a.body!.updatedAt, b.body!.updatedAt], 'both records get a new revision');
  assert.equal(sum(store.database, 'accounts'), 0);
  assert.deepEqual(balances(store.database, 'accounts'), { a: 70, b: 130 });
  // The balance is readOnly: the transfer is the only way it changes, so nobody can mint by PATCH.
  const minted = await store.call('PATCH', `/api/accounts/${ids.a}`, { body: { balance: 1000 } });
  assert.equal(minted.status, 422); assert.equal(code(minted), 'invalid_record');
  // Another transfer back, conditional on the version just read.
  assert.equal((await store.call('POST', '/api/accounts/transfers/move', { body: { from: ids.b, to: ids.a, amount: 130 }, headers: { 'if-match': b.header('etag')! } })).status, 200);
  assert.deepEqual(balances(store.database, 'accounts'), { a: 200, b: 0 });
  // A GET is 405 with Allow: POST; an undeclared transfer is the ordinary 404.
  const get = await store.call('GET', '/api/accounts/transfers/move');
  assert.equal(get.status, 405); assert.equal(get.header('allow'), 'POST');
  assert.equal((await store.call('POST', '/api/accounts/transfers/steal', { body: { from: ids.a, to: ids.b, amount: 1 } })).status, 404);
});

test('an overdraft, a stale If-Match and every malformed request are refused and write nothing', async t => {
  const { store, ids } = await opened(t, ['a', 'b']);
  const before = { counts: counts(store.database), accounts: records(store.database, 'accounts') };
  const refused = async (body: unknown, status: number, expected: string, headers: Record<string, string> = {}) => {
    const answer = await store.call('POST', '/api/accounts/transfers/move', { body, headers: { 'idempotency-key': `k-${JSON.stringify(body)}`, ...headers } });
    assert.equal(answer.status, status, JSON.stringify(body)); assert.equal(code(answer), expected, JSON.stringify(body));
    return answer;
  };
  await refused({ from: ids.a, to: ids.b, amount: 101 }, 409, 'insufficient_balance');
  const stale = (await store.call('GET', `/api/accounts/${ids.b}`)).header('etag')!;
  await refused({ from: ids.a, to: ids.b, amount: 1 }, 412, 'precondition_failed', { 'if-match': stale });
  const same = await refused({ from: ids.a, to: ids.a, amount: 1 }, 422, 'invalid_transfer');
  assert.deepEqual((same.body!.error as { issues: unknown[] }).issues, [{ pointer: '/to', keyword: 'transfer', message: 'must differ from from' }]);
  // Integers only: a fraction is refused, never rounded; so are zero, a negative amount, a string and a missing id.
  const fraction = await refused({ from: ids.a, to: ids.b, amount: 1.5 }, 422, 'invalid_transfer');
  assert.deepEqual((fraction.body!.error as { issues: { pointer: string; keyword: string }[] }).issues.map(issue => `${issue.pointer} ${issue.keyword}`), ['/amount type']);
  for (const body of [{ from: ids.a, to: ids.b, amount: 0 }, { from: ids.a, to: ids.b, amount: -5 }, { from: ids.a, to: ids.b, amount: '5' }, { from: ids.a, amount: 5 }, { from: ids.a, to: ids.b, amount: 5, note: 'x' }, { from: 'a', to: ids.b, amount: 5 }, { from: ids.a, to: ids.b, amount: 2 ** 53 }, [ids.a]])
    await refused(body, 422, 'invalid_transfer');
  await refused({ from: ids.a, to: '00000000-0000-4000-8000-000000000000', amount: 1 }, 404, 'not_found');
  assert.deepEqual({ counts: counts(store.database), accounts: records(store.database, 'accounts') }, before, 'no record, claim or revision changed');
});

test('owned wallets: the caller debits only its own record, may credit anyone\'s, and never sees another owner\'s balance', async t => {
  const store = await direct(t, config, { mounts, principalMounts: ['/api/wallets'] });
  store.first.records('treasurers').create(null, { userId: 'tess' });
  const wallet = async (who: string, name: string) => (await store.call('POST', '/api/wallets', { who, body: { name } })).body!.id as string;
  const mint = await wallet('tess', 'mint'), ann = await wallet('ann', 'ann'), annSavings = await wallet('ann', 'ann-savings'), bob = await wallet('bob', 'bob');
  const pay = (who: string | null, body: unknown, name = 'pay') => store.call('POST', `/api/wallets/transfers/${name}`, { who, body });
  // Only a treasurer may issue, and the gate comes before any record is read: a missing id answers the same 403.
  for (const from of [mint, '00000000-0000-4000-8000-000000000000']) {
    const gated = await pay('ann', { from, to: ann, amount: 50 }, 'issue');
    assert.equal(gated.status, 403); assert.equal(code(gated), 'membership_required');
  }
  const issued = await pay('tess', { from: mint, to: ann, amount: 50 }, 'issue');
  assert.equal(issued.status, 200);
  assert.equal((issued.body!.from as { balance: number }).balance, -50, 'the issuer goes below zero: the supply outstanding');
  assert.equal(issued.body!.to, undefined, 'another owner\'s record is credited but not shown');
  assert.equal(sum(store.database, 'wallets'), 0, 'issuing moves value; it never creates it');
  // pay cannot take a wallet below 0, not even the treasurer's own: the floor is the transfer's, not the record's.
  const overdraft = await pay('tess', { from: mint, to: ann, amount: 1 });
  assert.equal(overdraft.status, 409); assert.equal(code(overdraft), 'insufficient_balance');
  // Nobody debits another owner's wallet: it is the same 404 as a missing id.
  const theft = await pay('bob', { from: ann, to: bob, amount: 10 });
  assert.equal(theft.status, 404); assert.equal(code(theft), 'not_found');
  // The floor is checked before the credited record is looked up, so probing an id costs the funds to move.
  const probe = await pay('bob', { from: bob, to: '00000000-0000-4000-8000-000000000000', amount: 10 });
  assert.equal(code(probe), 'insufficient_balance');
  const paid = await pay('ann', { from: ann, to: bob, amount: 20 });
  assert.equal(paid.status, 200); assert.deepEqual(Object.keys(paid.body!), ['from']);
  assert.equal(JSON.stringify(paid.body).includes('_owner'), false);
  // Between two of the caller's own wallets both are shown.
  const saved = await pay('ann', { from: ann, to: annSavings, amount: 10 });
  assert.deepEqual([(saved.body!.from as { balance: number }).balance, (saved.body!.to as { balance: number }).balance], [20, 10]);
  // The credited record's owner is not the caller's to read afterwards either.
  assert.equal((await store.call('GET', `/api/wallets/${bob}`, { who: 'ann' })).status, 404);
  assert.deepEqual(balances(store.database, 'wallets'), { mint: -50, ann: 20, 'ann-savings': 10, bob: 20 });
  // The credited balance keeps its property's schema (maximum 1,000,000); the refusal names no balance.
  const reserve = await wallet('tess', 'reserve');
  assert.equal((await pay('tess', { from: reserve, to: bob, amount: 999_980 }, 'issue')).status, 200);
  const over = await pay('tess', { from: mint, to: bob, amount: 1 }, 'issue');
  assert.equal(over.status, 409); assert.equal(code(over), 'transfer_limit'); assert.deepEqual(Object.keys(over.body!.error as object), ['code', 'message']);
  assert.equal((balances(store.database, 'wallets') as Record<string, number>).bob, 1_000_000);
  // No principal on an owned collection is a 401 before anything is read.
  assert.equal((await pay(null, { from: ann, to: bob, amount: 1 })).status, 401);
  assert.equal(sum(store.database, 'wallets'), 0);
});

test('an Idempotency-Key replays a committed transfer instead of moving the amount twice', async t => {
  const { store, ids } = await opened(t, ['a', 'b']);
  const send = (body: unknown, key: string) => store.call('POST', '/api/accounts/transfers/move', { body, headers: { 'idempotency-key': key } });
  const first = await send({ from: ids.a, to: ids.b, amount: 40 }, 'pay-1');
  assert.equal(first.status, 200); assert.equal(first.header('idempotency-replayed'), undefined);
  // A later change the retry did not make: the replay shows both records as they are now.
  await send({ from: ids.b, to: ids.a, amount: 5 }, 'pay-2');
  const retry = await store.call('POST', '/api/accounts/transfers/move', { raw: JSON.stringify({ amount: 40, to: ids.b, from: ids.a }), headers: { 'idempotency-key': 'pay-1' } });
  assert.equal(retry.status, 200); assert.equal(retry.header('idempotency-replayed'), 'true');
  assert.deepEqual([(retry.body!.from as { balance: number }).balance, (retry.body!.to as { balance: number }).balance], [65, 135]);
  assert.deepEqual(balances(store.database, 'accounts'), { a: 65, b: 135 }, 'moved once');
  const reused = await send({ from: ids.a, to: ids.b, amount: 41 }, 'pay-1');
  assert.equal(reused.status, 422); assert.equal(code(reused), 'idempotency_key_reused');
  // A refused transfer keeps no claim, so its retry is judged again once the funds are there.
  assert.equal(code(await send({ from: ids.b, to: ids.a, amount: 150 }, 'big')), 'insufficient_balance');
  await send({ from: ids.a, to: ids.b, amount: 15 }, 'top-up');
  assert.equal((await send({ from: ids.b, to: ids.a, amount: 150 }, 'big')).status, 200);
  assert.equal(sum(store.database, 'accounts'), 0);
  assert.deepEqual(balances(store.database, 'accounts'), { a: 200, b: 0 });
});

test('200 interleaved transfers conserve the total, in one process and across connections', async t => {
  const { store, ids } = await opened(t, ['a', 'b', 'c', 'd']);
  const names = ['a', 'b', 'c', 'd'], pick = (index: number) => ids[names[index % 4]!]!;
  const plan = Array.from({ length: 200 }, (_, index) => ({ from: pick(index), to: pick(index + 1 + (index % 3)), amount: 1 + (index * 37) % 90 }));
  const local = await Promise.all(plan.map(async body => { await new Promise(resolve => setImmediate(resolve)); return store.call('POST', '/api/accounts/transfers/move', { body }); }));
  assert.ok(local.every(answer => answer.status === 200 || code(answer) === 'insufficient_balance'), JSON.stringify(local.map(answer => answer.status)));
  assert.ok(local.some(answer => answer.status === 409), 'some transfers overdrew and were refused');
  assert.equal(sum(store.database, 'accounts'), 0);
  assert.equal(held(store.database), 400);
  await store.close();
  // Four threads, each with its own connection as a second process would have, 50 transfers each, released at once.
  const racers = Array.from({ length: 4 }, (_, worker) => plan.slice(worker * 50, worker * 50 + 50).map(body => ({ method: 'POST', path: '/api/accounts/transfers/move', init: { body } })));
  const answers = (await race(t, store.database, config, store.activation, racers)).flat();
  assert.equal(answers.length, 200);
  // Separate connections contend for the write lock: a writer that waits past the busy timeout answers 503
  // storage_unavailable and writes nothing (slow filesystems such as Windows CI hit this); the sum still holds.
  assert.ok(answers.every(answer => answer.status === 200 || answer.status === 409 || (answer.status === 503 && code(answer) === 'storage_unavailable')), JSON.stringify(answers.map(answer => answer.status)));
  assert.equal(sum(store.database, 'accounts'), 0, 'the total never changes');
  assert.equal(held(store.database), 400);
  assert.ok(Object.values(balances(store.database, 'accounts')).every(balance => (balance as number) >= 0), 'no balance went below the floor');
});

/** A real audit database for event validation, with a drain that never runs, so undelivered events stay countable. */
async function auditFor(t: TestContext, root: string): Promise<AuditExports & { woken(): number }> {
  const log = await createAudit({ projectSha256: pin, database: join(root, 'audit.sqlite') });
  cleanup(t, () => log.close());
  await log.registration.activate({}, { origin: 'https://direct.example.test', target: 'node', projectSha256: pin, mounts: [], root });
  let woken = 0;
  return { ...log.exports, get active() { return log.exports.active; }, validate: value => log.exports.validate(value), attach: () => ({ notify() { woken++; }, async close() {} }), woken: () => woken };
}

test('audit: both records\' events commit with the transfer, and an injected failure rolls back all of it', async t => {
  const root = await mkdtemp(join(tmpdir(), 'store-transfer-audit-'));
  cleanup(t, () => rm(root, { recursive: true, force: true, maxRetries: 5 }));
  const audit = await auditFor(t, root);
  const store = await direct(t, { collections: { accounts: { ...accounts, audit: true } } }, { mounts: ['/api/accounts'], audit });
  const { a, b } = await funded(store, ['a', 'b'], 'ann') as { a: string; b: string };
  const woken = audit.woken(), before = { counts: counts(store.database), accounts: records(store.database, 'accounts'), outbox: outbox(store.database) };
  // The credited record's write fails inside SQLite, after the debit and its audit event were written.
  execute(store.database, `CREATE TRIGGER fail_b BEFORE UPDATE ON store_records WHEN NEW.id = '${b}' BEGIN SELECT RAISE(ABORT, 'injected'); END;`);
  const failed = await store.call('POST', '/api/accounts/transfers/move', { who: 'ann', body: { from: a, to: b, amount: 10 }, headers: { 'idempotency-key': 'once' } });
  assert.equal(failed.status, 503); assert.equal(code(failed), 'storage_unavailable');
  assert.deepEqual({ counts: counts(store.database), accounts: records(store.database, 'accounts'), outbox: outbox(store.database) }, before, 'no debit, claim or event survives');
  assert.equal(audit.woken(), woken, 'a rolled-back transfer wakes nothing');
  execute(store.database, 'DROP TRIGGER fail_b');
  assert.equal((await store.call('POST', '/api/accounts/transfers/move', { who: 'ann', body: { from: a, to: b, amount: 10 }, headers: { 'idempotency-key': 'once' } })).status, 200, 'the retry runs');
  assert.equal(audit.woken(), woken + 1, 'one wake-up after the commit');
  const events = outbox(store.database).slice(before.outbox.length);
  assert.deepEqual(events.map(event => [event.action, event.actor, event.subject, event.metadata]), [
    ['store.record.transferred', 'ann', `accounts/${a}`, { collection: 'accounts', transfer: 'move', side: 'from', counterpart: b, fields: ['balance'] }],
    ['store.record.transferred', 'ann', `accounts/${b}`, { collection: 'accounts', transfer: 'move', side: 'to', counterpart: a, fields: ['balance'] }],
  ]);
});

test('the records export and host transactions run a transfer under the same rules', async t => {
  const { store, ids } = await opened(t, ['a', 'b']);
  const api = store.exports.records('accounts');
  const result = await api.transfer(null, 'move', { from: ids.a!, to: ids.b!, amount: 25 });
  assert.deepEqual([result.from.record.balance, result.to?.record.balance], [75, 125]);
  await assert.rejects(api.transfer(null, 'move', { from: ids.a!, to: ids.b!, amount: 76 }), (error: unknown) => error instanceof StoreError && error.code === 'insufficient_balance');
  await assert.rejects(api.transfer(null, 'move', { from: ids.a!, to: ids.b!, amount: 0.5 }), (error: unknown) => error instanceof StoreError && error.code === 'invalid_transfer');
  // Inside a host transaction a transfer commits or rolls back with the transaction's other writes.
  assert.throws(() => store.exports.transaction(tx => { tx.records('accounts').transfer(null, 'move', { from: ids.a!, to: ids.b!, amount: 5 }); throw new Error('later step failed'); }), /later step failed/);
  assert.deepEqual(balances(store.database, 'accounts'), { a: 75, b: 125 });
  const done = store.exports.transaction(tx => tx.records('accounts').transfer(null, 'move', { from: ids.b!, to: ids.a!, amount: 25 }, { ifMatch: result.to!.etag }));
  assert.deepEqual([done.from.record.balance, done.to?.record.balance], [100, 100]);
  // Owned: the principal passed is the caller, and another owner's credited record is not returned.
  const wallets = store.exports.records('wallets');
  store.exports.records('treasurers').create(null, { userId: 'tess' });
  const mint = (await wallets.create({ id: 'tess' }, { name: 'mint' })).record.id as string, bob = (await wallets.create({ id: 'bob' }, { name: 'bob' })).record.id as string;
  const issued = await wallets.transfer({ id: 'tess' }, 'issue', { from: mint, to: bob, amount: 5 });
  assert.equal(issued.to, undefined);
  await assert.rejects(wallets.transfer({ id: 'bob' }, 'issue', { from: bob, to: mint, amount: 1 }), (error: unknown) => error instanceof StoreError && error.code === 'membership_required');
});

test('a record holding a balance cannot be deleted, the issuer\'s included; at 0 it can (#928)', async t => {
  const store = await direct(t, config, { mounts, principalMounts: ['/api/wallets'] });
  store.first.records('treasurers').create(null, { userId: 'tess' });
  const wallet = async (who: string, name: string) => (await store.call('POST', '/api/wallets', { who, body: { name } })).body!.id as string;
  const mint = await wallet('tess', 'mint'), ann = await wallet('ann', 'ann'), empty = await wallet('ann', 'empty');
  const stale = (await store.call('GET', `/api/wallets/${ann}`, { who: 'ann' })).header('etag')!;
  assert.equal((await store.call('POST', '/api/wallets/transfers/issue', { who: 'tess', body: { from: mint, to: ann, amount: 50 } })).status, 200);
  const before = { counts: counts(store.database), wallets: records(store.database, 'wallets') };
  for (const [who, id] of [['ann', ann], ['tess', mint]] as const) {
    const refused = await store.call('DELETE', `/api/wallets/${id}`, { who, headers: { 'idempotency-key': `drop-${who}` } });
    assert.equal(refused.status, 409); assert.equal(code(refused), 'balance_not_zero');
    assert.deepEqual(Object.keys(refused.body!.error as object), ['code', 'message']);
    assert.equal(JSON.stringify(refused.body).includes('50'), false, 'the refusal names no balance');
  }
  // A stale If-Match is still the 412 it always was: the precondition is judged first.
  assert.equal((await store.call('DELETE', `/api/wallets/${ann}`, { who: 'ann', headers: { 'if-match': stale } })).status, 412);
  assert.deepEqual({ counts: counts(store.database), wallets: records(store.database, 'wallets') }, before, 'nothing deleted, no claim kept');
  assert.equal(sum(store.database, 'wallets'), 0);
  // A zero-balance record deletes as ever; once ann pays the supply back, both it and the issuer's record can go.
  assert.equal((await store.call('DELETE', `/api/wallets/${empty}`, { who: 'ann' })).status, 204);
  assert.equal((await store.call('POST', '/api/wallets/transfers/pay', { who: 'ann', body: { from: ann, to: mint, amount: 50 } })).status, 200);
  assert.equal((await store.call('DELETE', `/api/wallets/${ann}`, { who: 'ann', headers: { 'idempotency-key': 'drop-ann' } })).status, 204, 'the refused key kept no claim');
  assert.equal((await store.call('DELETE', `/api/wallets/${mint}`, { who: 'tess' })).status, 204);
  assert.deepEqual(records(store.database, 'wallets'), []);
});

test('no create, PUT or PATCH changes a balance: PUT keeps it, a body naming it is refused (#928)', async t => {
  const { store, ids } = await opened(t, ['a']);
  const created = await store.call('POST', '/api/accounts', { body: { name: 'rich', balance: 1000 } });
  assert.equal(created.status, 422); assert.equal(code(created), 'invalid_record');
  const put = await store.call('PUT', `/api/accounts/${ids.a}`, { body: { name: 'renamed' } });
  assert.equal(put.status, 200); assert.equal((put.body as { balance: number }).balance, 100, 'PUT keeps the stored balance');
  for (const method of ['PUT', 'PATCH']) {
    const minted = await store.call(method, `/api/accounts/${ids.a}`, { body: { name: 'renamed', balance: 0 } });
    assert.equal(minted.status, 422, method); assert.equal(code(minted), 'invalid_record', method);
  }
  assert.equal(code(await store.call('PATCH', `/api/accounts/${ids.a}`, { body: { balance: null } })), 'invalid_record', 'nor cleared');
  assert.equal(sum(store.database, 'accounts'), 0);
  assert.deepEqual(balances(store.database, 'accounts'), { renamed: 100 });
});

test('a host transaction\'s remove refuses a record holding a balance, and the whole transaction rolls back (#928)', async t => {
  const { store, ids } = await opened(t, ['a', 'b']);
  const before = records(store.database, 'accounts');
  assert.throws(() => store.exports.transaction(tx => {
    const accounts = tx.records('accounts');
    accounts.remove(null, ids.b!); // b holds 100
  }), (error: unknown) => error instanceof StoreError && error.status === 409 && error.code === 'balance_not_zero');
  assert.throws(() => store.exports.transaction(tx => {
    const accounts = tx.records('accounts');
    accounts.create(null, { name: 'c' });
    accounts.remove(null, ids.bank!);
  }), (error: unknown) => error instanceof StoreError && error.code === 'balance_not_zero');
  assert.deepEqual(records(store.database, 'accounts'), before, 'the create in the same transaction rolled back too');
  // Emptied by a transfer in the same transaction, the record can go, and the sum is unchanged.
  store.exports.transaction(tx => {
    const accounts = tx.records('accounts');
    accounts.transfer(null, 'move', { from: ids.b!, to: ids.a!, amount: 100 });
    accounts.remove(null, ids.b!);
  });
  assert.equal(sum(store.database, 'accounts'), 0);
  assert.deepEqual(balances(store.database, 'accounts'), { a: 200 });
});

test('ownerless-delete refuses as a whole while any ownerless record holds a balance (#928)', async t => {
  const root = await mkdtemp(join(tmpdir(), 'store-transfer-ownerless-'));
  cleanup(t, () => rm(root, { recursive: true, force: true, maxRetries: 5 }));
  const database = join(root, 'store.sqlite'), at = '2026-09-01T00:00:00.000Z';
  const row = (id: string, name: string, balance: number, owner?: string) => ({ id, createdAt: at, updatedAt: at, ...(owner ? { _owner: owner } : {}), name, balance });
  const ids = ['00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-000000000004'];
  // Written while the collection was shared: an issued supply of 5, a zero record, and one owned record holding -5.
  await seed(database, 'wallets', [row(ids[0]!, 'held', 5), row(ids[1]!, 'zero', 0), row(ids[2]!, 'mint', -5, 'tess'), row(ids[3]!, 'owed', 0)]);
  const options = { collections: config.collections as never, collection: 'wallets' };
  const before = records(database, 'wallets');
  await assert.rejects(deleteOwnerless(database, options), (error: unknown) => error instanceof StoreError && error.status === 409 && error.code === 'balance_not_zero');
  assert.deepEqual(records(database, 'wallets'), before, 'not even the zero-balance ownerless records were deleted');
  // Once the ownerless balances are 0 (moved to an owned record), the command deletes them.
  execute(database, `UPDATE store_records SET data = json_set(data, '$.balance', 0) WHERE id = '${ids[0]}'`);
  execute(database, `UPDATE store_records SET data = json_set(data, '$.balance', 0) WHERE id = '${ids[2]}'`);
  const report = await deleteOwnerless(database, options);
  assert.deepEqual(report.ids, [ids[0], ids[1], ids[3]]);
  assert.deepEqual(records(database, 'wallets').map(record => record.name), ['mint']);
});

test('activation refuses a transfer it could not keep whole', () => {
  const spec = (patch: Record<string, unknown>, extra: Record<string, unknown> = {}): CollectionSpec => ({ ...accounts, ...extra, transfers: { move: { amount: 'balance', ...patch } } }) as unknown as CollectionSpec;
  const refuses = (declared: CollectionSpec, pattern: RegExp) => assert.throws(() => normalize('accounts', declared), pattern);
  refuses(spec({ amount: 'name' }), /amount property name must be a required integer property with an integer default/);
  refuses(spec({ amount: 'missing' }), /amount names missing, which is not a declared property/);
  refuses(spec({}, { schema: { ...balanceSchema(0), properties: { ...balanceSchema(0).properties, balance: { type: 'number' } } } }), /must be a required integer property/);
  refuses(spec({}, { schema: { ...balanceSchema(0), required: ['name'] } }), /must be a required integer property/);
  refuses(spec({}, { defaults: {}, readOnlyProperties: [] }), /must be a required integer property with an integer default/);
  refuses(spec({}, { readOnlyProperties: [], increments: ['balance'] }), /is an increment, which would change the sum outside a transfer/);
  refuses(spec({}, { schema: { type: 'object', additionalProperties: false, required: ['name', 'balance', 'end'], properties: { ...balanceSchema(0).properties, end: { type: 'integer' } } }, defaults: { balance: 0 }, intervals: { start: 'balance', end: 'end' } }), /named by intervals/);
  assert.throws(() => normalize('treasurers', { ...treasurers, transfers: { move: { amount: 'userId' } } } as unknown as CollectionSpec), /a membership collection takes no transfers/);
  // A readOnly balance is allowed because a transfer moves it; without the transfer it is refused as before.
  assert.throws(() => normalize('accounts', { ...accounts, transfers: {} } as unknown as CollectionSpec), /readOnly but no transition sets or stamps it and no transfer moves it/);
  assert.deepEqual(normalize('accounts', accounts as unknown as CollectionSpec).transfers, { move: { amount: 'balance', min: 0 }, fund: { amount: 'balance', min: -1_000_000 } });
  // #928: only a transfer may change the amount, and a record opens at 0.
  refuses(spec({}, { readOnlyProperties: [] }), /amount property balance must be listed under readOnlyProperties/);
  refuses(spec({}, { defaults: { balance: 100 } }), /amount property balance must default to 0/);
  const reset = { from: { name: 'x' }, set: { balance: 0 } };
  refuses(spec({}, { transitions: { reset } }), /amount property balance is set by transition reset/);
});

test('activation refuses members naming a collection that is not a membership collection', async t => {
  await assert.rejects(direct(t, { collections: { accounts: { ...accounts, transfers: { move: { amount: 'balance', members: 'accounts' } } } } }, { mounts: ['/api/accounts'] }), /transfer move: members names accounts, which is not a membership collection/);
});
