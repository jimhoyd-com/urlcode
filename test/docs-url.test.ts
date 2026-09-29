import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CORE_VERSION, docsUrl } from '../packages/core/src/release.ts';
import { markdownAnchors } from '../scripts/check-local-links.ts';

const root = join(import.meta.dirname, '..');

test('docsUrl links this release tag, never main (#938)', async () => {
  const { version } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as { version: string };
  assert.equal(CORE_VERSION, version);
  assert.equal(docsUrl('HTTP.md#error-format'), `https://github.com/jimhoyd-com/urlcode/blob/v${version}/docs/HTTP.md#error-format`);
});

test('every docsUrl page core names exists in this checkout, with its heading', async () => {
  const source = join(root, 'packages', 'core', 'src');
  const files = (await readdir(source, { recursive: true })).filter(file => file.endsWith('.ts'));
  const pages = new Map<string, string>();
  for (const file of files) {
    for (const match of (await readFile(join(source, file), 'utf8')).matchAll(/docsUrl\('([^']+)'\)/g)) pages.set(match[1]!, file);
  }
  assert.ok(pages.size >= 8, `expected the installed docs links, found ${pages.size}`);
  for (const [page, file] of pages) {
    if (file === 'release.ts') continue;
    const [path, fragment] = page.split('#', 2) as [string, string | undefined];
    const text = await readFile(join(root, 'docs', path), 'utf8').catch(() => undefined);
    assert.ok(text !== undefined, `${file}: docsUrl('${page}') names docs/${path}, which does not exist`);
    if (fragment) assert.ok(markdownAnchors(text).has(fragment), `${file}: docs/${path} has no heading #${fragment}`);
  }
});
