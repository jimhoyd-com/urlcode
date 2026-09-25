/**
 * form-records (#529): a validated forms submission becomes a record in an owned store collection, with a
 * confirmation page that reads the saved record back and an edit page that changes only declared fields.
 *
 * It owns the composition and nothing else. It never reads `extensions.forms.config` or
 * `extensions.store.config`: it reaches forms and store only through their typed exports (`FormsExports`,
 * `StoreExports`, contract version 1), which keep rendering, CSRF, admission and field validation in forms, and
 * ownership, record validation, limits and ETags in the store.
 */
import type { ExtensionAuthoringContract, ExtensionInstance, ExtensionRequest, HandlerResult, RuntimeExtension } from '@jimhoyd/urlcode/extensions';
import { formFlowBodySchema } from '@jimhoyd/urlcode-forms';
import type { FormFieldSpec, FormFlowBody, FormsExports, FormsFlow } from '@jimhoyd/urlcode-forms';
import type { FieldSpec, Scalar, StoreExports, StoreRecords, StoredRecord } from '@jimhoyd/urlcode-store';
import { emptyState, escapeHtml, markup, pagination } from '@jimhoyd/urlcode-ui';
import type { UiExtension } from '@jimhoyd/urlcode-ui/host';

/** Records per list page; the collection's own `pageSize` caps it further. */
const LIST_PAGE = 20;
const NAME = /^[a-z][a-z0-9-]{0,63}$/, FIELD = /^[a-z][A-Za-z0-9_]{0,63}$/, UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** One declared record flow: `extensions.form-records.config.records.<name>`. */
export interface FormRecordSpec {
  /** Where this extension serves the form, the record's confirmation and its edit page (route `<mount>/*`). */
  mount: string;
  /** A store collection declared with `ownership: owner`. */
  collection: string;
  /** The form, in the forms flow shape without a mount (`formFlowBodySchema`); forms validates it. */
  form: FormFlowBody;
  /** Form field to collection field. Default: each form field to the collection field of the same name. */
  fields?: Record<string, string>;
  /** Form fields the edit page may change. Every other field is read-only after create. Default: none (no edit page). */
  editable?: string[];
  /** The edit page's title. Default: the form's title. */
  editTitle?: string;
  /** A page at `<mount>/` listing the signed-in user's own records. Default: none (no list page). */
  list?: FormRecordListSpec;
}
/** The per-user list page (#738): which form fields to show as columns, in order, and its title. */
export interface FormRecordListSpec {
  /** The page title. Default: `Your records`. */
  title?: string;
  /** Form fields shown as columns, in this order. */
  columns: string[];
}
interface FormRecordsConfig { records: Record<string, FormRecordSpec> }
export interface FormRecordsExtensionOptions {
  /** Exact project revision the operator reviewed. */
  projectSha256: string;
  /** What `ctx.get('forms')` returned: forms' export contract, version 1. */
  forms: FormsExports;
  /** What `ctx.get('store')` returned: the store's export contract, version 1. */
  store: StoreExports;
  /** What `ctx.get('ui')` returned. Needed only by a record flow that declares a `list` page, which it renders. */
  ui?: UiExtension;
}

const stringSchema = { type: 'string', minLength: 1, maxLength: 512 };
export const formRecordsConfigSchema = {
  type: 'object', additionalProperties: false, required: ['records'],
  properties: {
    records: {
      type: 'object', maxProperties: 16, propertyNames: { pattern: NAME.source },
      additionalProperties: {
        type: 'object', additionalProperties: false, required: ['mount', 'collection', 'form'],
        properties: {
          mount: { type: 'string', pattern: '^/[A-Za-z0-9._~-]+(?:/[A-Za-z0-9._~-]+)*$', maxLength: 128 },
          collection: { type: 'string', pattern: '^[a-z][a-z0-9_-]{0,63}$' },
          form: formFlowBodySchema,
          fields: { type: 'object', maxProperties: 32, propertyNames: { pattern: FIELD.source }, additionalProperties: { type: 'string', pattern: FIELD.source } },
          editable: { type: 'array', maxItems: 32, uniqueItems: true, items: { type: 'string', pattern: FIELD.source } },
          editTitle: stringSchema,
          list: {
            type: 'object', additionalProperties: false, required: ['columns'],
            properties: {
              title: stringSchema,
              columns: { type: 'array', minItems: 1, maxItems: 8, uniqueItems: true, items: { type: 'string', pattern: FIELD.source } },
            },
          },
        },
      },
    },
  },
} as const;

