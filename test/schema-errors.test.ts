import test from 'node:test';
import assert from 'node:assert/strict';
import { validateDocument } from '../src/config.ts';

const schemaMessage = (doc: unknown): string => {
  try { validateDocument(doc); } catch (e) { return (e as Error).message; }
  return '';
};

test('closed-key-set errors name the offending key and list the allowed keys', () => {
  const robots = schemaMessage({ version: '1', routes: {}, site: { robots: { userAgent: '*' } } });
  assert.match(robots, /^Invalid configuration at \/site\/robots \(additionalProperties\): unknown key "userAgent"; allowed keys: /);
  for (const key of ['disallow', 'allow', 'sitemap']) assert.match(robots, new RegExp(`allowed keys: .*\\b${key}\\b`));
  assert.match(schemaMessage({ version: '1', routes: {}, site: { securityTxt: { contact: 'mailto:a@example.com', expires: '2099-01-01T00:00:00Z', bogus: 1 } } }), /\/site\/securityTxt \(additionalProperties\): unknown key "bogus"; allowed keys: /);
  assert.match(schemaMessage({ version: '1', routes: {}, site: { nope: {} } }), /\/site \(additionalProperties\): unknown key "nope"; allowed keys: .*robots/);
  assert.match(schemaMessage({ version: '1', routes: {}, nope: 1 }), /at \/ \(additionalProperties\): unknown key "nope"/);
  assert.match(schemaMessage({ routes: {} }), /\(required\): missing required key "version"/);
});

test('schema errors never echo values and bound the echoed key length', () => {
  const secret = 'sk_live_supersecretvalue';
  const valueError = schemaMessage({ version: '1', routes: {}, site: { robots: { sitemap: secret } } });
  assert.match(valueError, /Invalid configuration at \/site\/robots\/sitemap \(type\)/);
  assert.ok(!valueError.includes(secret));
  const keyError = schemaMessage({ version: '1', routes: {}, site: { robots: { ['k'.repeat(500)]: 1 } } });
  assert.ok(keyError.includes('"' + 'k'.repeat(64) + '..."') && !keyError.includes('k'.repeat(65)));
});
