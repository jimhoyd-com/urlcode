import assert from 'node:assert/strict';
import test from 'node:test';
import { parsePackJson } from '../scripts/pack-json.ts';

test('parsePackJson tolerates leading noise', () => {
  assert.deepEqual(parsePackJson('built 86 modules into dist/\n[\n  {"name":"x"}\n]\n'), [{ name: 'x' }]);
  assert.deepEqual(parsePackJson('[{"name":"y"}]'), [{ name: 'y' }]);
});

test('parsePackJson failure includes stdout and stderr', () => {
  assert.throws(() => parsePackJson('built 86 modules into dist/\n', 'boom'), /built 86 modules[\s\S]*boom/);
});