export const formRecordsAuthoring: ExtensionAuthoringContract = {
  description: 'Save a declared form into an owned store collection: a submission creates a record private to its signed-in creator, the confirmation page reads the saved record back, and an edit page changes only the fields listed in `editable`. forms keeps rendering, CSRF and validation; the store keeps ownership, limits and ETags. No handler code.',
  surfaces: [
    { kind: 'configuration', name: 'records', description: 'Each record flow: `mount`, the owned store `collection`, the `form` (a forms flow without a mount: title, submitLabel, confirmation with `show`, fields), the optional `fields` map from form field to collection field, `editable` form fields, `editTitle` and an optional `list` page (`title`, `columns` of form fields).', path: 'urlcode.yaml#extensions.form-records.config.records' },
    { kind: 'extension', name: 'mount', description: 'Mount each record flow as `<mount>/*` with GET, HEAD and POST and a principal-providing policy such as `auth: {csrf: origin}` (forms verifies its own CSRF token, which a plain HTML form posts in the body). It serves `<mount>` (new record), `<mount>/<id>` (confirmation), `<mount>/<id>/edit` and, with `list`, `<mount>/` (the caller\'s own records).', path: 'urlcode.yaml' },
  ],
  fastChecks: ['urlcode validate --project . --host-file <host.mjs> --origin <origin>', 'urlcode test --project . --host-file <host.mjs> --origin <origin>'],
};

function text(status: number, body: string, extra: [string, string][] = []): HandlerResult {
  return { status, headers: [['content-type', 'text/plain; charset=utf-8'], ...extra], body };
}
const headOnly = (method: string, result: HandlerResult): HandlerResult => method === 'HEAD' ? { ...result, body: undefined } : result;
/** The error a store failure carries (a `StoreError`, matched by shape so a second copy of the store package still counts). */
function storeFailure(error: unknown): { status: number; code: string; message: string; fields?: Record<string, string> } | undefined {
  if (!(error instanceof Error) || !('status' in error) || !('code' in error) || typeof error.status !== 'number' || typeof error.code !== 'string') return undefined;
  const fields = 'fields' in error && error.fields && typeof error.fields === 'object' ? error.fields as Record<string, string> : undefined;
  return { status: error.status, code: error.code, message: error.message, ...(fields ? { fields } : {}) };
}

/** Which collection field type a form field can feed, by its control and input type. */
function storedType(spec: Readonly<FormFieldSpec>): 'boolean' | 'number' | 'string' {
  if (spec.control === 'checkbox') return 'boolean';
  if ((spec.control ?? 'input') === 'input' && spec.type === 'number') return 'number';
  return 'string';
}
function compatible(form: Readonly<FormFieldSpec>, stored: Readonly<FieldSpec>): boolean {
  const kind = storedType(form);
  return kind === 'boolean' ? stored.type === 'boolean' : kind === 'number' ? stored.type === 'integer' || stored.type === 'number' : stored.type === 'string';
}
/**
 * A form string as the collection's value. `undefined` leaves the field out (an empty input on create); `null` clears
 * it (an empty input on edit, which the store refuses with a field error when the collection field is required);
 * `{error}` is a field error.
 */
function toStored(stored: Readonly<FieldSpec>, value: string, editing: boolean): Scalar | null | undefined | { error: string } {
  if (stored.type === 'boolean') return value === 'true';
  if (value === '') return editing ? null : undefined;
  if (stored.type === 'string') return value;
  const number = Number(value);
  if (!Number.isFinite(number)) return { error: 'must be a number' };
  if (stored.type === 'integer' && !Number.isSafeInteger(number)) return { error: 'must be a whole number' };
  return number;
}
function toForm(value: Scalar | undefined): string {
  if (value === undefined) return '';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return String(value);
}

