// jimhoyd-com/urlcode#930 end to end with the real auth and store extensions: `urlcode test` needs no
// `urlcode-auth migrate`, `create-user` or `urlcode-store members add`, never touches the site's data/, and passes again
// on a rerun, because each run composes the host on a fresh data directory and seeds it from tests/seed.json.
// Needs the built core (npm run build): the packages import @jimhoyd/urlcode/extensions from dist.
import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { stringify } from 'yaml';
import { loadOperatorHost } from '../packages/core/src/operator-host.ts';
import { runProjectTests } from '../packages/core/src/project-tests.ts';
import { inspectExtensionRevision } from '../packages/core/src/extensions.ts';

const origin = 'http://localhost:8930';
const json = { 'content-type': 'application/json', origin: '{{origin}}' };
const signIn = (email: string) => ({ path: '/api/auth/sign-in/email', method: 'POST', headers: json, body: JSON.stringify({ email, password: 'correct horse battery' }), status: 200 });
const fixtures = [
  { steps: [
    signIn('bob@example.test'),
    { path: '/api/notes', method: 'POST', headers: json, body: '{"title":"first"}', status: 201, expectJson: { '/title': 'first' }, capture: { id: { json: 'id' } } },
    { path: '/api/notes/{{id}}', status: 200, expectJson: { '/id': '{{id}}', '/title': 'first' } },
    { path: '/api/review', status: 403 },
  ] },
  { steps: [signIn('alice@example.test'), { path: '/api/review', status: 200, expectJson: { '/items/0/title': 'first' } }] },
];
const seed = {
  auth: { users: [{ id: 'alice', email: 'alice@example.test', password: 'correct horse battery' }, { id: 'bob', email: 'bob@example.test', password: 'correct horse battery', name: 'Bob' }] },
  store: { members: { reviewers: ['alice'] } },
};

test('a site with accounts and memberships tests hermetically, again and again, from a declared seed', { timeout: 120000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'urlcode-hermetic-accounts-'));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));
  const app = join(dir, 'app');
  await mkdir(join(app, 'tests'), { recursive: true });
  await writeFile(join(app, 'urlcode.yaml'), stringify({ version: '1',
    extensions: { auth: { version: '1', config: {} }, store: { version: '1', config: { collections: {
      reviewers: { membership: true, key: 'userId', schema: { type: 'object', additionalProperties: false, required: ['userId'], properties: { userId: { type: 'string', maxLength: 128 } } } },
      notes: { mount: '/api/notes', ownership: 'owner', readers: { mount: '/api/review', members: 'reviewers' }, schema: { type: 'object', additionalProperties: false, required: ['title'], properties: { title: { type: 'string', maxLength: 100 } } } },
    } } } },
    routes: {
      '/api/auth/*': { extension: 'auth', methods: ['GET', 'POST'] },
      '/api/notes/*': { extension: 'store', methods: ['GET', 'HEAD', 'POST'], auth: true },
      '/api/review/*': { extension: 'store', methods: ['GET', 'HEAD'], auth: true },
    } }));
  await writeFile(join(app, 'tests', 'requests.json'), JSON.stringify(fixtures));
  await writeFile(join(app, 'tests', 'seed.json'), JSON.stringify(seed));
  const source = (pkg: string) => JSON.stringify(pathToFileURL(join(import.meta.dirname, '..', 'packages', pkg, 'src', 'extension.ts')).href);
  // The operator's live options point elsewhere; a check run ignores them.
  await writeFile(join(dir, 'host.mjs'), `import { composeHost } from ${JSON.stringify(pathToFileURL(join(import.meta.dirname, '..', 'packages', 'core', 'src', 'host.ts')).href)};
import auth from ${source('auth')};
import store from ${source('store')};
export default await composeHost(import.meta.url, [auth({ secretFile: 'missing.secret' }), store({ database: ${JSON.stringify(join(dir, 'live', 'store.sqlite'))} })]);
`);
  const previous = process.env.PROJECT_SHA256;
  process.env.PROJECT_SHA256 = await inspectExtensionRevision(app);
  t.after(() => { if (previous === undefined) delete process.env.PROJECT_SHA256; else process.env.PROJECT_SHA256 = previous; });
  for (let run = 1; run <= 2; run++) {
    const events: object[] = [];
    const host = await loadOperatorHost(join(dir, 'host.mjs'), app, { hermetic: true });
    try { assert.deepEqual(await runProjectTests(app, { origin, extensions: host.extensions, log: event => events.push(event) }), { total: 6, failed: 0 }, `run ${run}: ${JSON.stringify(events)}`); }
    finally { await host.close!(); }
  }
  for (const path of ['data', 'live']) assert.equal(await access(join(dir, path)).then(() => true, () => false), false, `${path}/ is never created`);
  // A member of a collection that is not a membership collection refuses activation, naming it.
  await writeFile(join(app, 'tests', 'seed.json'), JSON.stringify({ ...seed, store: { members: { notes: ['alice'] } } }));
  const host = await loadOperatorHost(join(dir, 'host.mjs'), app, { hermetic: true });
  try { await assert.rejects(runProjectTests(app, { origin, extensions: host.extensions, log: () => {} }), /members names notes, which is not a declared membership collection/); }
  finally { await host.close!(); }
});
