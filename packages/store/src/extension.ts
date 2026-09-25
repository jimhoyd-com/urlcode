import { join } from 'node:path';
import { defineExtension } from '@jimhoyd/urlcode/extensions';
import type { ScaffoldRequest, ScaffoldResult } from '@jimhoyd/urlcode/extensions';
import { createStore, storeAuthoring, storeConfigSchema } from './store.ts';
import { contributedScreens } from './screens.ts';

/** Operator choices for the store in host.mjs. Every field is optional. */
export interface StoreHostOptions {
  /** Absolute directory for collection files. Defaults to `STORE_DIRECTORY`, then `data/store` beside host.mjs; it must be outside `app/`. */
  directory?: string;
}

const publicWrite = 'store:public-write';
/** Path of the example list and form screen, added when ui is installed. */
const todosScreen = '/todos';

/**
 * The capability: an empty `collections` block and nothing mounted. The store adds no endpoint until the project
 * declares a collection and its `extension: store` route, so a blank install writes nothing anyone can reach.
 */
function scaffold(): ScaffoldResult {
  return {
    config: { collections: {} },
    routes: {},
    env: { STORE_DIRECTORY: 'Optional absolute directory for collection files (default data/store beside host.mjs); must be outside app/.' },
    notes: [
      'store is installed with no collections: declare one under extensions.store.config.collections and mount it with a route <mount>/* using extension: store (add auth: true to protect writes). See docs/STORE.md.',
      'For a working demo, add the store to a fresh site with --example: a todos collection on /api/todos (and a /todos screen when ui is installed).',
    ],
  };
}

/**
 * `--example`: a `todos` collection on `/api/todos`. When auth is installed (added in the same command or already
 * present) the mount carries `auth: true` and the collection is per-user (`ownership: owner`, #331): each signed-in
 * user sees and changes only their own todos. Without auth it stays a shared collection and needs
 * `--ack store:public-write`. When ui is installed too, the store also declares its `/todos` screen
 * and the `extension: ui` route that serves it: the screen integration belongs to the store, not to ui.
 */
function example(request: ScaffoldRequest): ScaffoldResult {
  const withAuth = request.installed.includes('auth'), withUi = request.installed.includes('ui');
  if (!withAuth && !request.acknowledgements.includes(publicWrite)) throw Object.assign(new Error('the store example serves POST, PUT, PATCH and DELETE on /api/todos, and no installed extension protects them, so anyone could write. Add auth first (urlcode extensions add auth), or acknowledge a public writable endpoint if that is really intended (that is not rate limiting, abuse protection or multi-tenant isolation)'), { acknowledgement: publicWrite });
  return {
    config: { collections: { todos: {
      mount: '/api/todos',
      fields: { title: { type: 'string', required: true, minLength: 1, maxLength: 200 }, done: { type: 'boolean', default: false } },
      maxRecords: 1000, maxRecordBytes: 4096,
      ...(withAuth ? { ownership: 'owner' } : {}),
    } }, ...(withUi ? { screens: { [todosScreen]: { collection: 'todos', title: 'Todos' } } } : {}) },
    routes: {
      '/api/todos/*': { extension: 'store', methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'], ...(withAuth ? { auth: true } : {}) },
      // The store's screen is served by ui's kit; the store contributes its description (contributes.ui.screens).
      ...(withUi ? { [`${todosScreen}/*`]: { extension: 'ui', methods: ['GET', 'HEAD'], ...(withAuth ? { auth: true } : {}) } } : {}),
    },
    ...(withAuth ? {} : { acknowledged: [publicWrite], routeNotes: ['ACCESS MODEL: public write (--ack store:public-write). Anyone can create, change and delete records here. Not rate limiting, abuse protection or multi-tenant isolation.'] }),
    notes: [
      withAuth ? 'store serves /api/todos to signed-in callers only (auth: true on the mount), and each user sees and changes only their own todos (ownership: owner).' : 'store serves /api/todos with public write: anyone who can reach the server can change records. Add auth and `auth: true` on the mount to protect it.',
      'Records live in data/store/todos.json, outside app/; back up data/ like any operator data. Try it: curl -X POST -H "Content-Type: application/json" -d \'{"title":"first"}\' <origin>/api/todos',
      ...(withUi ? [`Open ${todosScreen}: a list and form for the todos collection, declared in extensions.store.config.screens and rendered by ui.${withAuth ? ' It shows each signed-in user only their own todos.' : ' Everyone who can reach it sees and edits every todo.'}`] : []),
    ],
  };
}

export default defineExtension<StoreHostOptions>({
  name: 'store',
  description: 'File-backed JSON collections served as a bounded CRUD API, declared in YAML with no handler code',
  requires: [],
  schema: storeConfigSchema,
  // Optional: ui serves the screens the project declares under extensions.store.config.screens. The store does not
  // require ui; without it the contribution is simply never read.
  contributes: { ui: { screens: contributedScreens } },
  authoring: storeAuthoring,
  agent: {description: 'Local, revision-pinned references for agents configuring the store extension.', references: [{name: 'store extension guide', description: 'Configuration and data-model guidance for the store extension.', path: 'README.md'}]},
  scaffold,
  example,
  host(context, options) {
    const directory = options.directory ?? process.env.STORE_DIRECTORY ?? join(context.site, 'data', 'store');
    // `exports` is the StoreExports records API (version 1) an extension that requires store reads with ctx.get('store').
    return createStore({ directory, projectSha256: context.projectSha256 });
  },
});
