import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');

test('runtime implementation guide maps every contract card to its live source seam', async () => {
  const guide = await readFile(join(root, 'docs', 'RUNTIME-IMPLEMENTATION.md'), 'utf8');
  const cards = [...guide.matchAll(/^\| `(RIM-[A-Z]+-\d+)` \| (.*?) \|/gm)];
  assert.ok(cards.length > 0, 'the guide must contain at least one contract card');
  for (const [, id, sourceCell] of cards) {
    const seams = [...sourceCell!.matchAll(/`(src\/[^`]+\.ts)`: ((?:`[^`]+`(?:, )?)+)/g)];
    assert.ok(seams.length > 0, `${id} must name at least one source seam`);
    for (const [, file, encodedNames] of seams) {
      const source = await readFile(join(root, file!), 'utf8');
      const names = [...encodedNames!.matchAll(/`([^`]+)`/g)].map(([, name]) => name!);
      for (const name of names) assert.match(source, new RegExp('\\b' + name + '\\b'), `${id} maps to missing ${file} symbol ${name}`);
    }
  }
});

test('runtime implementation guide remains contributor-only', async () => {
  const [guide, manifest, dockerfile, llms] = await Promise.all([
    readFile(join(root, 'docs', 'RUNTIME-IMPLEMENTATION.md'), 'utf8'),
    readFile(join(root, 'package.json'), 'utf8'),
    readFile(join(root, 'Dockerfile'), 'utf8'),
    readFile(join(root, 'llms-full.txt'), 'utf8'),
  ]);
  assert.match(guide, /contributor documentation/i);
  assert.doesNotMatch(manifest, /"docs"/);
  assert.doesNotMatch(dockerfile, /COPY docs\b/);
  assert.doesNotMatch(llms, /Implementing the URLCode contract/);
});
