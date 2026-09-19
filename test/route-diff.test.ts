import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { diffRoutes, parseRouteSnapshot, renderRouteDiff, hasRouteChanges } from '../src/route-diff.ts';
import type { RouteSnapshot } from '../src/route-diff.ts';
import { project, redirect } from './helpers.ts';
const cli = fileURLToPath(new URL('../src/cli.ts',import.meta.url));
const run = (...args: string[]) => spawnSync(process.execPath,[cli,...args],{ encoding:'utf8',timeout:20000 });
const entry = (path: string, extra: Partial<RouteSnapshot['inventory'][number]> = {}): RouteSnapshot['inventory'][number] =>
  ({ path, handler:'redirect', methods:['GET','HEAD'], middleware:0, policies:[], state:'active', ...extra });

test('diffRoutes reports added, removed and changed routes and ignores key order', () => {
  const before: RouteSnapshot = { inventory:[entry('/go'), entry('/old'), entry('/same', { policies:['cache'] }), entry('/fn', { handler:'function', middleware:1 })],
    policies:{ '/same':{ cache:{ strategy:'public', target:'native' } } } };
  const after: RouteSnapshot = { inventory:[entry('/fn', { handler:'function', middleware:2, methods:['HEAD','GET'] }), entry('/same', { policies:['cache'] }), entry('/go', { state:'disabled' }), entry('/new', { generated:'site.llms' })],
    policies:{ '/same':{ cache:{ target:'native', strategy:'public' } } } };
  const diff = diffRoutes(before,after);
  assert.deepEqual(diff.added.map(r => r.path),['/new']);
  assert.deepEqual(diff.removed.map(r => r.path),['/old']);
  assert.deepEqual(diff.changed.map(c => c.path),['/fn','/go']);
  assert.equal(diff.changed[0]?.before.middleware,1); assert.equal(diff.changed[0]?.after.middleware,2);
  assert.deepEqual(diff.changed[1]?.after.state,'disabled');
  assert.ok(hasRouteChanges(diff));
  // Policy descriptions travel with the route and a changed description is a change.
  assert.deepEqual(diffRoutes(before,{ ...after, policies:{ '/same':{ cache:{ strategy:'private', target:'native' } } } }).changed.map(c => c.path),['/fn','/go','/same']);
  assert.deepEqual(diffRoutes(before,before),{ added:[], removed:[], changed:[] });
});
test('renderRouteDiff emits one table per nonempty section and escapes cells', () => {
  const diff = diffRoutes({ inventory:[entry('/a|b'), entry('/gone')] },{ inventory:[entry('/a|b', { methods:['POST'] }), entry('/fresh', { policies:['agents','cache'] })] });
  const markdown = renderRouteDiff(diff);
  assert.match(markdown,/^### Added routes \(1\)\n\n\| Route \| Handler \| Methods \| State \| Middleware \| Policies \| Generated \|\n\|---\|/);
  assert.ok(markdown.includes('| `/fresh` | redirect | GET, HEAD | active | 0 | agents, cache | - |'));
  assert.ok(markdown.includes('### Removed routes (1)'));
  assert.ok(markdown.includes('### Changed routes (1)\n\n| Route | Field | Before | After |\n|---|---|---|---|\n| `/a\\|b` | methods | GET, HEAD | POST |'));
  assert.equal(renderRouteDiff(diffRoutes({ inventory:[entry('/x')] },{ inventory:[entry('/x')] })),'No route changes\n');
  assert.ok(!renderRouteDiff(diffRoutes({ inventory:[] },{ inventory:[entry('/x')] })).includes('Removed'));
});
test('parseRouteSnapshot rejects malformed reports', () => {
  for (const bad of [null, {}, { inventory:[{}] }, { inventory:[{ path:'/a', methods:'GET', middleware:0, policies:[], state:'active' }] },
    { inventory:[{ path:'/a', methods:[], middleware:0, policies:[], state:'unknown' }] }, { inventory:[], policies:[] }, { inventory:[], policies:{ '/a':1 } }]) {
    assert.throws(() => parseRouteSnapshot(bad),/Route report/);
  }
  assert.throws(() => diffRoutes(parseRouteSnapshot({ inventory:[entry('/a'),entry('/a')] }),{ inventory:[] }),/twice/);
  assert.deepEqual(parseRouteSnapshot({ inventory:[entry('/a')], policies:{ '/a':{ cache:{} } } }),{ inventory:[entry('/a')], policies:{ '/a':{ cache:{} } } });
});
test('routes --compare prints a diff against an earlier report and exits 0 either way', async t => {
  const root = await project(t,{ '/go':redirect(), '/old':redirect() });
  const first = run('routes','--project',root);
  assert.equal(first.status,0);
  const previous = join(root,'..',`routes-${Date.now()}.json`);
  await writeFile(previous,first.stdout);
  t.after(async () => { const { rm } = await import('node:fs/promises'); await rm(previous,{ force:true }); });
  const same = run('routes','--project',root,'--compare',previous);
  assert.equal(same.status,0);
  assert.deepEqual(JSON.parse(same.stdout),{ added:[], removed:[], changed:[] });
  assert.equal(run('routes','--project',root,'--compare',previous,'--format','markdown').stdout,'No route changes\n');
  await writeFile(join(root,'urlcode.yaml'),'version: "1"\nroutes:\n  /go:\n    enabled: false\n    redirect:\n      url: https://example.com/\n  /new:\n    redirect:\n      url: https://example.org/\n');
  const changed = run('routes','--project',root,'--compare',previous,'--format','markdown');
  assert.equal(changed.status,0);
  assert.ok(changed.stdout.includes('### Added routes (1)') && changed.stdout.includes('| `/new` |'));
  assert.ok(changed.stdout.includes('### Removed routes (1)') && changed.stdout.includes('| `/old` |'));
  assert.ok(changed.stdout.includes('| `/go` | state | active | disabled |'));
  const json: unknown = JSON.parse(run('routes','--project',root,'--compare',previous).stdout);
  assert.ok(typeof json === 'object' && json !== null && 'changed' in json && Array.isArray(json.changed) && json.changed.length === 1);
  for (const args of [['--compare',previous,'--format','html'],['--format','markdown'],['--compare',join(root,'urlcode.yaml')],['--compare',join(root,'missing.json')]]) {
    const result = run('routes','--project',root,...args);
    assert.equal(result.status,1,args.join(' ')); assert.equal(JSON.parse(result.stderr).event,'error');
  }
});

test('markdown cells escape backslashes before pipes and backticks', () => {
  const snapshot = (paths: string[]) => parseRouteSnapshot({ routes: paths.length,
    inventory: paths.map(path => ({ path, handler: 'respond', methods: ['GET'], middleware: 0, policies: [], state: 'active' })), policies: {} });
  const rendered = renderRouteDiff(diffRoutes(snapshot([]), snapshot(['/a\\b|c`d'])));
  assert.match(rendered, /`\/a\\\\b\\\|c\\`d`/);
  assert.doesNotMatch(rendered, /[^\\]\|c/);
});
