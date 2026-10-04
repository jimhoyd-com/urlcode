import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Trusted first-party code. Channels are files under the data directory, so they
// survive a restart; pending reads and started processes live in memory and do not.
const LIMITS = { events: 3, bytes: 64 };
const json = (status, body) => Response.json(body, { status });
const digest = token => createHash('sha256').update(token).digest('hex');
const name = () => randomBytes(4).toString('hex');
const known = value => /^[0-9a-f]{8}$/.test(value);
const file = (env, id) => join(env.DATA_DIR, `channel-${id}.json`);
const objectFile = (env, id) => join(env.DATA_DIR, `object-${id}`);
// tests/ turns one of these on in a copy of the project to show that a check fails when the code is wrong.
const defect = (env, which) => env.DEFECTS.split(',').includes(which);

function load(env, id) {
  if (!known(id)) return undefined;
  try { return JSON.parse(readFileSync(file(env, id), 'utf8')); } catch { return undefined; }
}
// Reading, changing and saving a channel happen with no await in between, so two requests cannot interleave.
function save(env, channel) {
  writeFileSync(`${file(env, channel.id)}.tmp`, JSON.stringify(channel));
  renameSync(`${file(env, channel.id)}.tmp`, file(env, channel.id));
}

// A credential is live only while it and every credential it was derived from are unrevoked.
function live(env, channel, tokenId) {
  for (let at = tokenId; at; at = channel.tokens[at].parent) {
    if (channel.tokens[at].revoked) return false;
    if (defect(env, 'derived-survives')) break; // defect: only the credential itself is checked
  }
  return true;
}
/** The channel and the caller's credential id, or the refusal to return. */
function enter(request, env, id, { deleted = false } = {}) {
  const channel = load(env, id);
  if (!channel) return { refusal: json(404, { error: 'not found' }) };
  const token = /^Bearer (.+)$/.exec(request.headers.get('authorization') ?? '')?.[1];
  const who = token && Object.keys(channel.tokens).find(key => channel.tokens[key].hash === digest(token));
  if (!who || !live(env, channel, who)) return { refusal: json(401, { error: 'unauthorized' }) };
  if (channel.deleted && !deleted) return { refusal: json(410, { error: 'deleted', cleanup: channel.cleanup }) };
  return { channel, who };
}

const full = (channel, text) => channel.events.length >= LIMITS.events ? 'event-capacity'
  : channel.events.reduce((sum, event) => sum + Buffer.byteLength(event.text), Buffer.byteLength(text)) > LIMITS.bytes ? 'byte-capacity' : undefined;

// Pending reads by channel id. Anything that changes what a reader may see wakes them.
const waiting = new Map();
const wake = id => { for (const resume of [...waiting.get(id) ?? []]) resume(); };

export async function create(request, { env }) {
  const id = name(), owner = randomBytes(16).toString('hex');
  writeFileSync(objectFile(env, id), 'stored bytes');
  save(env, { id, tokens: { owner: { hash: digest(owner), parent: null, revoked: false } }, events: [], keys: {} });
  return json(201, { id, owner });
}

export async function issue(request, { args, env }) {
  const { channel, who, refusal } = enter(request, env, args.id);
  if (refusal) return refusal;
  const tokenId = name(), token = randomBytes(16).toString('hex');
  channel.tokens[tokenId] = { hash: digest(token), parent: who, revoked: false };
  save(env, channel);
  return json(201, { tokenId, token });
}

export async function revoke(request, { args, env }) {
  const { channel, who, refusal } = enter(request, env, args.id);
  if (refusal) return refusal;
  const target = known(args.tokenId) ? channel.tokens[args.tokenId] : undefined;
  let issuer = target?.parent;
  while (issuer && issuer !== who) issuer = channel.tokens[issuer].parent;
  if (!issuer) return json(404, { error: 'not found' }); // only a credential it descends from may revoke it
  target.revoked = true;
  if (defect(env, 'capacity-rollback')) {
    // defect: the revocation is also written to the bounded event log, so a full log refuses it and nothing is saved
    const refused = full(channel, 'revoked');
    if (refused) return json(507, { error: refused });
    channel.events.push({ seq: channel.events.length + 1, text: 'revoked' });
  }
  save(env, channel);
  if (!defect(env, 'late-wait')) wake(channel.id);
  return json(200, { revoked: true });
}

