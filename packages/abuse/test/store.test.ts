import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { AbuseError } from '../src/index.ts';
import { backoffDelay, normalizeBackoff } from '../src/budget.ts';
import { rejectsWith, setup } from './helpers.ts';

test('before activation the exports are inactive and namespace() refuses with abuse_inactive', async t => {
  const { abuse } = await setup(t, { activate: false });
  assert.equal(abuse.exports.version, 1);
  assert.equal(abuse.exports.active, false);
  assert.equal(abuse.exports.challenge, undefined);
  assert.throws(() => abuse.exports.namespace('forms'), (error: unknown) => error instanceof AbuseError && error.status === 503 && error.code === 'abuse_inactive');
});

test('admit checks every counter before incrementing any, and a refusal increments nothing', async t => {
  const { abuse } = await setup(t);
  const ns = abuse.exports.namespace('forms');
  const tight = ns.budget({ scope: 'tight', limit: 1, windowMs: 10000 }), loose = ns.budget({ scope: 'loose', limit: 5, windowMs: 10000 });
  assert.deepEqual(await ns.admit([{ budget: tight, value: 'x' }, { budget: loose, value: 'y' }]), { allowed: true, challengeRequired: false });
  const refused = await ns.admit([{ budget: tight, value: 'x' }, { budget: loose, value: 'y' }]);
  assert.equal(refused.allowed, false);
  assert.equal(refused.allowed === false && refused.status, 429);
  // loose stayed at 1: four more fit, the fifth is refused.
  for (let i = 0; i < 4; i++) assert.equal((await ns.admit([{ budget: loose, value: 'y' }])).allowed, true);
  assert.equal((await ns.admit([{ budget: loose, value: 'y' }])).allowed, false);
});

test('a fixed window from the first hit, with Retry-After from the latest-expiring exceeded counter', async t => {
  const { abuse, tick } = await setup(t);
  const ns = abuse.exports.namespace('forms');
  const a = ns.budget({ scope: 'a', limit: 2, windowMs: 10000 }), b = ns.budget({ scope: 'b', limit: 1, windowMs: 30000 });
  assert.equal((await ns.admit([{ budget: a, value: 'v' }])).allowed, true);
  tick(5000);
  assert.equal((await ns.admit([{ budget: a, value: 'v' }, { budget: b, value: 'v' }])).allowed, true);
  tick(4000);
  assert.deepEqual(await ns.admit([{ budget: a, value: 'v' }]), { allowed: false, status: 429, code: 'rate_limited', retryAfterSeconds: 1 });
  // Both exceeded: a expires in 1 s, b (opened 4 s ago for 30 s) in 26 s.
  assert.deepEqual(await ns.admit([{ budget: a, value: 'v' }, { budget: b, value: 'v' }]), { allowed: false, status: 429, code: 'rate_limited', retryAfterSeconds: 26 });
  tick(1000);
  assert.deepEqual(await ns.admit([{ budget: a, value: 'v' }]), { allowed: true, challengeRequired: false });
});

test('challengeRequired once any count exceeds its challengeAfter', async t => {
  const { abuse } = await setup(t);
  const ns = abuse.exports.namespace('auth');
  const client = ns.budget({ scope: 'client', limit: 4, windowMs: 10000, challengeAfter: 1 }), plain = ns.budget({ scope: 'signup-domain', limit: 4, windowMs: 10000 });
  assert.deepEqual(await ns.admit([{ budget: client, value: '192.0.2.1' }, { budget: plain, value: 'example.test' }]), { allowed: true, challengeRequired: false });
  assert.deepEqual(await ns.admit([{ budget: client, value: '192.0.2.1' }, { budget: plain, value: 'example.test' }]), { allowed: true, challengeRequired: true });
  assert.deepEqual(await ns.admit([{ budget: plain, value: 'example.test' }]), { allowed: true, challengeRequired: false });
});

test('concurrent admits never pass the limit', async t => {
  const { abuse } = await setup(t);
  const ns = abuse.exports.namespace('forms'), budget = ns.budget({ scope: 'client', limit: 4, windowMs: 10000 });
  const results = await Promise.all(Array.from({ length: 8 }, () => ns.admit([{ budget, value: '192.0.2.3' }])));
  assert.equal(results.filter(result => result.allowed).length, 4);
});