interface Binding {
  name: string; mount: string; flow: FormsFlow; edit: FormsFlow | undefined; editTitle: string | undefined;
  records: StoreRecords; map: Readonly<Record<string, string>>; formFields: string[];
  /** `newLabel` links the list to the new-record form: the form's title. */
  list: { title: string; columns: readonly string[]; newLabel: string; ui: UiExtension } | undefined;
}
/** Checks one record flow against the exported forms and store contracts. Every problem refuses activation. */
function bind(name: string, spec: FormRecordSpec, options: FormRecordsExtensionOptions): Binding {
  if (!NAME.test(name)) throw new Error(`Invalid record flow name: ${name}`);
  let flow: FormsFlow;
  try { flow = options.forms.define(name, spec.form); } catch (error) { throw new Error(`Record ${name}: ${(error as Error).message}`, { cause: error }); }
  let records: StoreRecords;
  try { records = options.store.records(spec.collection); } catch (error) { throw new Error(`Record ${name}: ${(error as Error).message}`, { cause: error }); }
  if (records.ownership !== 'owner') throw new Error(`Record ${name}: collection ${spec.collection} must be declared with ownership: owner; form-records refuses a shared collection so every record stays private to the signed-in user who created it`);
  if (records.readOnly) throw new Error(`Record ${name}: collection ${spec.collection} is readOnly`);
  const formFields = Object.keys(flow.declared);
  const map = spec.fields ?? Object.fromEntries(formFields.map(field => [field, field]));
  for (const field of formFields) if (!Object.hasOwn(map, field)) throw new Error(`Record ${name}: form field ${field} is not mapped to a collection field under fields`);
  const targets = new Set<string>();
  for (const [field, target] of Object.entries(map)) {
    if (!Object.hasOwn(flow.declared, field)) throw new Error(`Record ${name}: fields maps ${field}, which the form does not declare`);
    const stored = Object.hasOwn(records.fields, target) ? records.fields[target] : undefined;
    if (!stored) throw new Error(`Record ${name}: fields maps ${field} to ${target}, which collection ${spec.collection} does not declare`);
    if (targets.has(target)) throw new Error(`Record ${name}: fields maps two form fields to ${target}`);
    targets.add(target);
    if (!compatible(flow.declared[field]!, stored)) throw new Error(`Record ${name}: form field ${field} (${storedType(flow.declared[field]!)}) cannot fill ${stored.type} field ${target}; a checkbox fills a boolean, a type: number input an integer or number, and every other control a string`);
  }
  for (const [target, stored] of Object.entries(records.fields)) if (stored.required && stored.default === undefined && !targets.has(target)) throw new Error(`Record ${name}: collection field ${target} is required, so a form field must be mapped to it`);
  const editable = spec.editable ?? [];
  for (const field of editable) if (!Object.hasOwn(flow.declared, field)) throw new Error(`Record ${name}: editable lists ${field}, which the form does not declare`);
  let edit: FormsFlow | undefined;
  try { edit = editable.length ? flow.only(editable) : undefined; } catch (error) { throw new Error(`Record ${name}: editable: ${(error as Error).message}`, { cause: error }); }
  let list: Binding['list'];
  if (spec.list) {
    const columns = spec.list.columns;
    if (!Array.isArray(columns) || !columns.length) throw new Error(`Record ${name}: list needs at least one column`);
    if (new Set(columns).size !== columns.length) throw new Error(`Record ${name}: list lists a column twice`);
    for (const column of columns) if (!Object.hasOwn(flow.declared, column)) throw new Error(`Record ${name}: list column ${String(column).slice(0, 64)} is not a form field; columns name form fields, each shown from the collection field it is mapped to`);
    if (!options.ui) throw new Error(`Record ${name}: a list page needs the ui export; pass ui to createFormRecordsExtension`);
    list = { title: spec.list.title ?? 'Your records', columns: Object.freeze([...columns]), newLabel: spec.form.title, ui: options.ui };
  }
  return { name, mount: spec.mount, flow, edit, editTitle: spec.editTitle, records, map: Object.freeze({ ...map }), formFields, list };
}