export async function events(request, { args, env }) {
  // The body is read before the channel is, so nothing is awaited between reading the channel and saving it.
  const body = request.method === 'POST' ? await request.json().catch(() => undefined) : undefined;
  let entry = enter(request, env, args.id);
  if (entry.refusal) return entry.refusal;
  if (request.method === 'POST') {
    if (typeof body?.text !== 'string' || !body.text) return json(400, { error: 'text is required' });
    // defect: the channel read above is saved after a pause, so concurrent publishes overwrite each other
    if (defect(env, 'lost-update')) await new Promise(resolve => setTimeout(resolve, 50));
    const { channel } = entry, key = request.headers.get('idempotency-key');
    if (key && Object.hasOwn(channel.keys, key)) return json(201, { seq: channel.keys[key] }); // a replay publishes nothing
    const refused = full(channel, body.text);
    if (refused) return json(507, { error: refused });
    const seq = channel.events.length + 1;
    channel.events.push({ seq, text: body.text });
    if (key) channel.keys[key] = seq;
    save(env, channel);
    wake(channel.id);
    return json(201, { seq });
  }
  if (args.wait > 0 && !entry.channel.events.some(event => event.seq > args.after)) {
    await new Promise(resolve => {
      const pending = waiting.get(args.id) ?? new Set();
      const resume = () => { clearTimeout(timer); pending.delete(resume); resolve(); };
      const timer = setTimeout(resume, args.wait);
      waiting.set(args.id, pending.add(resume));
    });
    // The credential is checked again after the wait: it may have been revoked while this request was pending.
    const now = enter(request, env, args.id);
    if (now.refusal && !defect(env, 'late-wait')) return now.refusal;
    entry = { ...entry, channel: load(env, args.id) ?? entry.channel };
  }
  const found = entry.channel.events.filter(event => event.seq > args.after);
  return json(200, { events: found, next: found.at(-1)?.seq ?? args.after });
}

export async function remove(request, { args, env }) {
  const { channel, who, refusal } = enter(request, env, args.id, { deleted: true });
  if (refusal) return refusal;
  if (who !== 'owner') return json(403, { error: 'forbidden' });
  if (channel.cleanup === 'done') return json(200, { cleanup: 'done' });
  save(env, { ...channel, deleted: true, cleanup: 'pending' });
  wake(channel.id);
  // The stored object is removed after the answer. A failure is recorded, never reported as done, so the
  // owner can see it and repeat the DELETE.
  setTimeout(() => {
    let cleanup = 'done';
    try { unlinkSync(objectFile(env, channel.id)); }
    catch (error) { if (error.code !== 'ENOENT' && !defect(env, 'cleanup-silent')) cleanup = 'failed'; }
    try { save(env, { ...load(env, channel.id), cleanup }); } catch { /* the data directory is gone: the run ended */ }
  }, 20).unref();
  return json(202, { cleanup: 'pending' });
}

// Processes started for a job, by job id. The job process starts a tool process and prints its pid;
// both end by themselves after 20 seconds, so a failed test leaves nothing running for long.
const jobs = new Map();
const idle = 'setTimeout(() => {}, 20000)';
const jobSource = `const tool = require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(idle)}], { stdio: 'ignore' }); console.log(tool.pid); ${idle}`;

export async function start(request, { args, env }) {
  const { channel, refusal } = enter(request, env, args.id);
  if (refusal) return refusal;
  const child = spawn(process.execPath, ['-e', jobSource], { stdio: ['ignore', 'pipe', 'ignore'] });
  const [line] = await once(child.stdout, 'data');
  child.stdout.destroy();
  child.unref();
  const job = name(), pids = [child.pid, Number(line)];
  jobs.set(job, { channel: channel.id, pids });
  return json(201, { job, pids });
}

export async function cancel(request, { args, env }) {
  const { channel, refusal } = enter(request, env, args.id);
  if (refusal) return refusal;
  const job = jobs.get(args.job);
  if (job?.channel !== channel.id) return json(404, { error: 'not found' });
  // Every process the job started is ended, not only the one this handler spawned.
  // defect: only the job process is ended, and the tool it started keeps running
  for (const pid of defect(env, 'orphan-process') ? job.pids.slice(0, 1) : job.pids) {
    try { process.kill(pid); } catch { /* already gone */ }
  }
  jobs.delete(args.job);
  return json(200, { state: 'cancelled' });
}