test('the table is bounded: capacity answers 503, and each add sweeps at most 1000 expired rows', async t => {
  const { abuse, database, now, tick } = await setup(t, { maxKeys: 1000 });
  const ns = abuse.exports.namespace('forms'), budget = ns.budget({ scope: 'client', limit: 5, windowMs: 1000 }), backoff = ns.backoff({ scope: 'password' });
  const other = new DatabaseSync(database);
  t.after(() => other.close());
  const fill = (count: number, expires: number, prefix: string) => { other.exec('BEGIN'); const insert = other.prepare('INSERT INTO abuse_counters VALUES(?,1,?,0)'); for (let i = 0; i < count; i++) insert.run(prefix + i, expires); other.exec('COMMIT'); };
  const rows = () => Number((other.prepare('SELECT count(*) AS n FROM abuse_counters').get() as { n: number }).n);
  fill(1000, now() + 1000, 'live-');
  assert.deepEqual(await ns.admit([{ budget, value: 'new' }]), { allowed: false, status: 503, code: 'abuse_capacity' });
  await assert.rejects(backoff.failure('new@example.test'), (error: unknown) => error instanceof AbuseError && error.status === 503 && error.code === 'abuse_capacity');
  assert.equal(rows(), 1000);
  tick(1000);
  assert.deepEqual(await ns.admit([{ budget, value: 'new' }]), { allowed: true, challengeRequired: false });
  assert.equal(rows(), 1);
  // The sweep is bounded: 2500 expired rows lose 1000 per add.
  fill(2500, now(), 'old-');
  tick(1);
  const refused = await ns.admit([{ budget, value: 'another' }]);
  assert.deepEqual(refused, { allowed: false, status: 503, code: 'abuse_capacity' });
  assert.equal(rows(), 1501);
});

test('the default bound is 100000 rows and the sweep still deletes at most 1000', async t => {
  const { abuse, database, now, tick } = await setup(t);
  const ns = abuse.exports.namespace('forms'), budget = ns.budget({ scope: 'client', limit: 5, windowMs: 1000 });
  const other = new DatabaseSync(database);
  t.after(() => other.close());
  other.exec('BEGIN');
  const insert = other.prepare('INSERT INTO abuse_counters VALUES(?,1,?,0)');
  for (let i = 0; i < 2500; i++) insert.run('old-' + i, now());
  other.exec('COMMIT');
  tick(1);
  assert.equal((await ns.admit([{ budget, value: 'v' }])).allowed, true);
  assert.equal(Number((other.prepare('SELECT count(*) AS n FROM abuse_counters').get() as { n: number }).n), 1501);
});

test('backoff follows the delay formula, persists, resets after resetAfterMs and clears', async t => {
  const { abuse, tick } = await setup(t);
  const ns = abuse.exports.namespace('auth'), backoff = ns.backoff({ scope: 'password', threshold: 2, initialDelayMs: 1000, maxDelayMs: 8000, resetAfterMs: 60000 });
  assert.deepEqual({ ...await backoff.check('reader@example.test') }, { blocked: false, retryAfterSeconds: 0 });
  // failure n → blocked for backoffDelay(n): 0, 1, 2, 4, 8, 8 seconds.
  for (const [n, seconds] of [[1, 0], [2, 1], [3, 2], [4, 4], [5, 8], [6, 8]] as const) {
    await backoff.failure('reader@example.test');
    assert.deepEqual({ ...await backoff.check('reader@example.test') }, { blocked: seconds > 0, retryAfterSeconds: seconds }, `failure ${n}`);
  }
  tick(8000);
  assert.equal((await backoff.check('reader@example.test')).blocked, false);
  // Still counted: one more failure blocks at the cap again.
  await backoff.failure('reader@example.test');
  assert.deepEqual({ ...await backoff.check('reader@example.test') }, { blocked: true, retryAfterSeconds: 8 });
  await backoff.clear('reader@example.test');
  assert.equal((await backoff.check('reader@example.test')).blocked, false);
  await backoff.failure('reader@example.test');
  assert.equal((await backoff.check('reader@example.test')).blocked, false);
  // resetAfterMs forgets the count.
  await backoff.failure('reader@example.test');
  assert.equal((await backoff.check('reader@example.test')).blocked, true);
  tick(60000);
  await backoff.failure('reader@example.test');
  assert.equal((await backoff.check('reader@example.test')).blocked, false);
});

