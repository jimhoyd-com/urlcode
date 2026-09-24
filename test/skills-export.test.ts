import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

// `@jimhoyd/urlcode/skills` (packages/core/src/skills.ts) is the supported
// public way for a host to read this package's shipped skill text -- see
// issue #574. It replaces reads of internal package-layout paths such as
// `node_modules/@jimhoyd/urlcode/.claude/skills/...`. Exercise the export
// itself (not a mock), and check it against the real files on disk, the way
// a host importing the published package would.

const root = fileURLToPath(new URL('../', import.meta.url));

test('@jimhoyd/urlcode/skills returns every shipped skill with real text', async () => {
  const { listShippedSkills } = await import('@jimhoyd/urlcode/skills') as
    { listShippedSkills: () => Promise<{ name: string; version: string; text: string }[]> };
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };

  const skills = await listShippedSkills();
  assert.deepEqual(skills.map(skill => skill.name).sort(), ['urlcode', 'urlcode-authoring', 'urlcode-operations']);

  const onDisk: Record<string, string> = {
    urlcode: 'skills/urlcode/SKILL.md',
    'urlcode-authoring': '.claude/skills/urlcode-authoring/SKILL.md',
    'urlcode-operations': '.claude/skills/urlcode-operations/SKILL.md',
  };
  for (const skill of skills) {
    assert.equal(skill.version, pkg.version, `${skill.name} version must be the package version`);
    const expected = await readFile(root + onDisk[skill.name], 'utf8');
    assert.equal(skill.text, expected, `${skill.name} text must match the file on disk`);
    assert.match(skill.text, /^---\nname: /, `${skill.name} text should include SKILL.md frontmatter`);
  }
});
