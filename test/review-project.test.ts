import test from 'node:test';
import assert from 'node:assert/strict';
import { reviewProject } from '../src/review-project.ts';
import { project } from './helpers.ts';

test('review_project flags hand-written request.body validation and stays silent on schema-only routes', async t => {
  const validator = `
export default function handler(request) {
  const body = request.body;
  if (typeof body !== 'object') throw new Error('bad');
  if (!body.name) throw new Error('missing name');
  if (Array.isArray(body.tags) === false) throw new Error('tags');
  return new Response('ok');
}
`;
  const schema = { type:'object', required:['name'], properties:{ name:{ type:'string' } } };
  const root = await project(t, {
    '/manual': { sandbox:true, methods:['POST'], function:{ source:'validator.mjs' } },
    '/declarative': { methods:['POST'], request:{ body:{ format:'json', schema } }, respond:{ status:201, json:{ ok:true } } },
  }, { 'validator.mjs':validator });
  const report = await reviewProject(root);
  assert.equal(report.format, 1);
  assert.ok(report.findings.length >= 1);
  assert.ok(report.findings.every(finding => finding.file === '/validator.mjs' && finding.pattern === 'manual-body-validation'));
  assert.ok(report.findings.every(finding => finding.suggestion === 'Use request.body.schema instead of hand-written validation'));
  // Every finding names a real line inside the module, and no finding names a
  // schema-only route (which never enters function source at all).
  const lines = validator.split('\n');
  for (const finding of report.findings) { assert.ok(finding.line !== undefined && finding.line >= 1 && finding.line <= lines.length); }
});

test('review_project ignores validation of things unrelated to request.body', async t => {
  const source = `
export default function handler(request) {
  const query = request.query;
  if (typeof query !== 'object') throw new Error('bad');
  if (!query.foo) throw new Error('missing');
  if (Array.isArray(query.tags) === false) throw new Error('tags');
  return new Response('ok');
}
`;
  const root = await project(t, { '/f': { sandbox:true, methods:['POST'], function:{ source:'f.mjs' } } }, { 'f.mjs':source });
  const report = await reviewProject(root);
  assert.deepEqual(report.findings, []);
});

test('review_project produces no findings for a project with no function/middleware source', async t => {
  const root = await project(t, { '/a': { redirect:{ url:'https://example.com' } } });
  const report = await reviewProject(root);
  assert.deepEqual(report, { format:1, findings:[] });
});
