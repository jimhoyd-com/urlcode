import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify } from 'yaml';
import http from 'node:http';
import type { IncomingHttpHeaders, OutgoingHttpHeaders } from 'node:http';
import type { TestContext } from 'node:test';
import {supportsConcurrentWal} from '../src/sqlite-version.ts';
import type { OperatorPolicy } from '../src/policy.ts';
import type { ParameterConfig, RouteConfig } from '../src/types.ts';
import type { ParameterLocation, ParameterSchema } from '../src/match.ts';

// Live links require a Node build carrying the patched SQLite WAL fix. Skipping
// keeps an unpatched but otherwise supported Node from reporting a suite of
// false failures that hide real regressions.
export const liveLinksSkip = supportsConcurrentWal(process.versions.sqlite) ? false
  : `Node ${process.version} bundles SQLite ${process.versions.sqlite} without the patched WAL fix; live links need 3.51.3+, 3.50.7 or 3.44.6`;

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
  const {loadDocument} = await import('../src/config.ts');
  const {prepareFunctionSnapshot,requestedPermissions} = await import('../src/policy.ts');
  const loaded = await loadDocument(root);
  return requestedPermissions(loaded,await prepareFunctionSnapshot(loaded));
}
