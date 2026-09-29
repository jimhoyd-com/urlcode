// Store throughput and latency benchmark (#859 items 1 and 5). Manual only: never part of `npm test` or `verify`.
//
//   npm run bench:store                 # full run (a few minutes)
//   npm run bench:store -- --quick      # smaller counts, for checking the script itself
//   npm run bench:store -- --json out.json
//
// Three parts, each printed as a table:
//   1. HTTP: a real server (a child process running startServer with the store, audit and a header principal) driven
//      by a bounded keep-alive node:http client at fixed concurrency. Creates (Idempotency-Key), PATCH with If-Match
//      and declared transitions on an owned collection with audit off and on, then list latency at page sizes 20 and
//      100 over 1,000 and 10,000 records (the configurable maximum). The server samples its own event-loop delay
//      (monitorEventLoopDelay) during every phase.
//   2. Commit micro-benchmark: single-row WAL transactions under synchronous=FULL, NORMAL and FULL with fullfsync,
//      on a private database. The store's own setting is not changed; this only measures the difference.
//   3. List micro-benchmark: the store's sorted/filtered list path (projection query, JS ordering via runList, page
//      fetch) at 1k/10k/50k records, beside an ORDER BY ... LIMIT in SQL with and without an expression index. 50k is
//      above the configurable maxRecords and is measured only to show the curve.
import { fork } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { Agent, request } from 'node:http';
import { cpus, tmpdir, totalmem, platform, release } from 'node:os';
import { join } from 'node:path';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const args = process.argv.slice(2);
const quick = args.includes('--quick');
const jsonOut = args.includes('--json') ? args[args.indexOf('--json') + 1] : undefined;
const origin = 'https://store-bench.example.test';
const CONCURRENCY = 16;
const WRITES = quick ? 300 : 3000;
const LIST_REQUESTS = quick ? 50 : 400;
const COMMITS = quick ? 300 : 3000;
const LIST_ITERATIONS = quick ? 5 : 30;

const schema = {
  type: 'object', additionalProperties: false, required: ['title'],
  properties: {
    title: { type: 'string', maxLength: 64 },
    priority: { type: 'integer', minimum: 1, maximum: 5 },
    kind: { type: 'string', enum: ['a', 'b', 'c'] },
    status: { type: 'string', enum: ['open', 'closed'] },
  },
};
const collection = (mount: string, audit: boolean) => ({
  mount, ownership: 'owner', idempotency: { maxKeys: 1000 }, audit, maxRecords: 10_000, maxRecordBytes: 1024, pageSize: 100,
  sortable: ['title', 'priority'], filterable: ['kind'], schema,
  defaults: { priority: 3, kind: 'a', status: 'open' }, readOnlyProperties: ['status'],
  transitions: { close: { from: { status: 'open' }, set: { status: 'closed' } }, reopen: { from: { status: 'closed' }, set: { status: 'open' } } },
});
const collections = { items: collection('/api/items', false), audited: collection('/api/audited', true) };

type Row = { id: string; title: string; priority: number; kind: string };
const word = (i: number) => `title-${((i * 2654435761) >>> 0).toString(36)}`;
const synthetic = (i: number): Row => ({ id: randomUUID(), title: word(i), priority: (i % 5) + 1, kind: ['a', 'b', 'c'][i % 3]! });

