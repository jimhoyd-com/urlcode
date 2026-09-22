import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { diffRoutes, parseRouteSnapshot, renderRouteDiff, hasRouteChanges } from '../packages/core/src/route-diff.ts';
import type { RouteSnapshot } from '../packages/core/src/route-diff.ts';
import { project, redirect } from './helpers.ts';
const cli = fileURLToPath(new URL('../packages/core/src/cli.ts',import.meta.url));
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
  assert.match(markdown,/^### Added routes \(1\)\n\n\| Route \| Handler \| Methods \| State \| Sandbox \| Sandbox reason \| Middleware \| Policies \| Generated \|\n\|---\|/);
  assert.ok(markdown.includes('| `/fresh` | redirect | GET, HEAD | active | - | - | 0 | agents, cache | - |'));
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

// #199: the execution mode is a route-level fact, so flipping `sandbox` has to
// be a route change even when the handler is native and only middleware runs
// project code — the digest alone never told a reviewer what moved.
test('routes --compare reports a trust flip on a native handler with middleware and on a function route', async t => {
  const middleware = 'export default (request, context, next) => next();\n';
  const handlerSource = 'export const handle = () => new Response("ok");\n';
  const cases = [
    { name:'native handler plus middleware', route:{ middleware:[{ source:'mw.mjs' }], respond:{ text:'ok' } }, handler:'respond' },
    { name:'function route', route:{ function:{ source:'fn.mjs', export:'handle' } }, handler:'function' },
  ];
  for (const { name, route, handler } of cases) {
    const root = await project(t,{ '/r':{ sandbox:true, sandboxReason:'Untrusted payload; isolate it.', ...route } },
      { 'mw.mjs':middleware, 'fn.mjs':handlerSource });
    const first = run('routes','--project',root);
    assert.equal(first.status,0,name);
    const before = parseRouteSnapshot(JSON.parse(first.stdout));
    assert.equal(before.inventory[0]?.handler,handler,name);
    assert.equal(before.inventory[0]?.sandbox,true,name);
    assert.equal(before.inventory[0]?.sandboxReason,'Untrusted payload; isolate it.',name);
    const previous = join(root,'before.json');
    await writeFile(previous,first.stdout);
    const config = join(root,'urlcode.yaml');
    await writeFile(config,(await readFile(config,'utf8')).replace('sandbox: true','sandbox: false'));
    const diff = run('routes','--project',root,'--compare',previous);
    assert.equal(diff.status,0,name);
    const parsed = JSON.parse(diff.stdout) as { changed:{ path:string; before:{ sandbox:boolean }; after:{ sandbox:boolean } }[] };
    assert.equal(parsed.changed.length,1,name);
    assert.equal(parsed.changed[0]?.path,'/r',name);
    assert.equal(parsed.changed[0]?.before.sandbox,true,name);
    assert.equal(parsed.changed[0]?.after.sandbox,false,name);
    const markdown = run('routes','--project',root,'--compare',previous,'--format','markdown').stdout;
    assert.ok(markdown.includes('| `/r` | sandbox | true | false |'),`${name}: ${markdown}`);
  }
});
test('a routes report written before the sandbox fields existed still parses, without inventing a mode', () => {
  const legacy = { inventory:[{ path:'/a', handler:'respond', methods:['GET'], middleware:1, policies:[], state:'active' }] };
  const parsed = parseRouteSnapshot(legacy);
  assert.equal(Object.hasOwn(parsed.inventory[0]!,'sandbox'),false);
  assert.deepEqual(diffRoutes(parsed,parsed),{ added:[], removed:[], changed:[] });
  for (const bad of [{ inventory:[{ ...legacy.inventory[0], sandbox:'true' }] },{ inventory:[{ ...legacy.inventory[0], sandboxReason:7 }] }]) {
    assert.throws(() => parseRouteSnapshot(bad),/Route report/);
  }
});

test('markdown cells escape backslashes before pipes and backticks', () => {
  const snapshot = (paths: string[]) => parseRouteSnapshot({ routes: paths.length,
    inventory: paths.map(path => ({ path, handler: 'respond', methods: ['GET'], middleware: 0, policies: [], state: 'active' })), policies: {} });
  const rendered = renderRouteDiff(diffRoutes(snapshot([]), snapshot(['/a\\b|c`d'])));
  assert.match(rendered, /`\/a\\\\b\\\|c\\`d`/);
  assert.doesNotMatch(rendered, /[^\\]\|c/);
});
