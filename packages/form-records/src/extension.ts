/**
 * The `form-records` extension definition: what `urlcode extensions add form-records` scaffolds and what host.mjs
 * activates through `composeHost`. Published as the package's `./extension` entry.
 */
import { defineExtension } from '@jimhoyd/urlcode/extensions';
import type { ScaffoldRequest, ScaffoldResult } from '@jimhoyd/urlcode/extensions';
import type { FormsExports } from '@jimhoyd/urlcode-forms';
import type { StoreExports } from '@jimhoyd/urlcode-store';
import type { UiExtension } from '@jimhoyd/urlcode-ui/host';
import { createFormRecordsExtension, formRecordsAuthoring, formRecordsConfigSchema } from './form-records.ts';

/** form-records takes no operator options: forms and store supply everything it uses. */
export type FormRecordsHostOptions = Record<string, never>;

/** Path of the example record flow. */
const exampleMount = '/todo-form';

/** The capability: an empty `records` block and nothing mounted. */
function scaffold(): ScaffoldResult {
  return {
    config: { records: {} },
    routes: {},
    notes: [
      'form-records is installed with no record flows: declare one under extensions.form-records.config.records (a form, an ownership: owner store collection, editable fields) and mount it with a route <mount>/* using extension: form-records, methods GET, HEAD and POST, and auth: true. See the @jimhoyd/urlcode-form-records README.',
    ],
  };
}

/**
 * `--example`: a signed-in "new todo" form on /todo-form that saves into the store example's `todos` collection,
 * shows the saved todo, and lets its owner tick `done` (the title is read-only after create). Records are private
 * to their creator, so the example needs auth. It names the store example's collection rather than declaring one:
 * form-records writes only its own configuration block.
 */
function example(request: ScaffoldRequest): ScaffoldResult {
  if (!request.installed.includes('auth')) throw new Error('the form-records example keeps each record private to the signed-in user who created it, so it needs auth: add auth first (urlcode extensions add auth), or add it in the same command (urlcode extensions add auth form-records --example)');
  return {
    config: { records: { todo: {
      mount: exampleMount, collection: 'todos',
      form: {
        title: 'New todo', submitLabel: 'Save todo',
        confirmation: { title: 'Todo saved', message: 'Saved {title}.', show: ['title', 'done'] },
        fields: { title: { label: 'Title', maxLength: 200 }, done: { label: 'Done', control: 'checkbox', required: false } },
      },
      editable: ['done'], editTitle: 'Update todo',
    } } },
    routes: { [`${exampleMount}/*`]: { extension: 'form-records', methods: ['GET', 'HEAD', 'POST'], auth: true } },
    notes: [
      `Open ${exampleMount} signed in: the form saves a todo into the store's todos collection, ${exampleMount}/<id> shows it and ${exampleMount}/<id>/edit changes only done. Each user sees only their own todos.`,
      'The example uses the todos collection (ownership: owner) that the store example declares when store is added with --example and auth installed. If store was already installed, declare that collection under extensions.store.config.collections yourself, with its /api/todos/* route and auth: true (see docs/STORE.md).',
    ],
  };
}

export default defineExtension<FormRecordsHostOptions>({
  name: 'form-records',
  description: 'Saves a declared form into an owned store collection, with a confirmation page and an edit page limited to declared fields.',
  requires: ['forms', 'store', 'ui'],
  schema: formRecordsConfigSchema,
  authoring: formRecordsAuthoring,
  agent: { description: 'Local, revision-pinned references for agents configuring the form-records extension.', references: [{ name: 'form-records extension guide', description: 'Configuration and composition guidance for saving a form into an owned store collection.', path: 'README.md' }] },
  scaffold,
  example,
  host(context) {
    // The typed, versioned exports of what this extension requires; never their configuration. ui renders the optional list page.
    return { registration: createFormRecordsExtension({ projectSha256: context.projectSha256, forms: context.get<FormsExports>('forms'), store: context.get<StoreExports>('store'), ui: context.get<UiExtension>('ui') }) };
  },
});
