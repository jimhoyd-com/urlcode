/**
 * The data-bound list and form screen. It takes a generic collection
 * description (an HTTP collection API mount and its typed fields), so the
 * extension that serves the API can hand the same declaration to this screen
 * and an application declares its fields once. Node-free.
 *
 * The server renders the shell only: a heading, the declaration as escaped data
 * attributes and a no-script notice. The `crud` kit script (see `crud-script.ts`)
 * loads the records from the collection's own API, builds the create form and the
 * rows, and enforces the two client rules the tests pin: an edit in progress
 * survives any re-render, and an optimistic change is rolled back when the server
 * refuses it. No record value is rendered on the server, so nothing here can carry
 * a stored value into markup.
 */
import { Markup, escapeHtml } from './escape.ts';
import type { Kit, PageOptions, PageResult } from './kit.ts';
import type { PresentationContext, LocalePreferences } from './presentation.ts';

/** A field as the collection API declares it; only what the screen needs. */
export interface CrudFieldSpec {
    type: 'string' | 'integer' | 'number' | 'boolean';
    required?: boolean | undefined;
    default?: string | number | boolean | undefined;
    minLength?: number | undefined;
    maxLength?: number | undefined;
    minimum?: number | undefined;
    maximum?: number | undefined;
    enum?: readonly (string | number)[] | undefined;
}
/** A collection API the screen binds to: its mount and declared fields. */
export interface CrudCollection {
    /** The API mount that serves the collection, for example `/api/todos`. */
    mount: string;
    fields: Readonly<Record<string, CrudFieldSpec>>;
    readOnly?: boolean | undefined;
    /** Fields the API lets a list request sort by; the screen offers exactly these, and nothing when absent. */
    sortable?: readonly string[] | undefined;
    /** Fields the API lets a list request filter on by equality; the screen offers exactly these. */
    filterable?: readonly string[] | undefined;
}
/** A column choice: a declared field name, or a field with its own label. */
export type CrudColumn = string | { field: string; label?: string | undefined };
export interface CrudScreenOptions {
    collection: CrudCollection;
    /** Fields to show and their order (the create form follows it too); default is every declared field in declaration order. */
    columns?: readonly CrudColumn[] | undefined;
    /** Page and heading text. */
    title: string;
    preferences?: LocalePreferences | undefined;
    context?: PresentationContext | undefined;
    nav?: PageOptions['nav'];
    menu?: PageOptions['menu'];
    layout?: PageOptions['layout'];
}
type ControlKind = 'text' | 'textarea' | 'select' | 'checkbox' | 'number';
interface ClientField { n: string; l: string; t: string; k: ControlKind; r: boolean; m?: number; o?: (string | number)[]; d?: string | number | boolean }

const mountPattern = /^\/[A-Za-z0-9._~/-]*[A-Za-z0-9._~-]$/;
const fieldName = /^[a-z][A-Za-z0-9_]{0,63}$/;
/** The copy ids the screen uses; the client receives the resolved text. */
export const crudCopyKeys = ['add', 'save', 'cancel', 'edit', 'remove', 'refresh', 'more', 'empty', 'loading', 'loadFailed', 'saveFailed', 'deleteFailed', 'invalid', 'noScript'] as const;

