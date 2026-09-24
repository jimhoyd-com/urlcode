import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveExtensionRelease } from '../packages/core/src/extensions-cli.ts';

test('core selects matching immutable extension and artifact catalogs unless an operator overrides them', async () => {
  const dependencies={runningCoreVersion:async()=> '1.2.3'};
  assert.deepEqual(await resolveExtensionRelease('bundles',undefined,dependencies),{release:'extension-bundles@v1.2.3'});
  assert.deepEqual(await resolveExtensionRelease('artifacts',undefined,dependencies),{release:'extensions@v1.2.3'});
  assert.deepEqual(await resolveExtensionRelease('bundles','extension-bundles@v1.2.2',dependencies),{release:'extension-bundles@v1.2.2'});
});