// ---------------------------------------------------------------------------------------------------------------------
// Server role: the child process. Seeds `seed` records into `items` directly (the way an earlier run would have left
// them), starts the server and answers loop-delay requests over IPC.
async function serve(): Promise<void> {
  const [{ startServer }, { inspectExtensionRevision }, { composeHost }, { default: store }, { default: audit }, { openStoreDatabase }] = await Promise.all([
    import('@jimhoyd/urlcode'), import('@jimhoyd/urlcode/extensions'), import('@jimhoyd/urlcode/host'),
    import('../src/extension.ts'), import('@jimhoyd/urlcode-audit/extension'), import('../src/database.ts'),
  ]);
  const { root, seed } = JSON.parse(process.env.STORE_BENCH_SERVER!) as { root: string; seed: number };
  const project = join(root, 'app');
  await mkdir(project, { recursive: true });
  const guarded = { policies: { extensions: { badge: {} } } };
  await writeFile(join(project, 'urlcode.yaml'), JSON.stringify({
    version: '1',
    extensions: { badge: { version: '1', config: {} }, audit: { version: '1', config: { retention: 1_000_000 } }, store: { version: '1', config: { collections } } },
    routes: Object.fromEntries(Object.values(collections).map(spec => [`${spec.mount}/*`, { extension: 'store', methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'], ...guarded }])),
  }));
  const sha = await inspectExtensionRevision(project);
  process.env.PROJECT_SHA256 = sha;
  if (seed) {
    const db = await openStoreDatabase(join(root, 'data', 'store.sqlite'));
    const now = new Date().toISOString();
    db.transaction(() => {
      for (let i = 0; i < seed; i++) {
        const { id, ...data } = synthetic(i);
        db.run('INSERT INTO store_records(collection, id, owner, key, created_at, updated_at, data) VALUES (?, ?, ?, NULL, ?, ?, ?)', 'items', id, 'bench', now, now, JSON.stringify({ ...data, status: 'open' }));
      }
    });
    db.close();
  }
  const badge = {
    name: 'badge', version: '1', projectSha256: sha, targets: ['node'], providesPrincipal: true,
    schema: { type: 'object', additionalProperties: false }, policySchema: { type: 'object', additionalProperties: false },
    activate() {
      return {
        handle() { return { status: 404, headers: [] }; },
        authorize(_policy: unknown, req: { headers: Headers; setPrincipal?: (p: { id: string }) => void }) {
          const match = /^Badge (\S+)$/.exec(req.headers.get('authorization') ?? '');
          if (match) req.setPrincipal!({ id: match[1]! });
          return undefined;
        },
      };
    },
  };
  const host = await composeHost(pathToFileURL(join(root, 'host.mjs')), [store(), audit()]);
  const app = await startServer({ project, origin, port: 0, log: () => {}, extensions: [...host.extensions!, badge as never] });
  const loop = monitorEventLoopDelay({ resolution: 1 });
  process.on('message', (message: { type: string }) => {
    if (message.type === 'loop-start') { loop.reset(); loop.enable(); process.send!({ type: 'ok' }); }
    else if (message.type === 'loop-stop') {
      loop.disable();
      const ms = (ns: number) => Math.round(ns / 1e4) / 100;
      process.send!({ type: 'loop', p50: ms(loop.percentile(50)), p99: ms(loop.percentile(99)), max: ms(loop.max), mean: ms(loop.mean) });
    } else if (message.type === 'close') { void app.close().then(() => host.close?.()).then(() => process.exit(0)); }
  });
  process.send!({ type: 'ready', port: app.address.port });
}

// ---------------------------------------------------------------------------------------------------------------------
// Load generator: a keep-alive agent with exactly `concurrency` sockets and `concurrency` sequential loops.
interface Req { method: string; path: string; headers?: Record<string, string>; body?: unknown }
interface Res { status: number; headers: Record<string, string | string[] | undefined>; body: string }
function send(agent: Agent, port: number, req: Req): Promise<Res> {
  const body = req.body === undefined ? undefined : JSON.stringify(req.body);
  return new Promise((resolve, reject) => {
    const r = request({ host: '127.0.0.1', port, method: req.method, path: req.path, agent, headers: { origin, authorization: 'Badge bench', ...(body ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } : {}), ...req.headers } }, res => {
      const chunks: Buffer[] = [];
      res.on('data', chunk => chunks.push(chunk as Buffer));
      res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', reject);
    });
    r.on('error', reject);
    r.end(body);
  });
}
interface PhaseResult { phase: string; requests: number; ok: number; statuses: Record<string, number>; seconds: number; perSecond: number; p50: number; p95: number; p99: number; loop?: Loop }
interface Loop { p50: number; p99: number; max: number; mean: number }
const pct = (sorted: number[], p: number) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]! : NaN;
const round = (n: number, d = 2) => Math.round(n * 10 ** d) / 10 ** d;

async function drive(port: number, phase: string, count: number, concurrency: number, make: (i: number) => Req, check: (res: Res, i: number) => boolean): Promise<PhaseResult> {
  const agent = new Agent({ keepAlive: true, maxSockets: concurrency });
  const latencies: number[] = [], statuses: Record<string, number> = {};
  let next = 0, ok = 0;
  const started = performance.now();
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (next < count) {
      const i = next++, t0 = performance.now();
      const res = await send(agent, port, make(i));
      latencies.push(performance.now() - t0);
      statuses[res.status] = (statuses[res.status] ?? 0) + 1;
      if (check(res, i)) ok++;
    }
  }));
  const seconds = (performance.now() - started) / 1000;
  agent.destroy();
  latencies.sort((a, b) => a - b);
  return { phase, requests: count, ok, statuses, seconds: round(seconds), perSecond: round(ok / seconds, 0), p50: round(pct(latencies, 50)), p95: round(pct(latencies, 95)), p99: round(pct(latencies, 99)) };
}

