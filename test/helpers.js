import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify } from 'yaml';
import http from 'node:http';
import {supportsConcurrentWal} from '../src/sqlite-version.js';

// Live links require a Node build carrying the patched SQLite WAL fix. Skipping
// keeps an unpatched but otherwise supported Node from reporting a suite of
// false failures that hide real regressions.
export const liveLinksSkip = supportsConcurrentWal(process.versions.sqlite) ? false
  : `Node ${process.version} bundles SQLite ${process.versions.sqlite} without the patched WAL fix; live links need 3.51.3+, 3.50.7 or 3.44.6`;
export async function project(t, routes, files = {}, settings = {}) {
  const root = await mkdtemp(join(tmpdir(),'urlcode-test-'));
  t.after(() => rm(root,{ recursive:true, force:true }));
  await writeFile(join(root,'urlcode.yaml'), stringify({ version:'1', ...settings, routes }));
  for (const [file,content] of Object.entries(files)) {
    await mkdir(join(root,file,'..'),{ recursive:true }); await writeFile(join(root,file),content);
  }
  return root;
}
export function request(app, path, { method='GET', headers={}, body } = {}) {
  return new Promise((resolve,reject) => {
    const req = http.request({ host:'127.0.0.1', port:app.address.port, path, method, headers, timeout:10000 }, res => {
      const chunks = []; res.on('data',c => chunks.push(c)); res.on('error',reject);
      res.on('end',() => resolve({ status:res.statusCode, headers:res.headers, bytes:Buffer.concat(chunks), body:Buffer.concat(chunks).toString() }));
    });
    req.on('error',reject); req.on('timeout',() => req.destroy(new Error('HTTP test timeout'))); req.end(body);
  });
}
export const redirect = (url='https://example.com/') => ({ redirect:{ url } });
export const param = (name, type='string', source='path') => ({ name, in:source, required:source === 'path', schema:{ type } });

export async function approveBindings(root) {
  const {loadDocument} = await import('../src/config.js');
  const {prepareFunctionSnapshot,requestedPermissions} = await import('../src/policy.js');
  const loaded = await loadDocument(root);
  return requestedPermissions(loaded,await prepareFunctionSnapshot(loaded));
}