test('the backoff formula table', () => {
  const spec = normalizeBackoff({ scope: 'password', threshold: 5, initialDelayMs: 1000, maxDelayMs: 900000, resetAfterMs: 86400000 });
  assert.deepEqual([1, 4, 5, 6, 7, 10, 15, 64].map(count => backoffDelay(count, spec)), [0, 0, 1000, 2000, 4000, 32000, 900000, 900000]);
  const huge = normalizeBackoff({ scope: 'password', threshold: 1, initialDelayMs: 100, maxDelayMs: 86400000, resetAfterMs: 86400000 });
  assert.equal(backoffDelay(64, huge), 86400000);
  assert.deepEqual(normalizeBackoff({ scope: 'password' }), { scope: 'password', threshold: 5, initialDelayMs: 1000, maxDelayMs: 900000, resetAfterMs: 86400000 });
});

test('namespaces and scopes isolate the same value', async t => {
  const { abuse } = await setup(t);
  const auth = abuse.exports.namespace('auth'), forms = abuse.exports.namespace('forms');
  const a = auth.budget({ scope: 'client', limit: 1, windowMs: 10000 }), b = forms.budget({ scope: 'client', limit: 1, windowMs: 10000 }), c = auth.budget({ scope: 'signup-client', limit: 1, windowMs: 10000 });
  assert.equal((await auth.admit([{ budget: a, value: '192.0.2.1' }])).allowed, true);
  assert.equal((await auth.admit([{ budget: a, value: '192.0.2.1' }])).allowed, false);
  assert.equal((await forms.admit([{ budget: b, value: '192.0.2.1' }])).allowed, true);
  assert.equal((await auth.admit([{ budget: c, value: '192.0.2.1' }])).allowed, true);
  assert.equal((await auth.admit([{ budget: a, value: '192.0.2.2' }])).allowed, true);
});

test('counter keys are HMACs: no raw value reaches the database files', async t => {
  const { abuse, database } = await setup(t);
  const ns = abuse.exports.namespace('auth');
  const values = ['reader@example.test', '203.0.113.77', 'example.test'];
  await ns.admit(values.map((value, index) => ({ budget: ns.budget({ scope: `s${index}`, limit: 5, windowMs: 10000 }), value })));
  await ns.backoff({ scope: 'password' }).failure('reader@example.test');
  const keys = new DatabaseSync(database, { readOnly: true });
  const stored = (keys.prepare('SELECT key FROM abuse_counters').all() as { key: string }[]).map(row => row.key);
  keys.close();
  assert.equal(stored.length, 4);
  assert.ok(stored.every(key => /^[a-f0-9]{64}$/.test(key)));
  await abuse.close();
  const bytes = Buffer.concat(await Promise.all([database, database + '-wal'].filter(existsSync).map(path => readFile(path))));
  for (const value of values) assert.equal(bytes.includes(Buffer.from(value)), false, value);
});

test('storage failures and a closed store reject abuse_unavailable, never admit', async t => {
  const { abuse, database } = await setup(t);
  const ns = abuse.exports.namespace('forms'), budget = ns.budget({ scope: 'client', limit: 5, windowMs: 1000 }), backoff = ns.backoff({ scope: 'password' });
  const other = new DatabaseSync(database);
  other.exec('DROP TABLE abuse_counters');
  other.close();
  await assert.rejects(ns.admit([{ budget, value: 'v' }]), rejectsWith('abuse_unavailable'));
  await assert.rejects(backoff.check('v'), rejectsWith('abuse_unavailable'));
  await abuse.close();
  assert.equal(abuse.exports.active, false);
  for (const operation of [() => ns.admit([{ budget, value: 'v' }]), () => backoff.check('v'), () => backoff.failure('v'), () => backoff.clear('v')])
    await assert.rejects(operation(), (error: unknown) => error instanceof AbuseError && error.status === 503 && error.code === 'abuse_unavailable');
});

