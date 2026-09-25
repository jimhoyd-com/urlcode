// Consistency guard for #540: the agent-facing surfaces (both skill copies, llms.txt, the AI authoring contract and
// the extensions overview) once told agents that stored short links were an unsupported gap while the store served
// them declaratively. The facts below are derived from the store itself -- its config schema, its authoring contract,
// its activation refusals and its redirect handler -- and the prose is only allowed to claim what they accept.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExtensionActivation, ExtensionInstance, ExtensionRequest } from '@jimhoyd/urlcode/extensions';
import { storeAuthoring } from '../src/authoring.ts';
import { collectionSchema } from '../src/collection.ts';
import { createStore, storeConfigSchema } from '../src/store.ts';

const repo = new URL('../../../', import.meta.url);
/** `describes` surfaces explain the capability; `points` surfaces only route the reader to it. */
const SURFACES: Record<string, 'describes' | 'points'> = {
  '.claude/skills/urlcode-authoring/SKILL.md': 'describes',
  'packaging/claude-plugin/skills/urlcode-authoring/SKILL.md': 'describes',
  '.claude/skills/urlcode-operations/SKILL.md': 'points',
  'packaging/claude-plugin/skills/urlcode-operations/SKILL.md': 'points',
  'llms.txt': 'describes',
  'docs/AI-AUTHORING.md': 'describes',
  'docs/EXTENSIONS.md': 'describes',
};
const SHORT = /short[- ]links?|shortLinks/i;
const CONFIG_PATH = '`extensions.store.config.shortLinks`';

// ---- The contract, derived from code ----------------------------------------------------------------------------

const entrySchema = storeConfigSchema.properties.shortLinks.additionalProperties;
const ENTRY_FIELDS = Object.keys(entrySchema.properties).sort();
const fieldSchema = collectionSchema.properties.fields.additionalProperties;
/** Every key a short-link passage may write inline: the entry, the collection it names, and that collection's fields. */
const KEYS = new Set([...ENTRY_FIELDS, ...Object.keys(collectionSchema.properties), ...Object.keys(fieldSchema.properties)]);

type Config = { collections: Record<string, { mount: string; key?: string; increments?: string[]; fields: Record<string, Record<string, unknown>> }>; shortLinks: Record<string, Record<string, string>> };
const minimal = (): Config => ({
  collections: { links: { mount: '/api/links', key: 'code', increments: ['clicks'], fields: {
    code: { type: 'string', required: true, maxLength: 32 },
    destination: { type: 'string', required: true, format: 'http-url' },
    clicks: { type: 'integer', default: 0, minimum: 0 },
  } } },
  shortLinks: { public: { mount: '/go', collection: 'links', destination: 'destination', clicks: 'clicks' } },
});
const MOUNTS = ['/api/links', '/go'];

/**
 * Each piece the store refuses to activate without, and the prose that must name it. A piece is listed here only if
 * breaking it in the minimal config is actually refused by `activate`, which the first test proves.
 */
const PIECES: { piece: string; prose: RegExp; breaks: (config: Config) => string[] | void; refusal: RegExp }[] = [
  { piece: 'a unique collection key', prose: /\bkey\b/i, breaks: c => { delete c.collections.links!.key; }, refusal: /needs a declared key/ },
  { piece: 'a required destination field', prose: /destination/i, breaks: c => { delete c.collections.links!.fields.destination!.required; }, refusal: /required string field with format http-url/ },
  { piece: 'an HTTP(S) (format: http-url) destination', prose: /HTTP\(S\)|http-url/i, breaks: c => { delete c.collections.links!.fields.destination!.format; }, refusal: /required string field with format http-url/ },
  { piece: 'a declared increments counter', prose: /\bincrements\b|\bcounter\b/i, breaks: c => { c.collections.links!.increments = []; }, refusal: /declared increment field/ },
  { piece: 'a store route on the redirect mount', prose: /\bmount\b/i, breaks: () => ['/api/links'], refusal: /route \/go\/\* with extension: store is not declared/ },
];

