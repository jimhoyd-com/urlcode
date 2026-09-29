import { join } from 'node:path';
import { defineExtension } from '@jimhoyd/urlcode/extensions';
import type { ScaffoldRequest, ScaffoldResult } from '@jimhoyd/urlcode/extensions';
import type { AuditExports } from '@jimhoyd/urlcode-audit';
import { createStore, storeConfigSchema } from './store.ts';
import { storeAuthoring } from './authoring.ts';

/** Operator choices for the store in host.mjs. Every field is optional. */
export interface StoreHostOptions {
  /**
   * Absolute path of the store's SQLite database. Defaults to `STORE_DATABASE`, then `data/store.sqlite` beside host.mjs;
   * it must be outside `app/`. A hermetic run ignores both and uses a fresh database (RIM-EXT-HERMETIC-001).
   */
  database?: string;
  /**
   * How much each commit waits for the disk: `full` (default, SQLite `synchronous=FULL`, a committed write survives
   * power loss) or `normal` (`synchronous=NORMAL`: faster commits, but the last ones before a power loss or OS crash can
   * be lost; a process crash loses nothing). Defaults to `STORE_DURABILITY`, then `full`; anything else is refused. The
   * `urlcode-store` operator commands always commit with `full`. See docs/STORE.md, durability.
   */
  durability?: 'full' | 'normal';
}

const publicWrite = 'store:public-write';

/**
 * The capability: an empty `collections` block and nothing mounted. The store adds no endpoint until the project
 * declares a collection and its `extension: store` route, so a blank install writes nothing anyone can reach.
 */
function scaffold(): ScaffoldResult {
  return {
    config: { collections: {} },
    routes: {},
    env: { STORE_DATABASE: 'Optional absolute path of the store\'s SQLite database (default data/store.sqlite beside host.mjs); must be outside app/.', STORE_DURABILITY: 'Optional commit durability: full (default; survives power loss) or normal (faster; the last commits can be lost on power loss). See durability in the store README, node_modules/@jimhoyd/urlcode-store/README.md.' },
    notes: [
      'store is installed with no collections: declare one under extensions.store.config.collections and mount it with a route <mount>/* using extension: store (add auth: true to protect writes). The guide is the store README, node_modules/@jimhoyd/urlcode-store/README.md; urlcode docs search "<term>" --project <app> searches it.',
      'For a working demo, add the store to a fresh site with --example: a todos collection on /api/todos.',
    ],
  };
}

/**
 * `--example`: a `todos` collection on `/api/todos`. When auth is installed (added in the same command or already
 * present) the mount carries `auth: true` and the collection is per-user (`ownership: owner`, #331): each
 * signed-in user sees and changes only their own todos. auth admits writes with Better Auth's session cookie and
 * same-origin provenance. Without auth it stays a
 * shared collection and needs `--ack store:public-write`. When audit is installed, every write to the collection is
 * recorded in the audit log (`audit: true`). The example is API only: a frontend calls the JSON mount.
 */
function example(request: ScaffoldRequest): ScaffoldResult {
  const withAuth = request.installed.includes('auth'), withAudit = request.installed.includes('audit');
  if (!withAuth && !request.acknowledgements.includes(publicWrite)) throw Object.assign(new Error('the store example serves POST, PUT, PATCH and DELETE on /api/todos, and no installed extension protects them, so anyone could write. Add auth first (urlcode extensions add auth), or acknowledge a public writable endpoint if that is really intended (that is not rate limiting, abuse protection or multi-tenant isolation)'), { acknowledgement: publicWrite });
  return {
    config: { collections: { todos: {
      mount: '/api/todos',
      schema: {
        type: 'object', additionalProperties: false, required: ['title'],
        properties: { title: { type: 'string', minLength: 1, maxLength: 200 }, done: { type: 'boolean' } },
      }, defaults: { done: false },
      maxRecords: 1000, maxRecordBytes: 4096,
      ...(withAuth ? { ownership: 'owner' } : {}),
      ...(withAudit ? { audit: true } : {}),
    } } },
    routes: {
      '/api/todos/*': { extension: 'store', methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'], ...(withAuth ? { auth: true } : {}) },
    },
    ...(withAuth ? {} : { acknowledged: [publicWrite], routeNotes: ['ACCESS MODEL: public write (--ack store:public-write). Anyone can create, change and delete records here. Not rate limiting, abuse protection or multi-tenant isolation.'] }),
    notes: [
      withAuth ? 'store serves /api/todos to signed-in callers only (auth: true on the mount: writes are admitted with the session cookie and same-origin provenance), and each user sees and changes only their own todos (ownership: owner).' : 'store serves /api/todos with public write: anyone who can reach the server can change records. Add auth and `auth: true` on the mount to protect it.',
      'Records live in the SQLite database data/store.sqlite, outside app/; back up data/ like any operator data (urlcode-store backup; see the store README, node_modules/@jimhoyd/urlcode-store/README.md). Try it: curl -X POST -H "Content-Type: application/json" -d \'{"title":"first"}\' <origin>/api/todos',
      ...(withAudit ? ['Every create, change and delete on the todos collection is recorded in the audit log (audit: true): field names and the signed-in user, never values. When the audit log falls 1000 events behind, writes answer 503 until it catches up.'] : []),
    ],
  };
}

export default defineExtension<StoreHostOptions>({
  name: 'store',
  targets: ['node'],
  description: 'SQLite-backed collections served as a bounded CRUD API, declared in YAML with no handler code',
  contract: 1,
  requires: [],
  // Optional: a collection that declares `audit: true` records its writes through the audit extension, and refuses
  // to activate when audit is not installed. Without such a collection the store never touches audit.
  uses: ['audit'],
  schema: storeConfigSchema,
  authoring: storeAuthoring,
  agent: {description: 'Local, revision-pinned references for agents configuring the store extension.', references: [{name: 'store extension guide', description: 'Configuration and data-model guidance for the store extension; ends with the generated field reference for every configuration key.', path: 'README.md'}]},
  scaffold,
  example,
  host(context, options) {
    // A hermetic run (test, audit, benchmark) uses a fresh database in the run's data directory, never the site's, and
    // accepts the project's test seed (memberships).
    const database = context.hermetic ? join(context.data, 'store.sqlite') : options.database ?? process.env.STORE_DATABASE ?? join(context.data, 'store.sqlite');
    // `exports` is the StoreExports records API (version 1) an extension that requires store reads with ctx.get('store').
    // With audit installed the store attaches as its `store` producer here; the host's close detaches it.
    const durability = (options.durability ?? process.env.STORE_DURABILITY) as StoreHostOptions['durability'];
    return createStore({ database, durability, projectSha256: context.projectSha256, audit: context.get<AuditExports | undefined>('audit'), hermetic: context.hermetic });
  },
});
