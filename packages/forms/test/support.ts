import { cleanup } from './cleanup.ts';
// Real composed sites for the forms consumers of abuse and mail: a project on disk, host.mjs's extension list
// through composeHost, and a served runtime with a cookie jar.
import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { startServer } from '@jimhoyd/urlcode';
import { inspectExtensionRevision } from '@jimhoyd/urlcode/extensions';
import type { ExtensionEntry } from '@jimhoyd/urlcode/extensions';
import { composeHost } from '@jimhoyd/urlcode/host';

export const origin = 'https://forms.example.test';
/** The contact flow the tests guard; `extra` adds `abuse` or `notify`. */
export function contact(extra: Record<string, unknown> = {}) {
  return {
    mount: '/contact', title: 'Contact us', submitLabel: 'Send', confirmation: { title: 'Thanks', message: 'Received.' },
    fields: { name: { label: 'Name', maxLength: 120 }, email: { label: 'Email', type: 'email', maxLength: 320 }, message: { label: 'Message', control: 'textarea', minLength: 5, maxLength: 2000 } },
    ...extra,
  };
}
/** An onSubmit hook that records each call on `globalThis.__formsHookCalls` and throws for a message containing "boom". A fixed source: `site()` resets the record for each site it writes. */
export const recordingHook = `export default async function onSubmit(input) { if (input.values.message.includes('boom')) throw new Error('boom'); (globalThis.__formsHookCalls ??= []).push(input); }\n`;
/** The onSubmit calls `recordingHook` recorded since the current site was written. */
export const hookCalls = (): unknown[] => (globalThis as unknown as { __formsHookCalls?: unknown[] }).__formsHookCalls ?? [];

export interface SiteOptions { declare?: readonly string[]; hook?: string }
/** Writes app/urlcode.yaml with ui, forms (the given flows) and any extra `declare`d extensions, and pins its revision. */
export async function site(t: TestContext, flows: Record<string, unknown>, options: SiteOptions = {}) {
  const root = await mkdtemp(join(tmpdir(), 'forms-consumer-'));
  cleanup(t, () => rm(root, { recursive: true, force: true }));
  const project = join(root, 'app');
  await mkdir(project);
  if (options.hook) { (globalThis as unknown as { __formsHookCalls?: unknown[] }).__formsHookCalls = []; await writeFile(join(project, 'on-submit.mjs'), options.hook); }
  const routes: Record<string, unknown> = { '/assets/ui/*': { extension: 'ui' } };
  for (const flow of Object.values(flows) as { mount: string }[]) routes[`${flow.mount}/*`] = { extension: 'forms', methods: ['GET', 'HEAD', 'POST'] };
  const extensions: Record<string, unknown> = { ui: { version: '1', config: {} }, forms: { version: '1', config: { flows, ...(options.hook ? { hooks: { onSubmit: './on-submit.mjs' } } : {}) } } };
  for (const name of options.declare ?? []) extensions[name] = { version: '1', config: {} };
  await writeFile(join(project, 'urlcode.yaml'), JSON.stringify({ version: '1', extensions, routes }));
  const sha = await inspectExtensionRevision(project);
  const previous = process.env.PROJECT_SHA256;
  process.env.PROJECT_SHA256 = sha;
  cleanup(t, () => { if (previous === undefined) delete process.env.PROJECT_SHA256; else process.env.PROJECT_SHA256 = previous; });
  return { root, project, sha, hostUrl: pathToFileURL(join(root, 'host.mjs')) };
}

/** Composes `entries` for the site and serves it; `call` keeps cookies like a browser. */
export async function serve(t: TestContext, where: Awaited<ReturnType<typeof site>>, entries: readonly ExtensionEntry[]) {
  const host = await composeHost(where.hostUrl, entries);
  cleanup(t, () => host.close?.());
  const app = await startServer({ project: where.project, origin, port: 0, log: () => {}, extensions: host.extensions ?? [] });
  cleanup(t, () => app.close());
  const cookies = new Map<string, string>();
  const call = async (path: string, init: { method?: string; body?: URLSearchParams } = {}) => {
    const response = await fetch(`http://127.0.0.1:${app.address.port}${path}`, {
      method: init.method ?? 'GET', redirect: 'manual',
      headers: { origin, ...(init.body ? { 'content-type': 'application/x-www-form-urlencoded' } : {}), ...(cookies.size ? { cookie: [...cookies].map(([key, value]) => `${key}=${value}`).join('; ') } : {}) },
      ...(init.body ? { body: init.body } : {}),
    });
    for (const header of response.headers.getSetCookie()) {
      const first = header.split(';')[0]!, index = first.indexOf('=');
      if (header.includes('Max-Age=0')) cookies.delete(first.slice(0, index)); else cookies.set(first.slice(0, index), first.slice(index + 1));
    }
    return response;
  };
  /** GETs the form and returns its page and CSRF token. */
  const form = async (path = '/contact') => { const html = await (await call(path)).text(); const csrf = /name="csrf" value="([^"]+)"/.exec(html)?.[1]; assert.ok(csrf, 'the form carries a CSRF token'); return { html, csrf }; };
  /** Submits the form with a fresh token. */
  const submit = async (fields: Record<string, string>, path = '/contact') => { const { csrf } = await form(path); return call(path, { method: 'POST', body: new URLSearchParams({ csrf, ...fields }) }); };
  return { call, form, submit, cookies };
}
export const valid = { name: 'Ada', email: 'ada@example.test', message: 'Hello there' };
