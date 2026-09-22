import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTarget, matchRoute, contextFor, redirectLocation } from '../packages/core/src/match.ts';
import type { CompiledRoutes, MatchableRoute, CompiledParameter } from '../packages/core/src/match.ts';
import { HttpError } from '../packages/core/src/errors.ts';

const param = (name: string, location: CompiledParameter['in'], type: CompiledParameter['schema']['type'] = 'string', required = true): CompiledParameter =>
  ({ name, in: location, required, schema: { type, ...(type === 'array' ? { items: { type: 'integer' } } : {}) }, validate: () => true });
const route = (pattern: string, extra: Partial<MatchableRoute> = {}): MatchableRoute =>
  ({ pattern, parts: pattern.split('/').slice(1), parameters: [], env: {}, secrets: {}, ...extra });

test('request targets are parsed and matched by exact path, length and mount', () => {
  const byId = route('/u/{id}', { parameters: [param('id', 'path')] });
  const compiled: CompiledRoutes = {
    exact: new Map([['/go', route('/go', { redirect: { url: 'https://example.com/' } })]]),
    byLength: new Map([[2, [byId]]]),
    mounts: [route('/static', { prefix: '/static/' })],
  };
  assert.equal(matchRoute(compiled, parseTarget('/go'))?.route.pattern, '/go');
  assert.deepEqual(matchRoute(compiled, parseTarget('/u/42'))?.path, Object.assign(Object.create(null), { id: '42' }));
  assert.equal(matchRoute(compiled, parseTarget('/u/')), null);
  assert.equal(matchRoute(compiled, parseTarget('/static/a.css'))?.route.pattern, '/static');
  assert.throws(() => parseTarget('//evil'), (e: unknown) => e instanceof HttpError && e.status === 400);
  assert.throws(() => parseTarget('/' + 'x'.repeat(9000)), (e: unknown) => e instanceof HttpError && e.status === 414);
});

test('parameters are coerced, defaults applied and redirects assembled', () => {
  const r = route('/q', { parameters: [param('n', 'query', 'integer'), param('tags', 'query', 'array', false), { ...param('lang', 'header', 'string', false), schema: { type: 'string', default: 'en' } }],
    redirect: { url: 'https://example.com/{missing}', query: { map: { n: { from: 'query', name: 'n' }, fixed: 1 }, pass: ['tags', 'other'] } } });
  const target = parseTarget('/q?n=7&tags=1&tags=2&other=z');
  const context = contextFor(r, {}, target.query, new Headers());
  assert.equal(context.inputs.query['n'], 7);
  assert.deepEqual(context.inputs.query['tags'], [1, 2]);
  assert.equal(context.inputs.header['lang'], 'en');
  assert.equal(redirectLocation(r as MatchableRoute & { redirect: NonNullable<MatchableRoute['redirect']> }, context, target.query),
    'https://example.com/?n=7&fixed=1&tags=1&tags=2&other=z');
  assert.throws(() => contextFor(r, {}, parseTarget('/q?n=x').query, new Headers()), /Invalid parameter/);
  assert.throws(() => contextFor(r, {}, parseTarget('/q').query, new Headers()), /Missing required/);
});
