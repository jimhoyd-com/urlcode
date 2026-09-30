import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CORE_VERSION, docsUrl } from '../packages/core/src/release.ts';
import { VFile } from 'vfile';
import { checkLinks } from '../scripts/check-local-links.ts';

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
  // Each link core ships, written as a Markdown link and checked the way check-local-links checks a pinned link.
  const links = [...pages].filter(([, file]) => file !== 'release.ts').map(([page, file]) => `[${file}](${docsUrl(page)})`);
  const { failures, links: checked } = await checkLinks(root, [new VFile({ path: join(root, 'docs-url.md'), value: links.join('\n\n') })]);
  assert.ok(checked >= links.length, 'every docsUrl link is checked against the checkout');
  assert.deepEqual(failures.map(failure => `${links[(failure.line - 1) / 2]}: ${failure.detail}`), []);
});
