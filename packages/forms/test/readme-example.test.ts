import { cleanup } from './cleanup.ts';
// The README's onSubmit example (#822) is executable documentation: this test takes its YAML and module verbatim from
// "Handling a submission (`onSubmit`)", serves them through composeHost, and checks the hook really ran with the
// declared values. Editing either block without keeping it working fails here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { inspectExtensionRevision } from '@jimhoyd/urlcode/extensions';
import ui from '@jimhoyd/urlcode-ui/extension';
import forms from '../src/extension.ts';
import { serve } from './support.ts';

const heading = '## Handling a submission (`onSubmit`)';

/** The first fenced block of `language` in the README section under `heading`. */
function block(section: string, language: string): string {
  const match = new RegExp('```' + language + '\\n([\\s\\S]*?)\\n```').exec(section);
  assert.ok(match, `the section has a ${language} block`);
  return `${match[1]!}\n`;
}

test('the README onSubmit declaration and module run as written', async t => {
  const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8');
  const start = readme.indexOf(heading);
  assert.ok(start >= 0, 'the README keeps the onSubmit section');
  const section = readme.slice(start, readme.indexOf('\n## ', start + heading.length));
  const yaml = block(section, 'yaml'), module = block(section, 'js');
  assert.match(yaml, /onSubmit: hooks\/on-submit\.mjs/);
  assert.match(module, /^\/\/ app\/hooks\/on-submit\.mjs/);

  const root = await mkdtemp(join(tmpdir(), 'forms-readme-'));
  cleanup(t, () => rm(root, { recursive: true, force: true }));
  const project = join(root, 'app');
  await mkdir(join(project, 'hooks'), { recursive: true });
  await writeFile(join(project, 'urlcode.yaml'), yaml);
  await writeFile(join(project, 'hooks', 'on-submit.mjs'), module);
  const sha = await inspectExtensionRevision(project);
  const previous = process.env.PROJECT_SHA256;
  process.env.PROJECT_SHA256 = sha;
  cleanup(t, () => { if (previous === undefined) delete process.env.PROJECT_SHA256; else process.env.PROJECT_SHA256 = previous; });

  const { submit } = await serve(t, { root, project, sha, hostUrl: pathToFileURL(join(root, 'host.mjs')) }, [ui(), forms({ csrfSecret: 'r'.repeat(32) })]);
  const invalid = await submit({ email: 'ada@example.test', topic: 'support', message: 'short' });
  assert.equal(invalid.status, 422, 'a submission that fails validation never reaches the hook');
  await assert.rejects(readFile(join(root, 'data', 'form-submissions.jsonl'), 'utf8'), { code: 'ENOENT' });

  const accepted = await submit({ email: 'ada@example.test', topic: 'sales', message: 'Please call me back.' });
  assert.equal(accepted.status, 303);
  assert.equal(accepted.headers.get('location'), '/contact/confirmation');
  const lines = (await readFile(join(root, 'data', 'form-submissions.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>);
  assert.equal(lines.length, 1);
  const { requestId, ...rest } = lines[0]!;
  assert.equal(typeof requestId, 'string');
  assert.deepEqual(rest, { flow: 'contact', email: 'ada@example.test', topic: 'sales', message: 'Please call me back.' });
});
