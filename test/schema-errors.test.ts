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

test('unknown keys near an allowed key get a did-you-mean, others keep a bounded key list', () => {
  const typo = schemaMessage({ version: '1', routes: { '/': { methds: ['GET'], redirect: { to: 'https://example.com' } } } });
  assert.match(typo, /^Invalid configuration at \/routes\/~1 \(additionalProperties\): unknown key "methds"; did you mean "methods"\?/);
  assert.ok(!typo.includes('allowed keys'));
  assert.match(schemaMessage({ version: '1', routes: {}, site: { robots: { disalow: [] } } }), /did you mean "disallow"\?/);
  const far = schemaMessage({ version: '1', routes: { '/': { zzzzzzzz: 1, redirect: { to: 'https://example.com' } } } });
  assert.match(far, /unknown key "zzzzzzzz"; allowed keys: methods, .*\.\.\. \(\d+ more\) \(run urlcode schema <path>/);
  assert.equal(far.split('\n').length, 1);
});

test('schema errors never echo values and bound the echoed key length', () => {
  const secret = 'sk_live_supersecretvalue';
  const valueError = schemaMessage({ version: '1', routes: {}, site: { robots: { sitemap: secret } } });
  assert.match(valueError, /Invalid configuration at \/site\/robots\/sitemap \(type\)/);
  assert.ok(!valueError.includes(secret));
  const keyError = schemaMessage({ version: '1', routes: {}, site: { robots: { ['k'.repeat(500)]: 1 } } });
  assert.ok(keyError.includes('"' + 'k'.repeat(64) + '..."') && !keyError.includes('k'.repeat(65)));
});