/** Creates the form-records registration from the forms and store exports `host()` received. */
export function createFormRecordsExtension(options: FormRecordsExtensionOptions): RuntimeExtension {
  if (!/^[a-f0-9]{64}$/.test(options.projectSha256)) throw new Error('form-records extension requires an explicit operator revision pin');
  if (options.forms?.version !== 1) throw new Error('form-records needs the forms export contract version 1; install the forms release that matches this one');
  if (options.store?.version !== 1) throw new Error('form-records needs the store export contract version 1; install the store release that matches this one');
  return {
    name: 'form-records', version: '1', projectSha256: options.projectSha256,
    // The store is Node-only (a single-writer file directory), so the composition is too.
    targets: ['node'],
    schema: formRecordsConfigSchema, authoring: formRecordsAuthoring,
    activate(raw, context): ExtensionInstance {
      if (!options.forms.active || !options.store.active) throw new Error('form-records needs forms and store active first: the host must register both before form-records (composeHost does)');
      if (options.ui && !options.ui.active) throw new Error('form-records needs ui active first: the host must register ui before form-records (composeHost does)');
      const config = raw as unknown as FormRecordsConfig;
      const byMount = new Map<string, Binding>();
      for (const [name, spec] of Object.entries(config.records)) {
        const binding = bind(name, spec, options);
        if (byMount.has(spec.mount)) throw new Error(`Records ${byMount.get(spec.mount)!.name} and ${name} share mount ${spec.mount}`);
        if (!context.mounts.includes(spec.mount)) throw new Error(`Record ${name}: route ${spec.mount}/* with extension: form-records is not declared`);
        // Fail closed at startup: a record is private to its creator, so the mount must be able to carry a principal.
        if (!(context.principalMounts ?? []).includes(spec.mount)) throw new Error(`Record ${name}: route ${spec.mount}/* needs a principal-providing policy (for example auth: {csrf: origin}), because each record belongs to the signed-in user who created it`);
        byMount.set(spec.mount, binding);
      }
      for (const mount of context.mounts) if (!byMount.has(mount)) throw new Error(`form-records mount ${mount} has no declared record flow`);
      return { handle: request => handle(byMount, request) };
    },
  };
}

/** Drops trailing slashes in one linear pass; a regex like `/\/+$/` backtracks quadratically on long runs of slashes in a request path. */
function trimTrailingSlashes(path: string): string {
  let end = path.length;
  while (end > 0 && path.charCodeAt(end - 1) === 47) end--;
  return path.slice(0, end);
}

async function handle(byMount: ReadonlyMap<string, Binding>, request: ExtensionRequest): Promise<HandlerResult> {
  const binding = request.mount === null ? undefined : byMount.get(request.mount);
  if (!binding) return text(404, 'Not found');
  // A record flow never answers without a principal: never a fallback to a shared view.
  const principal = request.principal ?? null;
  if (principal === null) return text(401, 'Sign in to use this form');
  const suffix = trimTrailingSlashes(request.path.slice(binding.mount.length));
  const method = request.method.toUpperCase();
  try {
    // With a list page, exactly `<mount>/` lists the caller's records; `<mount>` stays the new-record form.
    if (binding.list && request.path === `${binding.mount}/` && (method === 'GET' || method === 'HEAD')) return listPage(binding, request, method);
    if (suffix === '') return await create(binding, request, method);
    const match = /^\/([0-9a-f-]{36})(\/edit)?$/.exec(suffix);
    if (!match || !UUID.test(match[1]!)) return text(404, 'Not found');
    return match[2] ? await edit(binding, request, method, match[1]!) : show(binding, request, method, match[1]!);
  } catch (error) {
    const failure = storeFailure(error);
    if (failure?.status === 404) return text(404, 'Not found');
    if (failure?.status === 401) return text(401, 'Sign in to use this form');
    return text(500, 'The form could not be handled'); // never echo the cause
  }
}

