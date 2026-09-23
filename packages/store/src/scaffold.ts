import type { ScaffoldRequest, ScaffoldResult } from '@jimhoyd/urlcode/extensions';

const accessPublic = `> **Access model: public write.** \`init\` was run with \`--ack store:public-write\`, so anyone who can reach this server can create, change and delete records on \`/api/todos\` (and through the \`ui\` screen if composed) with no sign-in. This is not rate limiting, abuse protection or multi-tenant isolation: the store only bounds record count and size and keeps the origin and CSRF checks. To protect it, add the \`auth\` extension and \`auth: true\` on the mount.`;
const accessAuth = `> **Access model: signed-in callers only.** The mount carries \`auth: true\`; \`auth\` decides who may reach it.`;
const body = `The \`store\` extension serves the \`todos\` collection declared in \`app/urlcode.yaml\` as a JSON CRUD API on \`/api/todos\`: \`GET\` (list, \`?limit=&cursor=\`), \`POST\`, \`GET|PUT|PATCH|DELETE /api/todos/<id>\`. There is no handler code to write. Each record has a server-assigned \`id\`, \`createdAt\` and \`updatedAt\`, and only the fields declared in the YAML; writes need \`Content-Type: application/json\`.

Records live in \`data/store/todos.json\`, outside \`app/\`, written atomically. The file store is bounded (1000 records, 4096 bytes per record by default) and supports one server process per data directory; see the package README for the concurrency limits. Change fields and limits in the YAML, then review and re-pin the project revision. Back up \`data/\` like any operator data.`;
const readme = (withAuth: boolean): string => `## Data store\n\n${withAuth ? accessAuth : accessPublic}\n\n${body}`;

/** Describes the store's contribution to a composed project without writing anything. */
export function scaffold(request: ScaffoldRequest): ScaffoldResult {
  for (const key of ['directory', 'project', 'hostFile'] as const) if (typeof request[key] !== 'string' || !request[key]) throw new Error(`Scaffold request needs an absolute ${key}`);
  const withAuth = request.names.includes('auth');
  const publicWrite = 'store:public-write';
  if (!withAuth && !request.acknowledgements.includes(publicWrite)) throw Object.assign(new Error('store scaffolds POST, PUT, PATCH and DELETE on /api/todos, and nothing in --with protects them, so anyone could write. Add auth to --with (urlcode init --with ui,auth,store), or acknowledge a public writable endpoint if that is really intended (that is not rate limiting, abuse protection or multi-tenant isolation)'), { acknowledgement: publicWrite });
  return {
    name: 'store',
    ...(withAuth ? {} : { acknowledged: [publicWrite], routeNotes: ['ACCESS MODEL: public write (--ack store:public-write). Anyone can create, change and delete records here. Not rate limiting, abuse protection or multi-tenant isolation.'] }),
    // Self-contained host bindings: the pin is read under the store's own identifier, so no other extension has to define it first.
    provides: ['store.collections'],
    // Not required: it keeps the historical order (presentation before data) when ui is composed too.
    after: ['ui.kit'],
    extensions: { store: { version: '1', config: { collections: { todos: {
      mount: '/api/todos',
      fields: { title: { type: 'string', required: true, minLength: 1, maxLength: 200 }, done: { type: 'boolean', default: false } },
      maxRecords: 1000, maxRecordBytes: 4096,
    } } } } },
    routes: { '/api/todos/*': { extension: 'store', methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'], ...(withAuth ? { auth: true } : {}) } },
    hostImports: ["import {fileURLToPath} from 'node:url';"],
    hostBundleExports: ['storeExtension'],
    hostSetup: [
      'const storeProjectSha256 = process.env.PROJECT_SHA256;',
      "if (!storeProjectSha256 || !/^[a-f0-9]{64}$/.test(storeProjectSha256)) throw new Error('Set the reviewed PROJECT_SHA256 revision');",
      "const storeDirectory = process.env.STORE_DIRECTORY ?? fileURLToPath(new URL('./data/store', import.meta.url));",
    ],
    hostEntries: ['storeExtension({directory: storeDirectory, projectSha256: storeProjectSha256})'],
    files: [],
    readme: readme(withAuth),
    nextSteps: ['Start with `PROJECT_SHA256=<revision> npx urlcode serve --project app --host-file "$PWD/host.mjs" --origin <origin>`, then `curl -X POST -H "Content-Type: application/json" -d \'{"title":"first"}\' <origin>/api/todos`.'],
    env: { PROJECT_SHA256: 'Reviewed project revision from inspectExtensionRevision; re-review after any project change.', STORE_DIRECTORY: 'Optional absolute directory for collection files (default data/store beside host.mjs); must be outside app/.' },
  };
}