async function activate(t: { after(fn: () => Promise<void>): void }, config: Config, mounts = MOUNTS): Promise<{ instance: ExtensionInstance; store: ReturnType<typeof createStore> }> {
  const root = await mkdtemp(join(tmpdir(), 'store-short-link-claims-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = createStore({ directory: join(root, 'data'), projectSha256: 'a'.repeat(64) });
  const context = { origin: 'https://links.example.test', target: 'node', projectSha256: 'a'.repeat(64), mounts, root: join(root, 'app'), principalMounts: [] } as unknown as ExtensionActivation;
  const instance = await store.registration.activate(config, context);
  t.after(async () => { await instance.close?.(); await store.close(); });
  return { instance, store };
}
function request(method: string, path: string, mount: string): ExtensionRequest {
  return { method, target: path, path, query: new URLSearchParams(), headers: new Headers(), headerCounts: {}, body: new Uint8Array(), origin: 'https://links.example.test', route: `${mount}/*`, mount, client: null, requestId: 'claims', principal: null } as unknown as ExtensionRequest;
}

// ---- The prose ----------------------------------------------------------------------------------------------------

/** Paragraphs, list items and table rows of a Markdown/text file. */
function units(text: string): string[] {
  const out: string[] = [];
  let current: string[] = [];
  const flush = () => { if (current.length) out.push(current.join(' ')); current = []; };
  for (const line of text.split('\n')) {
    if (!line.trim() || /^\s*#/.test(line)) { flush(); continue; }
    if (/^\s*\|/.test(line)) { flush(); out.push(line); continue; }
    if (/^\s*(?:[-*]|\d+\.)\s/.test(line)) flush();
    current.push(line.trim());
  }
  flush();
  return out;
}
const sentences = (unit: string): string[] => unit.split(/(?<=[.;])\s+/);
const surfaces = await Promise.all(Object.entries(SURFACES).map(async ([path, role]) => {
  const passages = units(await readFile(new URL(path, repo), 'utf8')).filter(unit => SHORT.test(unit));
  return { path, role, passages, claims: passages.flatMap(sentences).filter(sentence => SHORT.test(sentence)) };
}));

// ---- Tests --------------------------------------------------------------------------------------------------------

test('the store contract: schema, authoring surfaces and activation agree on what a short link needs', async t => {
  assert.deepEqual([...entrySchema.required].sort(), ENTRY_FIELDS, 'every shortLinks entry field is required');
  assert.deepEqual(ENTRY_FIELDS, ['clicks', 'collection', 'destination', 'mount']);
  assert.equal(entrySchema.additionalProperties, false, 'a shortLinks entry closes its key set');
  assert.ok(storeAuthoring.surfaces.some(surface => surface.kind === 'configuration' && surface.name === 'shortLinks'), 'the authoring contract advertises shortLinks');
  assert.ok(fieldSchema.properties.format.enum.includes('http-url'));
  await activate(t, minimal()); // the minimal config the pieces below break is itself accepted
  for (const { piece, breaks, refusal } of PIECES) {
    const config = minimal();
    const mounts = breaks(config) ?? MOUNTS;
    await assert.rejects(activate(t, config, mounts), refusal, `activation refuses a short link without ${piece}`);
  }
});

test('the redirect mount serves only the methods and statuses the authoring contract names', async t => {
  const { instance, store } = await activate(t, minimal());
  await store.exports.records('links').create(null, { code: 'abc', destination: 'https://example.test/landing' });
  const refused = await instance.handle(request('POST', '/go/abc', '/go'));
  assert.equal(refused.status, 405);
  const allow = new Map(refused.headers ?? []).get('allow') ?? '';
  const methods = allow.split(/,\s*/).filter(Boolean);
  assert.ok(methods.length > 0, 'a refused method names the accepted ones');
  const mountSurface = storeAuthoring.surfaces.find(surface => surface.name === 'mount')!;
  assert.match(mountSurface.description, new RegExp(`short-link routes use ${methods.join(', ')}\\.`), 'the authoring contract names the served methods');
  const statuses = new Set([405]);
  for (const method of methods) {
    const hit = await instance.handle(request(method, '/go/abc', '/go'));
    assert.equal(hit.status, 302);
    assert.equal(new Map(hit.headers ?? []).get('location'), 'https://example.test/landing');
    const miss = await instance.handle(request(method, '/go/nope', '/go'));
    assert.equal(miss.status, 404);
    statuses.add(hit.status).add(miss.status);
  }
  // Every other HTTP method is refused, so prose may name only `methods` for the redirect mount.
  for (const other of ['PUT', 'PATCH', 'DELETE']) assert.equal((await instance.handle(request(other, '/go/abc', '/go'))).status, 405);

  for (const { path, claims } of surfaces) {
    for (const claim of claims) {
      for (const [named] of claim.matchAll(/\b(?:GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS)\b/g)) {
        assert.ok(methods.includes(named), `${path}: short-link claim names ${named}, but the redirect mount serves ${allow}: "${claim}"`);
      }
      for (const [, code] of claim.matchAll(/`([1-5]\d\d)`/g)) {
        assert.ok(statuses.has(Number(code)), `${path}: short-link claim names status ${code}, which the redirect mount never answers: "${claim}"`);
      }
    }
  }
});

test('agent-facing surfaces point at extensions.store.config.shortLinks and never report it as a gap', () => {
  for (const { path, passages, claims } of surfaces) {
    assert.ok(passages.length > 0, `${path} says nothing about stored short links`);
    assert.ok(passages.some(passage => passage.includes(CONFIG_PATH)), `${path} must name ${CONFIG_PATH}`);
    for (const claim of claims) {
      if (/\b(?:unsupported|not supported|not implemented|gaps?|no (?:supported )?(?:extension|package))\b/i.test(claim)) {
        assert.match(claim, /\bbeyond\b/i, `${path}: a gap claim about short links must be limited to needs beyond shortLinks: "${claim}"`);
      }
    }
  }
  // The capability matrix: implemented on the left, gaps on the right. #540 put short links in the right column.
  const matrix = surfaces.find(surface => surface.path === 'docs/AI-AUTHORING.md')!;
  const rows = matrix.passages.filter(passage => passage.trim().startsWith('|')).map(row => row.split('|').slice(1, -1));
  assert.ok(rows.length > 0, 'docs/AI-AUTHORING.md capability matrix mentions short links');
  for (const [implemented = '', gap = ''] of rows) {
    assert.ok(implemented.includes(CONFIG_PATH), `the implemented column names ${CONFIG_PATH}: "${implemented}"`);
    if (SHORT.test(gap)) assert.match(gap, /\bbeyond\b/i, `the gap column only lists needs beyond shortLinks: "${gap}"`);
  }
});

test('agent-facing surfaces write only keys the store accepts and name every piece it requires', () => {
  for (const { path, role, passages, claims } of surfaces) {
    for (const claim of claims) {
      for (const [, key] of claim.matchAll(/`([A-Za-z_][\w-]*):(?:\s[^`]*)?`/g)) {
        assert.ok(KEYS.has(key!), `${path}: short-link claim writes \`${key}:\`, which neither a shortLinks entry, a collection nor a field accepts: "${claim}"`);
      }
      for (const [, key] of claim.matchAll(/shortLinks\.<?[\w-]+>?\.(\w+)/g)) {
        assert.ok(ENTRY_FIELDS.includes(key!), `${path}: shortLinks entries accept only ${ENTRY_FIELDS.join(', ')}, not ${key}`);
      }
    }
    const text = passages.join('\n');
    if (role === 'points') { assert.match(text, /docs\/STORE\.md|STORE\.md/, `${path} points the reader at the store documentation`); continue; }
    for (const { piece, prose } of PIECES) assert.match(text, prose, `${path} must mention ${piece} when it describes stored short links`);
  }
});
