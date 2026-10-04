// The checks tests/requests.json cannot express: a fixture sends one request at a time, so it can never
// hold one request open while another changes state, send two at once, wait for work that happens after
// an answer, break the data directory, or look at an operating-system process. These are ordinary
// node:test checks against a started server:
//
//   node --test tests/in-flight.test.mjs
//
// Each scenario takes the server's origin and throws when the application breaks the expectation.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { startServer } from '@jimhoyd/urlcode';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function call(origin, method, path, token, { body, headers = {} } = {}) {
  const response = await fetch(origin + path, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, body: await response.json() };
}
async function channel(origin) {
  const { body: { id, owner } } = await call(origin, 'POST', '/channels');
  const { body: member } = await call(origin, 'POST', `/channels/${id}/tokens`, owner);
  return { id, owner, member, events: `/channels/${id}/events` };
}
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function until(done, what) {
  for (let waited = 0; waited < 3000; waited += 25) { if (await done()) return; await pause(25); }
  assert.fail(what);
}

export const scenarios = {
  // Permission change while an operation waits: a read that is pending when its credential is revoked
  // must end refused, and must not deliver what is published afterwards.
  async 'a pending read ends at revocation and delivers nothing published after it'(origin) {
    const { owner, member, events } = await channel(origin);
    const pending = call(origin, 'GET', `${events}?wait=1500`, member.token);
    await pause(200); // the read is now waiting
    assert.equal((await call(origin, 'DELETE', `${events.replace('/events', '/tokens')}/${member.tokenId}`, owner)).status, 200);
    assert.equal((await call(origin, 'POST', events, owner, { body: { text: 'after revocation' } })).status, 201);
    const answer = await pending;
    assert.equal(answer.status, 401, `the pending read answered ${answer.status} ${JSON.stringify(answer.body)}`);
  },

  // Concurrent mutation: publishes that arrive together are applied one at a time, and never past capacity.
  async 'concurrent publishes get distinct sequence numbers and stop at capacity'(origin) {
    const { owner, events } = await channel(origin);
    const answers = await Promise.all(Array.from({ length: 8 }, (_, index) => call(origin, 'POST', events, owner, { body: { text: `e${index}` } })));
    assert.deepEqual(answers.filter(answer => answer.status === 201).map(answer => answer.body.seq).sort(), [1, 2, 3]);
    assert.equal(answers.filter(answer => answer.status === 507).length, 5);
    assert.equal((await call(origin, 'GET', events, owner)).body.events.length, 3);
  },

  // Idempotency under concurrency: the same key sent at once publishes once.
  async 'concurrent replays of one idempotency key publish one event'(origin) {
    const { owner, events } = await channel(origin);
    const send = () => call(origin, 'POST', events, owner, { body: { text: 'once' }, headers: { 'idempotency-key': 'k1' } });
    const answers = await Promise.all([send(), send(), send(), send()]);
    assert.deepEqual(answers.map(answer => [answer.status, answer.body.seq]), Array(4).fill([201, 1]));
    assert.equal((await call(origin, 'GET', events, owner)).body.events.length, 1);
  },

  // Delayed cleanup failure: cleanup that fails after the answer stays visible and can be repeated.
  async 'a failed cleanup after delete is reported as failed and succeeds when repeated'(origin, { dataDir }) {
    const { id, owner, events } = await channel(origin);
    const object = join(dataDir, `object-${id}`);
    rmSync(object); mkdirSync(object); writeFileSync(join(object, 'in-the-way'), ''); // removing the object now fails
    assert.equal((await call(origin, 'DELETE', `/channels/${id}`, owner)).status, 202);
    let cleanup;
    await until(async () => (cleanup = (await call(origin, 'GET', events, owner)).body.cleanup) !== 'pending', 'cleanup never finished');
    assert.equal(cleanup, 'failed', 'a cleanup that could not remove the object must not be reported as done');
    rmSync(object, { recursive: true }); writeFileSync(object, 'stored bytes');
    assert.equal((await call(origin, 'DELETE', `/channels/${id}`, owner)).status, 202);
    await until(async () => (await call(origin, 'GET', events, owner)).body.cleanup === 'done', 'the repeated cleanup never finished');
  },

  // Owned-process termination: cancel ends every process the job started. Only a test outside the
  // application can see that; the application's own "cancelled" answer is not evidence.
  async 'cancelling a job ends the process it started and that process\'s own child'(origin) {
    const { id, owner } = await channel(origin);
    const { body: { job, pids } } = await call(origin, 'POST', `/channels/${id}/jobs`, owner);
    try {
      assert.deepEqual(pids.map(alive), [true, true]);
      assert.equal((await call(origin, 'DELETE', `/channels/${id}/jobs/${job}`, owner)).body.state, 'cancelled');
      await until(() => !pids.some(alive), `still running after cancel: ${pids.filter(alive).join(', ')}`);
    } finally {
      for (const pid of pids) try { process.kill(pid); } catch { /* already gone */ }
    }
  },
};

test('stateful handler checks a fixture cannot express', async t => {
  const dataDir = mkdtempSync(join(tmpdir(), 'stateful-verification-'));
  const app = await startServer({ project: fileURLToPath(new URL('..', import.meta.url)), port: 0, local: true, dataDir, log: () => {} });
  t.after(async () => { await app.close(); rmSync(dataDir, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${app.address.port}`;
  for (const [name, scenario] of Object.entries(scenarios)) await t.test(name, () => scenario(origin, { dataDir }));
});
