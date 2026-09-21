// Runs the Cloudflare build of examples/body-validation on a real workerd (via
// `wrangler dev --local`) and compares it with the self-hosted server, request
// by request. Optional and never part of `npm run verify`: it needs the network
// to install wrangler into a scratch directory, which it does outside the repo.
// Exit 0 with SKIP when workerd cannot be installed or started here.
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';

const repo = resolve(import.meta.dirname, '..');
const npm = process.env.npm_execpath ?? '';
const wranglerSpec = `wrangler@${process.env.WRANGLER_VERSION ?? 'latest'}`;
const scratch = await mkdtemp(join(tmpdir(), 'urlcode-workerd-'));
const children: ChildProcess[] = [];
const skip = (why: string): never => { console.log(`SKIP: ${why}`); process.exitCode = 0; throw new Error('skip'); };
const run = (bin: string, args: string[], cwd: string): string => {
  const r = spawnSync(bin, args, { cwd, encoding: 'utf8', timeout: 240000 });
  if (r.status !== 0) skip(`${bin} ${args.join(' ')} failed: ${(r.stderr || r.error?.message || '').slice(0, 300)}`);
  return r.stdout;
};
const freePort = (): Promise<number> => new Promise(done => { const s = createServer().listen(0, '127.0.0.1', () => { const p = (s.address() as { port: number }).port; s.close(() => done(p)); }); });
const ready = async (port: number, path: string): Promise<void> => {
  for (let i = 0; i < 60; i++) { try { if ((await fetch(`http://127.0.0.1:${port}${path}`)).status < 500) return; } catch { /* not up yet */ } await new Promise(r => setTimeout(r, 500)); }
  skip(`nothing answered on port ${port}`);
};

