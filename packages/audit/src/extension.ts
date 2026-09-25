// The audit extension definition: what `urlcode extensions add audit` scaffolds into a site, and what host.mjs
// activates through `composeHost`:
//
//   import audit from '@jimhoyd/urlcode-audit/extension';
//   export default await composeHost(import.meta.url, [audit(), ui(), auth()]);
//
// Other extensions read its exports (AuditExports v1) through ctx.get('audit'). It serves no routes.
import { mkdir } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import { defineExtension } from '@jimhoyd/urlcode/extensions';
import type { ScaffoldResult } from '@jimhoyd/urlcode/extensions';
import { auditAuthoring, auditConfigSchema, createAudit, DEFAULT_RETENTION } from './audit.ts';

export { auditConfigSchema };

/** What the operator may pass as `audit({...})` in host.mjs. Every field is optional. */
export interface AuditHostOptions {
  /** Absolute path; default <site>/data/audit.sqlite. Must be outside app/. */
  database?: string;
  /** Best effort, called after a commit that pruned rows past `retention`. Never affects the store. */
  onPruned?: (removed: number) => void;
  /** Best effort, called when a drain round fails (it retries). Default: one line on stderr. */
  onDeliveryError?: (source: string, error: unknown) => void;
}

function inside(parent: string, path: string): boolean {
  const rel = relative(parent, path);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
}

function scaffold(): ScaffoldResult {
  return {
    config: { retention: DEFAULT_RETENTION },
    routes: {},
    notes: [
      'audit keeps the newest 100000 events in data/audit.sqlite (config.retention). It serves no routes: auth records every privileged action into it, and so does each store collection that declares audit: true.',
      'Back it up with `npx urlcode-audit backup` (JSON {"database","destination","projectRoot"} on stdin) after the auth backup, so undrained events travel in the auth backup.',
      "admin's Audit screen reads it. Grant audit.read (view) and audit.export (export) to the roles that may see it.",
    ],
  };
}

export default defineExtension<AuditHostOptions>({
  name: 'audit',
  description: 'Durable, bounded audit log other extensions record privileged actions into',
  schema: auditConfigSchema,
  authoring: auditAuthoring,
  agent: {
    description: 'Local, revision-pinned references for agents configuring or consuming the audit extension.',
    references: [
      { name: 'audit extension guide', description: 'Configuration, the producer contract and the query API.', path: 'README.md' },
      { name: 'audit delivery guarantee', description: 'Atomic capture, at-least-once delivery stored once, fail closed at the backlog cap.', path: 'SECURITY.md' },
    ],
  },
  scaffold,
  async host(ctx, options) {
    const database = options.database ?? join(ctx.site, 'data', 'audit.sqlite');
    if (!isAbsolute(database)) throw new Error('audit({database}) must be an absolute path');
    if (inside(join(ctx.site, 'app'), database)) throw new Error('The audit database must be outside app/');
    if (options.database === undefined) await mkdir(join(ctx.site, 'data'), { recursive: true, mode: 0o700 });
    const onDeliveryError = options.onDeliveryError ?? ((source: string, error: unknown) => {
      process.stderr.write(`audit: delivery from ${source} failed (${error instanceof Error ? error.message.split('\n')[0]!.slice(0, 200) : 'unknown error'}); retrying\n`);
    });
    const audit = await createAudit({ projectSha256: ctx.projectSha256, database, onDeliveryError, ...(options.onPruned ? { onPruned: options.onPruned } : {}) });
    return { registration: audit.registration, exports: audit.exports, close: audit.close };
  },
});
