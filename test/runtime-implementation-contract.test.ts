import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');

test('runtime implementation guide maps every contract card to its live source seam', async () => {
  const guide = await readFile(join(root, 'docs', 'RUNTIME-IMPLEMENTATION.md'), 'utf8');
  const cards = [...guide.matchAll(/^\| `(RIM-[A-Z]+(?:-[A-Z]+)*-\d+)` \| (.*?) \|/gm)];
  assert.ok(cards.length > 0, 'the guide must contain at least one contract card');
  for (const [, id, sourceCell] of cards) {
    const seams = [...sourceCell!.matchAll(/`(packages\/core\/src\/[^`]+\.ts)`: ((?:`[^`]+`(?:, )?)+)/g)];
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
    readFile(join(root, 'packaging/container/Dockerfile'), 'utf8'),
    readFile(join(root, 'llms-full.txt'), 'utf8'),
  ]);
  assert.match(guide, /contributor documentation/i);
  assert.doesNotMatch(manifest, /"docs"/);
  assert.doesNotMatch(dockerfile, /COPY docs\b/);
  assert.doesNotMatch(llms, /Implementing the URLCode contract/);
});

test('runtime implementation command lists match the CLI-owned command metadata', async () => {
  // Narrow on purpose: only the live card's own lists are compared, so historical
  // explanations of a removed command elsewhere stay allowed (#1091).
  const guide = await readFile(join(root, 'docs', 'RUNTIME-IMPLEMENTATION.md'), 'utf8');
  const { hermeticHostCommands, localReviewCommands } = await import('../packages/core/src/cli-command-metadata.ts');
  const card = guide.match(/^\| `RIM-EXT-HERMETIC-001` \|.*$/m)?.[0];
  assert.ok(card, 'RIM-EXT-HERMETIC-001 must exist');
  const commands = (text: string) => [...text.matchAll(/`([a-z-]+)`/g)].map(([, name]) => name!);
  const replay = card.match(/A run that replays requests \(([^)]*), MCP `run_tests`\)/)?.[1];
  assert.ok(replay !== undefined, 'RIM-EXT-HERMETIC-001 must list the commands that replay requests');
  assert.deepEqual(commands(replay), [...hermeticHostCommands]);
  const review = card.match(/A local review \(([^)]*?) with `--local-review`/)?.[1];
  assert.ok(review !== undefined, 'RIM-EXT-HERMETIC-001 must list the local-review commands');
  const hermetic: readonly string[] = hermeticHostCommands;
  assert.deepEqual(commands(review), localReviewCommands.filter((name) => !hermetic.includes(name)));
});