test('every spec bound is enforced with invalid_abuse_spec', async t => {
  const { abuse } = await setup(t);
  const invalid = (error: unknown) => error instanceof AbuseError && error.status === 400 && error.code === 'invalid_abuse_spec';
  for (const name of ['', 'Auth', '1auth', 'a'.repeat(33), 'a_b', 7]) assert.throws(() => abuse.exports.namespace(name as string), invalid, String(name));
  assert.equal(abuse.exports.namespace('a'.repeat(32)).name, 'a'.repeat(32));
  const ns = abuse.exports.namespace('forms');
  const good = { scope: 'client', limit: 10, windowMs: 1000 };
  assert.deepEqual({ ...ns.budget({ ...good, limit: 100000, windowMs: 86400000, challengeAfter: 99999 }) }, { namespace: 'forms', scope: 'client', limit: 100000, windowMs: 86400000, challengeAfter: 99999 });
  for (const spec of [{ ...good, scope: 'Client' }, { ...good, scope: 'c'.repeat(33) }, { ...good, limit: 0 }, { ...good, limit: 100001 }, { ...good, limit: 1.5 }, { ...good, windowMs: 999 }, { ...good, windowMs: 86400001 },
    { ...good, challengeAfter: 0 }, { ...good, challengeAfter: 10 }, { ...good, limit: 1, challengeAfter: 1 }, { ...good, extra: true }, null, []])
    assert.throws(() => ns.budget(spec as never), invalid, JSON.stringify(spec));
  const backoff = { scope: 'password' };
  ns.backoff({ ...backoff, threshold: 20, initialDelayMs: 60000, maxDelayMs: 86400000, resetAfterMs: 604800000 });
  for (const spec of [{ scope: 'Password' }, { ...backoff, threshold: 0 }, { ...backoff, threshold: 21 }, { ...backoff, initialDelayMs: 99 }, { ...backoff, initialDelayMs: 60001 }, { ...backoff, initialDelayMs: 2000, maxDelayMs: 1000 },
    { ...backoff, maxDelayMs: 86400001 }, { ...backoff, maxDelayMs: 2000, resetAfterMs: 1000 }, { ...backoff, resetAfterMs: 604800001 }, { ...backoff, extra: 1 }])
    assert.throws(() => ns.backoff(spec as never), invalid, JSON.stringify(spec));
  // A scope is one kind of counter within a namespace.
  assert.throws(() => ns.budget({ scope: 'password', limit: 5, windowMs: 1000 }), invalid);
  assert.throws(() => ns.backoff({ scope: 'client' }), invalid);
  const budget = ns.budget(good), foreign = abuse.exports.namespace('auth').budget(good);
  for (const entries of [[], Array.from({ length: 9 }, (_, i) => ({ budget, value: `v${i}` })), [{ budget: foreign, value: 'v' }], [{ budget: { ...budget }, value: 'v' }], [{ budget, value: '' }], [{ budget, value: 'v'.repeat(1025) }], [{ budget, value: 7 }], [{ budget, value: 'v' }, { budget, value: 'v' }], 'nope'])
    await assert.rejects(ns.admit(entries as never), invalid, JSON.stringify(entries).slice(0, 80));
  assert.equal((await ns.admit(Array.from({ length: 8 }, (_, i) => ({ budget, value: `v${i}`.padEnd(i === 7 ? 1024 : 2, 'x') })))).allowed, true);
  const handle = ns.backoff({ scope: 'password' });
  for (const value of ['', 'v'.repeat(1025), 7]) await assert.rejects(handle.failure(value as string), invalid);
});

test('the honeypot helper renders a hidden escaped field and treats any non-empty value as filled', async t => {
  const { abuse } = await setup(t);
  assert.equal(abuse.exports.honeypot.markup('website'), '<div hidden><label>Leave this field empty<input name="website" tabindex="-1" autocomplete="off"></label></div>');
  for (const field of ['', 'Website', '"><script>', 'a'.repeat(65), 'a-b']) assert.throws(() => abuse.exports.honeypot.markup(field), rejectsWith('invalid_abuse_spec'));
  assert.equal(abuse.exports.honeypot.filled(undefined), false);
  assert.equal(abuse.exports.honeypot.filled(''), false);
  assert.equal(abuse.exports.honeypot.filled('x'), true);
  assert.equal(abuse.exports.honeypot.filled(['x']), true);
});