const secret = 'sk_live_TOPSECRET_9f8e7d';
const json = { 'content-type': 'application/json' };
const post = (path: string, body: unknown, accept?: string, headers: Record<string, string> = {}) => ({ path, method: 'POST', headers: { ...json, ...(accept ? { accept } : {}), ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });
const cases: Record<string, { path: string; method?: string; headers?: Record<string, string>; body?: string }> = {
  'valid body': post('/todos', { title: 'x' }, 'application/json'),
  'invalid, Accept json': post('/todos', { title: '', extra: secret }, 'application/json'),
  'missing required, Accept json': post('/todos', {}, 'application/json'),
  'invalid, Accept text/plain': post('/todos', { title: '', extra: secret }, 'text/plain'),
  'invalid, no Accept': post('/todos', { title: '', extra: secret }),
  'invalid, Accept */*': post('/todos', { title: '', extra: secret }, '*/*'),
  'invalid, json;q=0': post('/todos', { title: '', extra: secret }, 'application/json;q=0'),
  'malformed JSON': post('/todos', '{bad', 'application/json'),
  'oversize body': post('/todos', JSON.stringify({ title: 'x'.repeat(5000) }), 'application/json'),
  'wrong content type': post('/todos', '{}', 'application/json', { 'content-type': 'text/plain' }),
  'uuid valid': { path: '/todos/123e4567-e89b-12d3-a456-426614174000' },
  'uuid invalid': { path: '/todos/not-a-uuid' },
  'query pattern bad': { path: '/tags?slug=BAD!' },
  'body pattern, 128-char worst case': post('/pat', { v: 'a'.repeat(128) }, 'application/json'),
  'body pattern, 129 chars': post('/pat', { v: 'a'.repeat(129) }, 'application/json'),
  'query pattern, 128-char worst case': { path: `/q?v=${'a'.repeat(128)}` },
};
const volatile = new Set(['date', 'server', 'connection', 'keep-alive', 'transfer-encoding', 'content-length', 'x-request-id']);
// workerd gzips a response when the client sends Accept-Encoding (docs/CLOUDFLARE.md: compression is delegated to the edge); fetch() decodes it, so the body still compares byte for byte.
volatile.add('content-encoding');

try {
  if (!npm) skip('run through npm run test:workerd');
  // The example plus two routes that exercise the 128-character `pattern` cap in a body and a query parameter.
  const extra = `  /pat:
    methods: [POST]
    request:
      body:
        format: json
        contentTypes: [application/json]
        schema:
          type: object
          required: [v]
          properties:
            v: {type: string, pattern: "^[a-z]*[a-z]*[a-z]*!$", maxLength: 128}
    respond: {status: 201, json: {ok: true}}
  /q:
    parameters:
      - {name: v, in: query, required: true, schema: {type: string, pattern: "^[a-z]*[a-z]*[a-z]*!$", maxLength: 128}}
    respond: {json: {ok: true}}
`;
  const project = join(scratch, 'project'), work = join(scratch, 'worker');
  const base = await readFile(join(repo, 'examples/body-validation/urlcode.yaml'), 'utf8');
  await mkdir(project); await mkdir(work);
  await writeFile(join(project, 'urlcode.yaml'), base + extra);
  run(process.execPath, [join(repo, 'dist/cli.js'), 'validate', '--project', project], repo);
  const tarball = (JSON.parse(run(process.execPath, [npm, 'pack', '--ignore-scripts', '--json', '--pack-destination', scratch], repo)) as { filename: string }[])[0]!.filename;
  await writeFile(join(work, 'package.json'), '{"private":true,"type":"module"}');
  run(process.execPath, [npm, 'install', '--no-audit', '--no-fund', wranglerSpec, join(scratch, tarball)], work);
  run(process.execPath, [join(repo, 'dist/cli.js'), 'build', '--target', 'cloudflare', '--project', project, '--out', work], repo);
  await writeFile(join(work, 'wrangler.toml'), 'name = "parity"\nmain = "index.js"\ncompatibility_date = "2026-09-01"\n');
  const wrangler = join(work, 'node_modules/wrangler/bin/wrangler.js');
  const version = run(process.execPath, [wrangler, '--version'], work).trim();
  const [workerdPort, nodePort] = [await freePort(), await freePort()];
  const env = { ...process.env, CI: '1', WRANGLER_SEND_METRICS: 'false', WRANGLER_LOG: 'warn' };
  children.push(spawn(process.execPath, [wrangler, 'dev', '--local', '--port', String(workerdPort)], { cwd: work, env, stdio: 'ignore', detached: process.platform !== 'win32' }));
  children.push(spawn(process.execPath, [join(repo, 'dist/cli.js'), 'serve', '--project', project, '--port', String(nodePort)], { cwd: repo, stdio: 'ignore' }));
  await Promise.all([ready(workerdPort, '/tags?slug=ok'), ready(nodePort, '/tags?slug=ok')]);

  const call = async (port: number, c: (typeof cases)[string]) => {
    const started = performance.now();
    const r = await fetch(`http://127.0.0.1:${port}${c.path}`, { method: c.method ?? 'GET', ...(c.headers ? { headers: c.headers } : {}), ...(c.body !== undefined ? { body: c.body } : {}) });
    const body = await r.text();
    return { status: r.status, body, ms: performance.now() - started, headers: JSON.stringify([...r.headers].filter(([k]) => !volatile.has(k)).sort()) };
  };
  let different = 0;
  console.log(`wrangler ${version}; workerd port ${workerdPort}, node port ${nodePort}`);
  for (const [name, c] of Object.entries(cases)) {
    const w = await call(workerdPort, c), n = await call(nodePort, c);
    const same = w.status === n.status && w.body === n.body && w.headers === n.headers && !w.body.includes('TOPSECRET');
    if (!same) different++;
    console.log(`${same ? 'SAME' : 'DIFF'} ${w.status} ${name} (workerd ${w.ms.toFixed(1)} ms, node ${n.ms.toFixed(1)} ms)`);
    if (!same) console.log(`  workerd ${w.status} ${w.headers} ${JSON.stringify(w.body)}\n  node    ${n.status} ${n.headers} ${JSON.stringify(n.body)}`);
  }
  console.log(different ? `${different} request(s) differ` : 'all responses identical (status, headers except request id, body)');
  if (different) process.exitCode = 1;
} catch (error) {
  if (!(error instanceof Error && error.message === 'skip')) throw error;
} finally {
  // wrangler leaves workerd as its own child, so end the whole process group where there is one.
  for (const child of children) { try { if (child.pid && process.platform !== 'win32') process.kill(-child.pid); else child.kill(); } catch { child.kill(); } }
  await rm(scratch, { recursive: true, force: true });
}
