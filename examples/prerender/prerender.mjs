#!/usr/bin/env node
// Prerender recipe: render this project's function/middleware routes once, at
// build time, into a native page project that serves the same bytes with no
// guest execution on the request path.
//
// The orchestration that is easy to get wrong — runtime lifecycle, response
// validation, budgets, byte fidelity and output-path safety — lives in the
// runtime's build helper. What is left here is the part every site does
// differently: assembling a project from the rendered pages. In your own
// project, import the helper from the package:
//
//   import {prerenderPages, assertNativeProject} from '@jimhoyd/urlcode/prerender';
//
import {mkdir, writeFile, rm} from 'node:fs/promises';
import {realpathSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {stringify} from 'yaml';
import {prerenderPages, assertNativeProject} from '@jimhoyd/urlcode/prerender';

export async function prerender(project, output, {log = () => {}} = {}) {
  const out = resolve(output);
  // Pages are rendered and written first; nothing below runs unless every one
  // of them produced a complete HTML response.
  const rendered = await prerenderPages(project, join(out, 'public'), {log});

  // Assemble the serving project. A larger site does this differently: it adds
  // static and download routes, response security headers and its own entry
  // point, and may write a generated include instead of a whole project.
  await writeFile(join(out, 'urlcode.yaml'), stringify({
    version: '1',
    routes: Object.fromEntries(rendered.pages.map(page =>
      [page.path, {page: {file: `public/${page.file}`, cacheControl: 'no-cache'}}])),
  }));
  await mkdir(join(out, 'tests'), {recursive: true});
  await writeFile(join(out, 'tests/requests.json'), JSON.stringify(rendered.fixtures, null, 2) + '\n');

  // Prove the artifact is inert before anyone deploys it.
  await assertNativeProject(out, {allow: ['page'], log});
  return {pages: rendered.count, bytes: rendered.bytes, output: out};
}

// Node resolves a module's own URL through symlinks, so comparing it to a raw
// argv[1] misses when this file is reached through one — as it is under macOS's
// /var -> /private/var temporary directories, where the script would otherwise
// exit 0 having silently done nothing.
const invokedDirectly = () => {
  try { return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; }
  catch { return false; }
};
if (process.argv[1] && invokedDirectly()) {
  const [project = fileURLToPath(new URL('.', import.meta.url)), output = 'dist'] = process.argv.slice(2);
  const print = value => process.stdout.write(JSON.stringify(value) + '\n');
  try {
    // The helper refuses to write into an existing directory, so a repeated
    // build clears its own output rather than merging into a stale one.
    await rm(resolve(output), {recursive: true, force: true});
    print({event: 'prerendered-project', ...await prerender(project, output, {log: print})});
  } catch (error) {
    process.stderr.write(JSON.stringify({event: 'error', message: error.message}) + '\n');
    process.exitCode = 1;
  }
}
