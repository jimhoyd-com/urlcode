import type { ScaffoldRequest, ScaffoldResult } from '@jimhoyd/urlcode/extensions';

const readme = `## Data store

The \`store\` extension serves the \`todos\` collection declared in \`app/urlcode.yaml\` as a JSON CRUD API on \`/api/todos\`: \`GET\` (list, \`?limit=&cursor=\`), \`POST\`, \`GET|PUT|PATCH|DELETE /api/todos/<id>\`. There is no handler code to write. Each record has a server-assigned \`id\`, \`createdAt\` and \`updatedAt\`, and only the fields declared in the YAML; writes need \`Content-Type: application/json\`.

Records live in \`data/store/todos.json\`, outside \`app/\`, written atomically. The file store is bounded (1000 records, 4096 bytes per record by default) and supports one server process per data directory; see the package README for the concurrency limits. Change fields and limits in the YAML, then review and re-pin the project revision. Back up \`data/\` like any operator data.`;

/** Describes the store's contribution to a composed project without writing anything. */
export function scaffold(request: ScaffoldRequest): ScaffoldResult {
  for (const key of ['directory', 'project', 'hostFile'] as const) if (typeof request[key] !== 'string' || !request[key]) throw new Error(`Scaffold request needs an absolute ${key}`);
  const withAuth = request.names.includes('auth');
  return {
    name: 'store',
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
    hostImports: ["import {fileURLToPath} from 'node:url';", "import {storeExtension} from '@jimhoyd/urlcode-store';"],
    hostSetup: [
      'const storeProjectSha256 = process.env.PROJECT_SHA256;',
      "if (!storeProjectSha256 || !/^[a-f0-9]{64}$/.test(storeProjectSha256)) throw new Error('Set the reviewed PROJECT_SHA256 revision');",
      "const storeDirectory = process.env.STORE_DIRECTORY ?? fileURLToPath(new URL('./data/store', import.meta.url));",
    ],
    hostEntries: ['storeExtension({directory: storeDirectory, projectSha256: storeProjectSha256})'],
    files: [],
    readme,
    nextSteps: ['Start with `PROJECT_SHA256=<revision> npx urlcode serve --project app --host-file "$PWD/host.mjs" --origin <origin>`, then `curl -X POST -H "Content-Type: application/json" -d \'{"title":"first"}\' <origin>/api/todos`.'],
    env: { PROJECT_SHA256: 'Reviewed project revision from inspectExtensionRevision; re-review after any project change.', STORE_DIRECTORY: 'Optional absolute directory for collection files (default data/store beside host.mjs); must be outside app/.' },
  };
}
