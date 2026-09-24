import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify } from 'yaml';
import http from 'node:http';
import type { IncomingHttpHeaders, OutgoingHttpHeaders } from 'node:http';
import type { TestContext } from 'node:test';
import type { OperatorPolicy } from '../packages/core/src/policy.ts';
import type { ParameterConfig, RouteConfig } from '../packages/core/src/types.ts';
import type { ParameterLocation, ParameterSchema } from '../packages/core/src/match.ts';

/** The routes a test project declares: well-formed RouteConfigs, or any object when a test probes validation. */
export type ProjectRoutes = Record<string, RouteConfig | object>;
/** Files to write under the project root, keyed by relative path. */
export type ProjectFiles = Record<string, string | Buffer>;
/** Top-level document keys merged before `routes` (policies, profiles, site, includes, ...). */
export type ProjectSettings = Record<string, unknown>;

export async function project(t: TestContext, routes: ProjectRoutes, files: ProjectFiles = {}, settings: ProjectSettings = {}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(),'urlcode-test-'));
  t.after(() => rm(root,{ recursive:true, force:true }));
  await writeFile(join(root,'urlcode.yaml'), stringify({ version:'1', ...settings, routes }));
  for (const [file,content] of Object.entries(files)) {
    await mkdir(join(root,file,'..'),{ recursive:true }); await writeFile(join(root,file),content);
  }
  return root;
}

/** Anything exposing the listening address: a started Server or a runtime wrapper. */
export interface Addressed { address: { port: number } }
export interface RequestOptions { method?: string; headers?: OutgoingHttpHeaders; body?: string | Buffer | undefined }
export interface Response { status: number; headers: IncomingHttpHeaders; bytes: Buffer; body: string }

export function request(app: Addressed, path: string, { method='GET', headers={}, body }: RequestOptions = {}): Promise<Response> {
  return new Promise((resolve,reject) => {
    const req = http.request({ host:'127.0.0.1', port:app.address.port, path, method, headers, timeout:10000 }, res => {
      const chunks: Buffer[] = []; res.on('data',(c: Buffer) => chunks.push(c)); res.on('error',reject);
      res.on('end',() => resolve({ status:res.statusCode ?? 0, headers:res.headers, bytes:Buffer.concat(chunks), body:Buffer.concat(chunks).toString() }));
    });
    req.on('error',reject); req.on('timeout',() => req.destroy(new Error('HTTP test timeout'))); req.end(body);
  });
}
export const redirect = (url='https://example.com/'): RouteConfig => ({ redirect:{ url } });
export const param = (name: string, type: ParameterSchema['type']='string', source: ParameterLocation='path'): ParameterConfig =>
  ({ name, in:source, required:source === 'path', schema:{ type } });

export async function approveBindings(root: string): Promise<OperatorPolicy> {
  const {loadDocument} = await import('../packages/core/src/config.ts');
  const {prepareFunctionSnapshot,requestedPermissions} = await import('../packages/core/src/policy.ts');
  const loaded = await loadDocument(root);
  return requestedPermissions(loaded,await prepareFunctionSnapshot(loaded));
}

/**
 * A site from `urlcode init` with one inert artifact installed through `urlcode artifacts add`, using the add-on
 * fixtures and the fake npm (test/fixtures/addons). The running core's manifest is replaced (URLCODE_ADDONS) by one
 * that pins `name` to a copy of the `notes` fixture, so the artifact reads as installed and pinned. Both
 * environment variables are restored after the test.
 */
export async function artifactSite(t: TestContext, name = 'notes'): Promise<{ site: string; project: string }> {
  const { cp, readFile } = await import('node:fs/promises');
  const { fileURLToPath } = await import('node:url');
  const { initSite } = await import('../packages/core/src/authoring.ts');
  const { addAddons } = await import('../packages/core/src/addon-install.ts');
  const fixtures = fileURLToPath(new URL('./fixtures/addons/', import.meta.url));
  const root = await mkdtemp(join(tmpdir(), 'urlcode-artifact-site-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'source', name);
  await cp(join(fixtures, 'notes'), source, { recursive: true });
  for (const file of ['urlcode.json', 'package.json']) {
    const text = await readFile(join(source, file), 'utf8');
    await writeFile(join(source, file), text.replaceAll('"notes"', `"${name}"`).replaceAll('urlcode-notes', `urlcode-${name}`));
  }
  await writeFile(join(source, 'README.md'), `# ${name}\n`);
  const manifest = join(root, 'addons.json');
  await writeFile(manifest, JSON.stringify({ format: 1, version: '9.9.9', addons: { [name]: { kind: 'artifact', package: `@jimhoyd/urlcode-${name}`, description: name, requires: [], url: `file:${source}`, integrity: null } } }));
  const previous = { URLCODE_ADDONS: process.env.URLCODE_ADDONS, URLCODE_NPM: process.env.URLCODE_NPM };
  t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  process.env.URLCODE_ADDONS = manifest;
  process.env.URLCODE_NPM = join(fixtures, 'fake-npm.mjs');
  const { site } = await initSite(join(root, 'site'));
  await addAddons(site, 'artifact', [name]);
  return { site, project: join(site, 'app') };
}