/** The record's value for every form field, as form strings. */
function formValues(binding: Binding, record: Readonly<StoredRecord>, names: readonly string[]): Record<string, string> {
  return Object.fromEntries(names.map(field => [field, toForm(record[binding.map[field]!])]));
}
/** Converts admitted form values for the collection; errors are keyed by form field. A `null` value (edit only) clears the field. */
function convert(binding: Binding, values: Readonly<Record<string, string>>, editing: boolean): { values: Record<string, Scalar | null>; errors: Record<string, string> } {
  const out: Record<string, Scalar | null> = {}, errors: Record<string, string> = {};
  for (const [field, value] of Object.entries(values)) {
    const target = binding.map[field]!, converted = toStored(binding.records.fields[target]!, value, editing);
    if (converted !== null && typeof converted === 'object') errors[field] = converted.error;
    else if (converted !== undefined) out[target] = converted;
  }
  return { values: out, errors };
}
/** A store refusal as page feedback: field errors keyed back to form fields, or one page-level message. */
function feedback(binding: Binding, error: unknown): { status: number; errors: Record<string, string>; alert?: string } | undefined {
  const failure = storeFailure(error);
  if (!failure || failure.status === 404 || failure.status === 401 || failure.status === 412) return undefined;
  const back = new Map(Object.entries(binding.map).map(([field, target]) => [target, field]));
  const errors: Record<string, string> = {}, stray: string[] = [];
  for (const [target, message] of Object.entries(failure.fields ?? {})) { const field = back.get(target); if (field) errors[field] = message; else stray.push(target); }
  if (failure.status === 400 && Object.keys(errors).length && !stray.length) return { status: 422, errors };
  return { status: failure.status === 400 ? 422 : failure.status, errors, alert: failure.status === 503 ? 'The record could not be saved right now. Try again.' : `The record could not be saved: ${failure.message}` };
}

async function create(binding: Binding, request: ExtensionRequest, method: string): Promise<HandlerResult> {
  const page = { action: binding.mount, scope: `form-records:${binding.name}:create` };
  if (method === 'GET' || method === 'HEAD') return headOnly(method, binding.flow.render(request, page));
  if (method !== 'POST') return text(405, 'Method not allowed', [['allow', 'GET, HEAD, POST']]);
  const submitted = binding.flow.submit(request, page);
  if (!submitted.ok) return submitted.response;
  const { values, errors } = convert(binding, submitted.values, false);
  if (Object.keys(errors).length) return binding.flow.render(request, { ...page, values: submitted.values, errors, status: 422 });
  try {
    // On create an empty input is left out (never null), so every value here is a scalar.
    const saved = await binding.records.create(request.principal, Object.fromEntries(Object.entries(values).filter((entry): entry is [string, Scalar] => entry[1] !== null)));
    return { status: 303, headers: [['location', `${binding.mount}/${saved.record.id as string}`]] };
  } catch (error) {
    const answer = feedback(binding, error);
    if (!answer) throw error;
    return binding.flow.render(request, { ...page, values: submitted.values, errors: answer.errors, status: answer.status, ...(answer.alert === undefined ? {} : { alert: answer.alert }) });
  }
}

function show(binding: Binding, request: ExtensionRequest, method: string, id: string): HandlerResult {
  if (method !== 'GET' && method !== 'HEAD') return text(405, 'Method not allowed', [['allow', 'GET, HEAD']]);
  const { record } = binding.records.get(request.principal, id);
  const shown = formValues(binding, record, binding.flow.confirmation.show);
  const links = [...(binding.edit ? [{ href: `${binding.mount}/${id}/edit`, label: 'Edit' }] : []), ...(binding.list ? [{ href: `${binding.mount}/`, label: binding.list.title }] : [])];
  return headOnly(method, binding.flow.confirmationPage(shown, links.length ? { links } : {}));
}

/** A stored value as the list shows it: a checkbox as Yes/No, a select as its option label, anything else as text. */
function display(spec: Readonly<FormFieldSpec>, value: Scalar | undefined): string {
  if (value === undefined) return '';
  if (spec.control === 'checkbox') return value === true ? 'Yes' : 'No';
  const text = toForm(value);
  return spec.control === 'select' ? spec.options?.find(option => option.value === text)?.label ?? text : text;
}
/**
 * `<mount>/`: one page of the caller's own records (the store scopes an owned collection to the principal), in
 * creation order, with the store's offset cursor in `?cursor=`. Every value is escaped; nothing is cached.
 */