/** `dueDate` and `due_date` both read "Due date". */
export function fieldLabel(name: string): string {
    const words = name.replace(/_/g, ' ').replace(/([a-z0-9])([A-Z])/g, '$1 $2').trim().toLowerCase();
    return words.charAt(0).toUpperCase() + words.slice(1);
}
function controlKind(spec: CrudFieldSpec): ControlKind {
    if (spec.type === 'boolean') return 'checkbox';
    if (spec.enum && spec.enum.length) return 'select';
    if (spec.type === 'integer' || spec.type === 'number') return 'number';
    return spec.maxLength === undefined || spec.maxLength > 200 ? 'textarea' : 'text';
}
const maxLabel = 80;
// Control characters and line breaks never belong in a label.
const unsafeLabel = /[\u0000-\u001f\u007f]/;
/** Validates the declaration shape and returns the client's field list. `columns` selects, orders and relabels fields. Throws plain errors naming the offending key. */
export function crudFields(collection: CrudCollection, columns?: readonly CrudColumn[]): ClientField[] {
    if (!collection || typeof collection !== 'object' || typeof collection.mount !== 'string' || !mountPattern.test(collection.mount) || collection.mount.length > 256) throw new Error('crud collection needs a mount path such as /api/todos');
    const entries = Object.entries(collection.fields ?? {});
    if (!entries.length || entries.length > 64) throw new Error('crud collection needs between 1 and 64 fields');
    const all = crudFieldList(entries);
    queryNames(collection, 'sortable');
    queryNames(collection, 'filterable');
    if (columns === undefined) return all;
    if (!Array.isArray(columns) || !columns.length || columns.length > 64) throw new Error('crud columns must list between 1 and 64 fields');
    const byName = new Map(all.map(field => [field.n, field]));
    const seen = new Set<string>();
    const chosen = columns.map((column, index) => {
        const entry = typeof column === 'string' ? { field: column } as { field: unknown; label?: unknown } : column as { field: unknown; label?: unknown };
        if (entry === null || typeof entry !== 'object' || Array.isArray(entry) || typeof entry.field !== 'string') throw new Error(`crud columns[${index}] must be a field name or {field, label}`);
        const extra = Object.keys(entry).find(key => key !== 'field' && key !== 'label');
        if (extra !== undefined) throw new Error(`crud columns[${index}] has an unsupported key: ${extra.slice(0, 64)}`);
        const field = byName.get(entry.field);
        if (!field || !Object.hasOwn(collection.fields, entry.field)) throw new Error(`crud columns names a field the collection does not declare: ${entry.field.slice(0, 64)}`);
        if (seen.has(entry.field)) throw new Error(`crud columns lists a field twice: ${entry.field}`);
        seen.add(entry.field);
        if (entry.label === undefined) return field;
        if (typeof entry.label !== 'string' || !entry.label.trim() || entry.label.length > maxLabel || unsafeLabel.test(entry.label)) throw new Error(`crud label for ${entry.field} must be 1 to ${maxLabel} characters of plain text`);
        return { ...field, l: entry.label };
    });
    if (!collection.readOnly) for (const [name, spec] of entries) if (spec.required === true && spec.default === undefined && !seen.has(name)) throw new Error(`crud columns omits required field ${name}, which has no default, so a new record could not be created`);
    return chosen;
}
/** The declared sortable or filterable names, checked against the fields. A list parameter name cannot be a filter. */
function queryNames(collection: CrudCollection, key: 'sortable' | 'filterable'): string[] {
    const names: unknown = collection[key] ?? [];
    if (!Array.isArray(names) || names.length > 8) throw new Error(`crud ${key} must list at most 8 field names`);
    const seen = new Set<string>();
    for (const name of names as unknown[]) {
        if (typeof name !== 'string' || !Object.hasOwn(collection.fields, name)) throw new Error(`crud ${key} names a field the collection does not declare: ${String(name).slice(0, 64)}`);
        if (seen.has(name) || (key === 'filterable' && ['limit', 'cursor', 'sort'].includes(name))) throw new Error(`crud ${key} cannot use ${name}`);
        seen.add(name);
    }
    return names as string[];
}
function crudFieldList(entries: [string, CrudFieldSpec][]): ClientField[] {
    return entries.map(([name, spec]) => {
        if (!fieldName.test(name)) throw new Error(`crud field name is not valid: ${name.slice(0, 64)}`);
        if (!spec || !['string', 'integer', 'number', 'boolean'].includes(spec.type)) throw new Error(`crud field ${name} has an unsupported type`);
        const kind = controlKind(spec);
        const field: ClientField = { n: name, l: fieldLabel(name), t: spec.type, k: kind, r: spec.required === true };
        if (spec.maxLength !== undefined && spec.type === 'string') field.m = spec.maxLength;
        if (kind === 'select') field.o = [...spec.enum!];
        if (spec.default !== undefined) field.d = spec.default;
        return field;
    });
}
/** The shell markup: trusted, every dynamic part escaped. */
export function crudMarkup(context: PresentationContext, options: Pick<CrudScreenOptions, 'collection' | 'title' | 'columns'>): Markup {
    const fields = crudFields(options.collection, options.columns);
    const copy: Record<string, string> = {};
    for (const key of crudCopyKeys) copy[key] = context.text(`ui.crud.${key}`);
    const attribute = (value: unknown) => escapeHtml(JSON.stringify(value));
    // Sort and filter controls come only from the collection's declared lists; a collection that declares none renders exactly as before.
    const sortable = queryNames(options.collection, 'sortable'), filterable = queryNames(options.collection, 'filterable');
    let query = '';
    if (sortable.length || filterable.length) {
        const labelled = new Map(crudFields(options.collection).map(field => [field.n, field]));
        for (const field of fields) labelled.set(field.n, field);
        if (sortable.length) copy.sort = context.text('ui.crud.sort');
        query = ` data-query="${attribute({ s: sortable.map(name => ({ n: name, l: labelled.get(name)!.l })), f: filterable.map(name => labelled.get(name)!) })}"`;
    }
    return new Markup(`<section class="ui-card" data-slot="card"><header class="ui-card-header" data-slot="card-header"><h2 class="ui-card-title" data-slot="card-title">${escapeHtml(options.title)}</h2></header><div class="ui-card-content" data-slot="card-content"><div class="ui-crud" data-ui-crud data-api="${escapeHtml(options.collection.mount)}" data-fields="${attribute(fields)}" data-copy="${attribute(copy)}"${query}${options.collection.readOnly ? ' data-readonly="true"' : ''}><p class="ui-muted">${escapeHtml(copy.noScript!)}</p></div></div></section>`);
}
/** A complete page for one collection: list, create form, edit rows and delete, wired by the `crud` kit script. */
export function crudScreen(kit: Kit, options: CrudScreenOptions): PageResult {
    const context = options.context ?? kit.resolveContext(options.preferences);
    const page: PageOptions = { title: options.title, context, scripts: ['crud'], csp: { connect: ["'self'"] }, layout: options.layout ?? 'default' };
    if (options.nav) page.nav = options.nav;
    if (options.menu) page.menu = options.menu;
    return kit.wrap(crudMarkup(context, options), page);
}
