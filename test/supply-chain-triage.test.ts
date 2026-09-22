import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTriage } from '../scripts/supply-chain-triage.ts';

const lock = { packages: {
  '': { dependencies: { 'quickjs-emscripten': '0.32.0' } },
  'node_modules/quickjs-emscripten': { version: '0.32.0', integrity: 'sha512-example', license: 'MIT' },
  'node_modules/quickjs-emscripten/node_modules/wasm-foo': { version: '1.2.3' },
  'node_modules/dev-only': { version: '1.0.0', dev: true },
} };
const exceptions = { version: 1 as const, exceptions: [{
  id: 'quickjs-wasm-dynamic-execution', package: { name: 'quickjs-emscripten', version: '0.32.0' },
  categories: ['dynamic-code-execution'], disposition: 'accepted' as const, rationale: 'bounded', review: 'on change',
}] };

test('supply-chain triage maps production components and reviewed exceptions to lockfile paths', () => {
  const report = buildTriage(lock, exceptions, Buffer.from('tarball'), Buffer.from('{}'));
  assert.deepEqual(report.components.map(component => [component.name, component.version, component.paths]), [
    ['quickjs-emscripten', '0.32.0', ['node_modules/quickjs-emscripten']],
    ['wasm-foo', '1.2.3', ['node_modules/quickjs-emscripten/node_modules/wasm-foo']],
  ]);
  assert.deepEqual(report.exceptions[0]?.packagePaths, ['node_modules/quickjs-emscripten']);
  assert.match(report.tarball.sha256, /^[a-f0-9]{64}$/);
});

test('supply-chain triage refuses stale reviewed exceptions', () => {
  assert.throws(() => buildTriage(lock, { ...exceptions, exceptions: [{ ...exceptions.exceptions[0]!, package: { name: 'missing', version: '1.0.0' } }] }, Buffer.from('tarball'), Buffer.from('{}')), /absent from the locked production tree/);
});
