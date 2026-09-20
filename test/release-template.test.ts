import test from 'node:test';
import assert from 'node:assert/strict';
import { assertTemplateLock, assertTemplateUpgrade, updateTemplateText } from '../scripts/release-template.ts';

test('template upgrade changes active pins and schema references, preserving migration history', () => {
  const input = 'Under the pinned `0.4.0-alpha.3` runtime\nIn the `0.4.0-alpha.3` runtime this template pins\nThis template pins the `0.4.0-alpha.3` published runtime\nBefore `0.4.0-alpha.3`, behavior differed\nhttps://github.com/jimhoyd-com/urlcode/blob/v0.4.0-alpha.3/docs/SECURITY.md\n# yaml-language-server: $schema=https://raw.githubusercontent.com/jimhoyd-com/urlcode/abcdef/schemas/urlcode.schema.json';
  const result = updateTemplateText(input, '0.4.0-alpha.3', '0.4.0-alpha.4');
  assert.equal(result.match(/0\.4\.0-alpha\.4/g)?.length, 5);
  assert.match(result, /Before `0.4.0-alpha.3`, behavior differed/);
  assert.match(result, /urlcode\/v0.4.0-alpha.4\/schemas/);
});


test('template resume cannot reuse a stale release PR to downgrade main or another version branch', () => {
  assert.throws(() => assertTemplateUpgrade('0.4.0-alpha.4', '0.4.0-alpha.3'), /downgrade/);
  assert.throws(() => assertTemplateUpgrade('0.4.0-alpha.2', '0.4.0-alpha.3', '0.4.0-alpha.4'), /different runtime pin/);
  assert.throws(() => assertTemplateUpgrade('^0.4.0-alpha.2', '0.4.0-alpha.3'), /exact version/);
  assertTemplateUpgrade('0.4.0-alpha.2', '0.4.0-alpha.3', '0.4.0-alpha.3');
});


test('template resume rejects a package pin whose lock still installs another runtime', () => {
  const lock = { packages: { '': { dependencies: { '@jimhoyd/urlcode': '0.4.0-alpha.3' } }, 'node_modules/@jimhoyd/urlcode': { version: '0.4.0-alpha.2' } } };
  assert.throws(() => assertTemplateLock('0.4.0-alpha.3', lock), /installed lock entry/);
  lock.packages['node_modules/@jimhoyd/urlcode'].version = '0.4.0-alpha.3';
  assertTemplateLock('0.4.0-alpha.3', lock);
});
