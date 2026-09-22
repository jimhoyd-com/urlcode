import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { apiUsed, assertPeerFloorCoversApi, coreApiSince, coreName, describeViolations, peerApiViolations, propertyNames, raisedCorePeer, scaffoldApiBaseline, scaffoldApiSince, scaffoldApiUsed, scaffoldContractMembers } from '../scripts/peer-api.ts';

const root = fileURLToPath(new URL('..', import.meta.url));

test('every member of the scaffold contract is either baseline or has a recorded core release', async () => {
  const members = scaffoldContractMembers(await readFile(new URL('../packages/core/src/extensions.ts', import.meta.url), 'utf8'));
  assert(members.includes('acknowledgements') && members.includes('name'), 'the contract interfaces were not found');
  const undecided = members.filter(member => !scaffoldApiBaseline.includes(member) && !(member in scaffoldApiSince));
  assert.deepEqual(undecided, [], 'a new ScaffoldRequest/ScaffoldResult member needs an entry in scripts/peer-api.ts: the first core release that has it, so packages that use it raise their peer floor');
  assert.deepEqual(Object.keys(scaffoldApiSince).filter(field => !members.includes(field)), [], 'the table names a member the contract no longer has');
  assert.deepEqual(scaffoldApiBaseline.filter(field => !members.includes(field)), []);
});

test('the scan reads property names, not comments or strings', () => {
  const names = propertyNames("// after: comment\nconst text = 'requires: string';\nconst a = { provides: [], routeNotes };\nconst { acknowledgements, names: n } = request; request.acknowledged;\nimport { ExtensionAuthoringContract as C } from 'x';");
  assert.deepEqual([...names].sort(), ['ExtensionAuthoringContract', 'acknowledged', 'acknowledgements', 'names', 'provides', 'routeNotes']);
  assert.deepEqual(apiUsed('export const s = () => ({ after: [], name: "x" });').map(use => use.field), ['after']);
  assert.deepEqual(apiUsed('const x = 1; // provides after', scaffoldApiSince), []);
});

test('the store scaffold and its authoring contract need a core floor above 0.4.2 (#346)', async () => {
  const used = await scaffoldApiUsed(root, 'packages/store');
  for (const field of ['acknowledgements', 'acknowledged', 'routeNotes', 'provides', 'after', 'authoring']) assert(used.some(use => use.field === field), `${field} not detected`);
  const violations = peerApiViolations(used, { [coreName]: '>=0.4.2 <0.5.0' });
  assert(violations.length >= 6);
  assert.match(describeViolations('@jimhoyd/urlcode-store', violations), /peer floor 0\.4\.2 does not include[\s\S]*raise the peer floor to >=0\.4\.9, which needs that core release/);
  assert.deepEqual(peerApiViolations(used, { [coreName]: '>=0.4.9 <0.5.0' }), []);
  await assert.rejects(assertPeerFloorCoversApi(root, 'packages/store', '@jimhoyd/urlcode-store', { [coreName]: '>=0.4.2 <0.5.0' }), /acknowledgements/);
  await assertPeerFloorCoversApi(root, 'packages/store', '@jimhoyd/urlcode-store', { [coreName]: '>=0.4.9 <0.5.0' });
});

test('a package with no core peer or no source is judged by what it uses', async () => {
  assert.equal(peerApiViolations([{ field: 'after', since: '0.4.3' }], undefined)[0]?.floor, 'none');
  assert.deepEqual(peerApiViolations([], undefined), []);
  assert.deepEqual(await scaffoldApiUsed(root, 'packages/does-not-exist'), []);
});

test('a peer floor is raised to the needed core release, keeping its upper bound, and only when core has it', () => {
  const uses = [{ field: 'acknowledgements', since: '0.4.3' }, { field: 'provides', since: '0.4.3' }];
  assert.equal(raisedCorePeer('store', uses, { [coreName]: '>=0.4.2 <0.5.0' }, '0.4.3'), '>=0.4.3 <0.5.0');
  assert.equal(raisedCorePeer('store', uses, { [coreName]: '>=0.4.3 <0.5.0' }, '0.4.3'), undefined);
  assert.equal(raisedCorePeer('store', [], { [coreName]: '>=0.4.2 <0.5.0' }, '0.4.2'), undefined);
  assert.throws(() => raisedCorePeer('store', uses, { [coreName]: '>=0.4.2 <0.5.0' }, '0.4.2'), /release core 0\.4\.3 first, or select all packages/);
});

test('recorded core releases are exact versions', () => {
  for (const [name, version] of [...Object.entries(scaffoldApiSince), ...Object.entries(coreApiSince)]) assert.match(version, /^\d+\.\d+\.\d+$/, name);
});

test('core defines the scaffold and authoring contracts, so the release preflight never holds it to a peer floor', async () => {
  // The 0.4.4 release failed here: core has no peer on itself, so its "floor" was none and its own source tripped the guard.
  await assertPeerFloorCoversApi(root, '.', coreName, undefined);
  await assert.rejects(assertPeerFloorCoversApi(root, 'packages/store', '@jimhoyd/urlcode-store', undefined), /peer floor/);
});