function listPage(binding: Binding, request: ExtensionRequest, method: string): HandlerResult {
  const list = binding.list!, base = `${binding.mount}/`;
  const cursors = request.query.getAll('cursor');
  const invalid = () => text(400, 'This page link is not valid; open the list again');
  if (cursors.length > 1 || (cursors.length === 1 && !/^\d{1,9}$/.test(cursors[0]!))) return invalid();
  let page: ReturnType<StoreRecords['list']>;
  try { page = binding.records.list(request.principal, { limit: LIST_PAGE, ...(cursors.length ? { cursor: cursors[0]! } : {}) }); }
  catch (error) { if (storeFailure(error)?.status === 400) return invalid(); throw error; }
  const labels = binding.flow.declared;
  const head = `${list.columns.map(column => `<th scope="col">${escapeHtml(labels[column]!.label)}</th>`).join('')}<th scope="col">Links</th>`;
  const rows = page.items.map(record => {
    const id = escapeHtml(`${binding.mount}/${String(record.id)}`);
    const cells = list.columns.map(column => `<td>${escapeHtml(display(labels[column]!, record[binding.map[column]!]))}</td>`).join('');
    return `<tr>${cells}<td><a href="${id}">View</a>${binding.edit ? ` <a href="${id}/edit">Edit</a>` : ''}</td></tr>`;
  }).join('');
  const table = rows ? `<div class="ui-table"><table><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table></div>` : emptyState(page.total ? 'No records on this page.' : 'You have no records yet.');
  const pager = page.previous !== undefined || page.next !== undefined ? pagination({
    ...(page.previous === undefined ? {} : { previous: page.previous === '0' ? base : `${base}?cursor=${page.previous}` }),
    ...(page.next === undefined ? {} : { next: `${base}?cursor=${page.next}` }),
  }) : '';
  const body = `<section class="ui-stack"><h1>${escapeHtml(list.title)}</h1><p><a href="${escapeHtml(binding.mount)}">${escapeHtml(list.newLabel)}</a></p>${table}${pager}</section>`;
  const result = list.ui.kit.wrap(markup(body), { title: list.title });
  return headOnly(method, { status: 200, headers: [...result.headers.filter(([header]) => header.toLowerCase() !== 'cache-control'), ['cache-control', 'no-store']], body: result.body });
}

async function edit(binding: Binding, request: ExtensionRequest, method: string, id: string): Promise<HandlerResult> {
  const form = binding.edit;
  if (!form) return text(404, 'Not found');
  if (!['GET', 'HEAD', 'POST'].includes(method)) return text(405, 'Method not allowed', [['allow', 'GET, HEAD, POST']]);
  // Scoped first: another owner's record is the same 404 as a missing one, whatever else the request carries.
  const current = binding.records.get(request.principal, id);
  const editable = Object.keys(form.fields), fixed = binding.formFields.filter(field => !editable.includes(field));
  // The record version the page was rendered from travels in the action's query, and becomes the store update's If-Match.
  const page = (at: { record: Readonly<StoredRecord>; etag: string }) => ({
    action: `${binding.mount}/${id}/edit?v=${at.etag.slice(1, -1)}`, scope: `form-records:${binding.name}:edit:${id}`,
    readOnly: formValues(binding, at.record, fixed), ...(binding.editTitle === undefined ? {} : { title: binding.editTitle }),
  });
  if (method !== 'POST') return headOnly(method, form.render(request, { ...page(current), values: formValues(binding, current.record, editable) }));
  const version = request.query.getAll('v');
  if (version.length !== 1 || !/^[0-9a-f]{32}$/.test(version[0]!)) return text(400, 'The edit form is missing its record version; reload the edit page');
  const rendered = { ...page(current), action: `${binding.mount}/${id}/edit?v=${version[0]!}` };
  const submitted = form.submit(request, rendered);
  if (!submitted.ok) return submitted.response;
  const { values, errors } = convert(binding, submitted.values, true);
  if (Object.keys(errors).length) return form.render(request, { ...rendered, values: submitted.values, errors, status: 422 });
  try {
    await binding.records.update(request.principal, id, values, { ifMatch: `"${version[0]!}"` });
    return { status: 303, headers: [['location', `${binding.mount}/${id}`]] };
  } catch (error) {
    if (storeFailure(error)?.status === 412) {
      // Someone changed the record since this page was rendered: nothing was saved. Show the current values and version.
      const latest = binding.records.get(request.principal, id);
      return form.render(request, { ...page(latest), values: formValues(binding, latest.record, editable), status: 412, alert: 'This record changed since you opened it, so your changes were not saved. Review the current values and submit again.' });
    }
    const answer = feedback(binding, error);
    if (!answer) throw error;
    return form.render(request, { ...rendered, values: submitted.values, errors: answer.errors, status: answer.status, ...(answer.alert === undefined ? {} : { alert: answer.alert }) });
  }
}