class Server {
  private child!: ChildProcess;
  port = 0;
  private waiting: { resolve: (message: Record<string, unknown>) => void; reject: (error: Error) => void } | undefined;
  async start(root: string, seed: number): Promise<void> {
    this.child = fork(new URL(import.meta.url), ['--server'], { execArgv: ['--conditions=development', '--disable-warning=ExperimentalWarning'], env: { ...process.env, STORE_BENCH_SERVER: JSON.stringify({ root, seed }) }, stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
    this.child.on('message', message => { const w = this.waiting; this.waiting = undefined; w?.resolve(message as Record<string, unknown>); });
    this.child.on('exit', code => { const w = this.waiting; this.waiting = undefined; w?.reject(new Error(`server exited ${code}`)); });
    const ready = await this.next();
    this.port = ready.port as number;
  }
  private next(): Promise<Record<string, unknown>> { return new Promise((resolve, reject) => { this.waiting = { resolve, reject }; }); }
  async ask(type: string): Promise<Record<string, unknown>> { const reply = this.next(); this.child.send({ type }); return reply; }
  async measured(run: () => Promise<PhaseResult>): Promise<PhaseResult> {
    await this.ask('loop-start');
    const result = await run();
    result.loop = await this.ask('loop-stop') as unknown as Loop;
    return result;
  }
  async close(): Promise<void> { const exited = new Promise(resolve => this.child.once('exit', resolve)); this.waiting = undefined; this.child.send({ type: 'close' }); await exited; }
}

async function writePhases(server: Server, name: string, mount: string): Promise<PhaseResult[]> {
  const port = server.port, ids: string[] = [], etags = new Map<string, string>();
  const results: PhaseResult[] = [];
  results.push(await server.measured(() => drive(port, `${name}: create`, WRITES, CONCURRENCY,
    i => ({ method: 'POST', path: mount, headers: { 'idempotency-key': `c-${i}` }, body: { title: word(i), priority: (i % 5) + 1, kind: 'a' } }),
    res => { if (res.status !== 201) return false; const { id } = JSON.parse(res.body) as { id: string }; ids.push(id); etags.set(id, res.headers.etag as string); return true; })));
  results.push(await server.measured(() => drive(port, `${name}: PATCH If-Match`, ids.length, CONCURRENCY,
    i => ({ method: 'PATCH', path: `${mount}/${ids[i]}`, headers: { 'if-match': etags.get(ids[i]!)!, 'idempotency-key': `u-${i}` }, body: { title: `${word(i)}-u`, priority: ((i + 1) % 5) + 1 } }),
    (res, i) => { if (res.status !== 200) return false; etags.set(ids[i]!, res.headers.etag as string); return true; })));
  results.push(await server.measured(() => drive(port, `${name}: transition`, ids.length, CONCURRENCY,
    i => ({ method: 'POST', path: `${mount}/${ids[i]}/close`, headers: { 'if-match': etags.get(ids[i]!)!, 'idempotency-key': `t-${i}` } }),
    res => res.status === 200)));
  return results;
}

async function listPhases(server: Server, size: number): Promise<PhaseResult[]> {
  const results: PhaseResult[] = [];
  const shapes: [string, string][] = [['unsorted', ''], ['sort=title', '&sort=title'], ['sort=-priority', '&sort=-priority'], ['kind=b&sort=title', '&kind=b&sort=title']];
  for (const limit of [20, 100]) for (const [label, query] of shapes)
    results.push(await server.measured(() => drive(server.port, `list ${size}, ${label}, limit=${limit}`, LIST_REQUESTS, 1,
      () => ({ method: 'GET', path: `/api/items?limit=${limit}${query}` }), res => res.status === 200)));
  // Throughput under concurrency for the most expensive shape.
  results.push(await server.measured(() => drive(server.port, `list ${size}, sort=title, limit=100, c=${CONCURRENCY}`, LIST_REQUESTS * 2, CONCURRENCY,
    () => ({ method: 'GET', path: '/api/items?limit=100&sort=title' }), res => res.status === 200)));
  return results;
}

// ---------------------------------------------------------------------------------------------------------------------
// Commit micro-benchmark: the store's write shape (one BEGIN IMMEDIATE transaction per request) on a WAL database.
interface CommitResult { mode: string; commits: number; perSecond: number; p50us: number; p99us: number; maxus: number }
function commitBench(dir: string, mode: string, pragmas: string): CommitResult {
  const db = new DatabaseSync(join(dir, `${mode.replace(/\W+/g, '-')}.sqlite`));
  db.exec(`PRAGMA journal_mode=WAL; ${pragmas}`);
  db.exec('CREATE TABLE t(seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE, data TEXT)');
  const insert = db.prepare('INSERT INTO t(id, data) VALUES (?, ?)'), times: number[] = [];
  const payload = JSON.stringify({ title: 'x'.repeat(40), priority: 3, kind: 'a', status: 'open' });
  const started = performance.now();
  for (let i = 0; i < COMMITS; i++) {
    const t0 = performance.now();
    db.exec('BEGIN IMMEDIATE'); insert.run(randomUUID(), payload); db.exec('COMMIT');
    times.push((performance.now() - t0) * 1000);
  }
  const seconds = (performance.now() - started) / 1000;
  db.close();
  times.sort((a, b) => a - b);
  return { mode, commits: COMMITS, perSecond: round(COMMITS / seconds, 0), p50us: round(pct(times, 50), 0), p99us: round(pct(times, 99), 0), maxus: round(times[times.length - 1]!, 0) };
}

// ---------------------------------------------------------------------------------------------------------------------
// List micro-benchmark: the store's own sorted/filtered path against SQL ORDER BY, at sizes up to 50k.
interface ListMicro { size: number; shape: string; p50ms: number; p95ms: number }
async function listMicro(dir: string, size: number): Promise<ListMicro[]> {
  const { openStoreDatabase } = await import('../src/database.ts');
  await import('../src/collection.ts'); // collection.ts and query.ts import each other; collection.ts must load first
  const { runList } = await import('../src/query.ts');
  const db = await openStoreDatabase(join(dir, `list-${size}.sqlite`));
  const now = new Date().toISOString();
  db.transaction(() => {
    for (let i = 0; i < size; i++) {
      const { id, ...data } = synthetic(i);
      db.run('INSERT INTO store_records(collection, id, owner, key, created_at, updated_at, data) VALUES (?, ?, ?, NULL, ?, ?, ?)', 'items', id, 'bench', now, now, JSON.stringify({ ...data, status: 'open' }));
    }
  });
  const COLUMNS = 'id, owner, key, created_at, updated_at, data';
  const where = 'collection = ? AND owner = ?', scope = ['items', 'bench'];
  const parsePage = (rows: Record<string, unknown>[]) => rows.map(row => ({ id: row.id, ...JSON.parse(String(row.data)) as object }));
  // The store's path (collection.ts listIn): project id + named fields in creation order, order in JS, fetch the page.
  const jsPath = (limit: number, filter?: string) => () => {
    const names = filter ? ['kind', 'title'] : ['title'];
    const rows = db.all<Record<string, string | null>>(`SELECT id, ${names.map((_, n) => `data -> ? AS v${n}`).join(', ')} FROM store_records WHERE ${where} ORDER BY seq`, ...names.map(f => `$.${f}`), ...scope);
    const projected = rows.map(row => { const r: Record<string, unknown> = { id: row.id }; names.forEach((f, n) => { const v = row[`v${n}`]; if (v != null) r[f] = JSON.parse(v); }); return r; });
    const page = runList(projected as never, { limit, offset: 0, after: undefined, sort: { field: 'title', descending: false }, filters: filter ? [['kind', filter]] : [] });
    const ids = page.items.map(item => item.id as string);
    return parsePage(db.all(`SELECT ${COLUMNS} FROM store_records WHERE collection = ? AND id IN (SELECT value FROM json_each(?))`, 'items', JSON.stringify(ids)));
  };
  const unsorted = (limit: number) => () => { db.get(`SELECT count(*) AS n FROM store_records WHERE ${where}`, ...scope); return parsePage(db.all(`SELECT ${COLUMNS} FROM store_records WHERE ${where} ORDER BY seq LIMIT ? OFFSET 0`, ...scope, limit)); };
  const sqlPath = (limit: number, filter?: string) => () => {
    const f = filter ? ` AND data ->> '$.kind' = ?` : '', v = filter ? [filter] : [];
    db.get(`SELECT count(*) AS n FROM store_records WHERE ${where}${f}`, ...scope, ...v);
    return parsePage(db.all(`SELECT ${COLUMNS} FROM store_records WHERE ${where}${f} ORDER BY data ->> '$.title', id LIMIT ?`, ...scope, ...v, limit));
  };
  const time = (shape: string, fn: () => unknown): ListMicro => {
    for (let i = 0; i < 3; i++) fn();
    const times: number[] = [];
    for (let i = 0; i < LIST_ITERATIONS; i++) { const t0 = performance.now(); fn(); times.push(performance.now() - t0); }
    times.sort((a, b) => a - b);
    return { size, shape, p50ms: round(pct(times, 50)), p95ms: round(pct(times, 95)) };
  };
  const out: ListMicro[] = [];
  for (const limit of [20, 100]) {
    out.push(time(`unsorted, limit=${limit}`, unsorted(limit)));
    out.push(time(`sort=title (store: JS order), limit=${limit}`, jsPath(limit)));
    out.push(time(`kind=b&sort=title (store: JS order), limit=${limit}`, jsPath(limit, 'b')));
    out.push(time(`sort=title (SQL ORDER BY, no index), limit=${limit}`, sqlPath(limit)));
  }
  db.run(`CREATE INDEX bench_title ON store_records(collection, owner, (data ->> '$.title'), id)`);
  for (const limit of [20, 100]) {
    out.push(time(`sort=title (SQL ORDER BY, expression index), limit=${limit}`, sqlPath(limit)));
    out.push(time(`kind=b&sort=title (SQL, expression index), limit=${limit}`, sqlPath(limit, 'b')));
  }
  db.close();
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
function table(rows: Record<string, unknown>[]): void {
  if (!rows.length) return;
  const keys = Object.keys(rows[0]!), cells = rows.map(row => keys.map(key => typeof row[key] === 'object' ? JSON.stringify(row[key]) : String(row[key])));
  console.log(`| ${keys.join(' | ')} |\n|${keys.map(() => '---').join('|')}|`);
  for (const row of cells) console.log(`| ${row.join(' | ')} |`);
  console.log();
}
const flat = (r: PhaseResult) => ({ phase: r.phase, ok: `${r.ok}/${r.requests}`, 'ok/s': r.perSecond, 'p50 ms': r.p50, 'p95 ms': r.p95, 'p99 ms': r.p99, 'loop p50/p99/max ms': r.loop ? `${r.loop.p50}/${r.loop.p99}/${r.loop.max}` : '', statuses: r.statuses });

async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'store-bench-'));
  const report: Record<string, unknown> = {
    machine: { cpu: cpus()[0]?.model, cores: cpus().length, memoryGiB: round(totalmem() / 2 ** 30, 0), platform: `${platform()} ${release()}` },
    node: process.version, sqlite: process.versions.sqlite, concurrency: CONCURRENCY, writes: WRITES, quick,
  };
  console.log(JSON.stringify(report, null, 2), '\n');
  try {
    console.log('## HTTP writes (owned collection, idempotency on)\n');
    const writes: PhaseResult[] = [];
    {
      const server = new Server();
      await server.start(join(root, 'writes'), 0);
      writes.push(...await writePhases(server, 'audit off', '/api/items'));
      writes.push(...await writePhases(server, 'audit on', '/api/audited'));
      await server.close();
    }
    table(writes.map(flat));
    report.writes = writes;

    console.log('## HTTP lists (owned collection, one owner holding every record)\n');
    const lists: PhaseResult[] = [];
    for (const size of [1000, 10_000]) {
      const server = new Server();
      await server.start(join(root, `list-${size}`), size);
      lists.push(...await listPhases(server, size));
      await server.close();
    }
    table(lists.map(flat));
    report.lists = lists;

    console.log('## Commit micro-benchmark (WAL, one row per BEGIN IMMEDIATE transaction)\n');
    const dir = join(root, 'micro');
    await mkdir(dir);
    const commits = [
      commitBench(dir, 'synchronous=FULL (the store)', 'PRAGMA synchronous=FULL;'),
      commitBench(dir, 'synchronous=NORMAL', 'PRAGMA synchronous=NORMAL;'),
      ...(platform() === 'darwin' ? [commitBench(dir, 'synchronous=FULL + fullfsync', 'PRAGMA synchronous=FULL; PRAGMA fullfsync=ON;')] : []),
    ];
    table(commits as unknown as Record<string, unknown>[]);
    report.commits = commits;

    console.log('## List micro-benchmark (in process, no HTTP)\n');
    const micro: ListMicro[] = [];
    for (const size of [1000, 10_000, 50_000]) micro.push(...await listMicro(dir, size));
    table(micro as unknown as Record<string, unknown>[]);
    report.listMicro = micro;
    if (jsonOut) await writeFile(jsonOut, JSON.stringify(report, null, 2));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

if (args.includes('--server')) await serve();
else await main();
