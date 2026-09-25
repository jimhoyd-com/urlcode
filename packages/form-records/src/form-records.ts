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
}
interface FormRecordsConfig { records: Record<string, FormRecordSpec> }
export interface FormRecordsExtensionOptions {
  /** Exact project revision the operator reviewed. */
  projectSha256: string;
  /** What `ctx.get('forms')` returned: forms' export contract, version 1. */
  forms: FormsExports;
  /** What `ctx.get('store')` returned: the store's export contract, version 1. */
  store: StoreExports;
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
        },
      },
    },
  },
} as const;

export const formRecordsAuthoring: ExtensionAuthoringContract = {
  description: 'Save a declared form into an owned store collection: a submission creates a record private to its signed-in creator, the confirmation page reads the saved record back, and an edit page changes only the fields listed in `editable`. forms keeps rendering, CSRF and validation; the store keeps ownership, limits and ETags. No handler code.',
  surfaces: [
    { kind: 'configuration', name: 'records', description: 'Each record flow: `mount`, the owned store `collection`, the `form` (a forms flow without a mount: title, submitLabel, confirmation with `show`, fields), the optional `fields` map from form field to collection field, `editable` form fields and `editTitle`.', path: 'urlcode.yaml#extensions.form-records.config.records' },
    { kind: 'extension', name: 'mount', description: 'Mount each record flow as `<mount>/*` with GET, HEAD and POST and a principal-providing policy such as `auth: true`. It serves `<mount>` (new record), `<mount>/<id>` (confirmation) and `<mount>/<id>/edit`. Declare forms and store before form-records under `extensions`.', path: 'urlcode.yaml' },
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
/** A form string as the collection's value. `undefined` leaves the field out; `{error}` is a field error. */
function toStored(stored: Readonly<FieldSpec>, value: string, editing: boolean): Scalar | undefined | { error: string } {
  if (stored.type === 'boolean') return value === 'true';
  if (value === '') return stored.type === 'string' && editing ? '' : editing ? { error: 'cannot be cleared once saved' } : undefined;
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
  return { name, mount: spec.mount, flow, edit, editTitle: spec.editTitle, records, map: Object.freeze({ ...map }), formFields };
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
      if (!options.forms.active || !options.store.active) throw new Error('form-records needs forms and store active first: declare both before form-records under extensions in urlcode.yaml');
      const config = raw as unknown as FormRecordsConfig;
      const byMount = new Map<string, Binding>();
      for (const [name, spec] of Object.entries(config.records)) {
        const binding = bind(name, spec, options);
        if (byMount.has(spec.mount)) throw new Error(`Records ${byMount.get(spec.mount)!.name} and ${name} share mount ${spec.mount}`);
        if (!context.mounts.includes(spec.mount)) throw new Error(`Record ${name}: route ${spec.mount}/* with extension: form-records is not declared`);
        // Fail closed at startup: a record is private to its creator, so the mount must be able to carry a principal.
        if (!(context.principalMounts ?? []).includes(spec.mount)) throw new Error(`Record ${name}: route ${spec.mount}/* needs a principal-providing policy (for example auth: true), because each record belongs to the signed-in user who created it`);
        byMount.set(spec.mount, binding);
      }
      for (const mount of context.mounts) if (!byMount.has(mount)) throw new Error(`form-records mount ${mount} has no declared record flow`);
      return { handle: request => handle(byMount, request) };
    },
  };
}

async function handle(byMount: ReadonlyMap<string, Binding>, request: ExtensionRequest): Promise<HandlerResult> {
  const binding = request.mount === null ? undefined : byMount.get(request.mount);
  if (!binding) return text(404, 'Not found');
  // A record flow never answers without a principal: never a fallback to a shared view.
  const principal = request.principal ?? null;
  if (principal === null) return text(401, 'Sign in to use this form');
  const suffix = request.path.slice(binding.mount.length).replace(/\/+$/, '');
  const method = request.method.toUpperCase();
  try {
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
/** Converts admitted form values for the collection; errors are keyed by form field. */
function convert(binding: Binding, values: Readonly<Record<string, string>>, editing: boolean): { values: Record<string, Scalar>; errors: Record<string, string> } {
  const out: Record<string, Scalar> = {}, errors: Record<string, string> = {};
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
    const saved = await binding.records.create(request.principal, values);
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
  return headOnly(method, binding.flow.confirmationPage(shown, binding.edit ? { links: [{ href: `${binding.mount}/${id}/edit`, label: 'Edit' }] } : {}));
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
