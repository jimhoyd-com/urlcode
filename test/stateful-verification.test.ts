// The stateful-handler reference scenarios (#1136): examples/stateful-verification passes its fixtures and its
// ordinary Node test as shipped, and each deliberate defect fails exactly the checks written for it while every
// other check keeps passing. That second half is the point of the example: a check that cannot fail is no evidence.
import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TestContext } from 'node:test';
import { startServer } from '../packages/core/src/server.ts';
import { runProjectTests, startRestartable } from '../packages/core/src/project-tests.ts';
import { auditProject } from '../packages/core/src/readiness.ts';

const example = fileURLToPath(new URL('../examples/stateful-verification/', import.meta.url));
type Scenario = (origin: string, options: { dataDir: string }) => Promise<void>;
// Importing the example's own test file registers it here, so the shipped project runs it as a consumer would.
const { scenarios } = await import(new URL('../examples/stateful-verification/tests/in-flight.test.mjs', import.meta.url).href) as { scenarios: Record<string, Scenario> };

const [pendingRead, concurrentPublishes, , failedCleanup, ownedProcesses] = Object.keys(scenarios) as [string, string, string, string, string];

/** The 1-based entries of tests/requests.json with a failed step. */
async function failedFixtures(root: string): Promise<number[]> {
  const entries = JSON.parse(await readFile(join(root, 'tests/requests.json'), 'utf8')) as { steps?: { restart?: true }[] }[];
  const owner: number[] = [];
  entries.forEach((entry, index) => { for (const step of entry.steps ?? [{}]) if (!step.restart) owner.push(index + 1); });
  const results: boolean[] = [];
  const { total } = await runProjectTests(root, { log: event => { if (event.event === 'test') results.push(event.pass === true); } });
  assert.equal(results.length, total); assert.equal(total, owner.length);
  return [...new Set(results.flatMap((pass, index) => pass ? [] : [owner[index]!]))];
}
async function failedScenarios(root: string, t: TestContext): Promise<string[]> {
  const dataDir = await mkdtemp(join(tmpdir(), 'urlcode-1136-data-'));
  const app = await startServer({ project: root, port: 0, local: true, dataDir, log: () => {} });
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  const failed: string[] = [];
  for (const [name, scenario] of Object.entries(scenarios)) {
    try { await scenario(`http://127.0.0.1:${app.address.port}`, { dataDir }); }
    catch (error) { assert.ok(error instanceof assert.AssertionError, `${name}: ${String(error)}`); failed.push(name); }
  }
  return failed;
}

test('the shipped project passes every fixture, and audit calls it ready although fixtures cover none of the in-flight rows', async () => {
  assert.deepEqual(await failedFixtures(example), []);
  const app = await startRestartable({ project: example, port: 0, local: true, log: () => {} });
  const audit = await auditProject(app, { expectRoutes: 7 }).finally(() => app.close());
  assert.equal(audit.ready, true); assert.equal(audit.failed, 0); assert.deepEqual(audit.uncovered, []);
});

const defects: [string, number[], string[]][] = [
  // peer-bin#2 in synthetic form: a control change written to the bounded event log is refused, and rolled back, at capacity.
  ['capacity-rollback', [2, 3, 5], []],
  ['derived-survives', [4], []],
  // peer-bin#3 in synthetic form: a read pending at revocation returns what was published afterwards. No fixture can see it.
  ['late-wait', [], [pendingRead]],
  ['lost-update', [], [concurrentPublishes]],
  ['cleanup-silent', [], [failedCleanup]],
  ['orphan-process', [], [ownedProcesses]],
];
for (const [defect, fixtures, checks] of defects) {
  test(`defect ${defect} fails exactly the checks written for it`, async t => {
    const root = await mkdtemp(join(tmpdir(), 'urlcode-1136-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    await cp(example, root, { recursive: true });
    const yaml = await readFile(join(root, 'urlcode.yaml'), 'utf8');
    assert.match(yaml, /DEFECTS: \{value: none\}/);
    await writeFile(join(root, 'urlcode.yaml'), yaml.replace('DEFECTS: {value: none}', `DEFECTS: {value: ${defect}}`));
    assert.deepEqual(await failedFixtures(root), fixtures);
    assert.deepEqual(await failedScenarios(root, t), checks);
  });
}
