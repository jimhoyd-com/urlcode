/**
 * The store's optional CRUD screens. A project declares them under `extensions.store.config.screens`
 * (`/todos: {collection: todos, title: Todos}`), next to the collections they show, so fields are written once.
 * The store owns that declaration; when the `ui` extension is also installed, the store hands ui a generic
 * description of each screen through its definition's `contributes.ui.screens`, and ui renders it at an exact
 * `extension: ui` mount. The store does not import ui and ui never reads the store's configuration: the
 * contribution matches ui's documented `UiScreen` shape structurally.
 */
import type { CollectionSpec } from './collection.ts';

const NAME = '^[a-z][a-z0-9_-]{0,63}$';
const FIELD = '^[a-z][A-Za-z0-9_]{0,63}$';
/** `extensions.store.config.screens`: exact page paths, each showing one declared collection. */
export const screensSchema = {
  type: 'object', maxProperties: 16,
  propertyNames: { pattern: '^/[A-Za-z0-9._~-]+(?:/[A-Za-z0-9._~-]+)*$', maxLength: 256 },
  additionalProperties: {
    type: 'object', additionalProperties: false, required: ['collection'],
    properties: {
      collection: { type: 'string', pattern: NAME },
      title: { type: 'string', minLength: 1, maxLength: 80 },
      columns: { type: 'array', minItems: 1, maxItems: 64, items: { oneOf: [{ type: 'string', pattern: FIELD }, { type: 'object', additionalProperties: false, required: ['field'], properties: { field: { type: 'string', pattern: FIELD }, label: { type: 'string', minLength: 1, maxLength: 80 } } }] } },
    },
  },
} as const;

type Column = string | { field: string; label?: string };
interface ScreenSpec { collection: string; title?: string; columns?: Column[] }
/** A screen as the store contributes it to ui: the same shape as ui's `UiScreen`. */
export interface StoreScreen {
  title: string;
  collection: { mount: string; fields: CollectionSpec['fields']; readOnly?: boolean; sortable?: string[]; filterable?: string[] };
  columns?: Column[];
}

/** `todo_items` reads "Todo items". */
const label = (name: string): string => { const words = name.replace(/[_-]/g, ' ').trim(); return words.charAt(0).toUpperCase() + words.slice(1); };
const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * The screens a (schema-valid) store configuration declares, as generic screen descriptions. A screen naming a
 * collection the configuration does not declare refuses, so activation fails before anything is served.
 */
export function storeScreens(config: unknown): Record<string, StoreScreen> {
  if (!isRecord(config)) return {};
  const collections = (isRecord(config.collections) ? config.collections : {}) as Record<string, CollectionSpec>;
  const screens = (isRecord(config.screens) ? config.screens : {}) as Record<string, ScreenSpec>;
  const result: Record<string, StoreScreen> = {};
  for (const [path, screen] of Object.entries(screens)) {
    if (!Object.hasOwn(collections, screen.collection)) throw new Error(`Screen ${path}: collection ${screen.collection} is not declared in extensions.store.config.collections`);
    const spec = collections[screen.collection]!;
    result[path] = {
      title: screen.title ?? label(screen.collection),
      collection: { mount: spec.mount, fields: spec.fields, ...(spec.readOnly !== undefined ? { readOnly: spec.readOnly } : {}), ...(spec.sortable ? { sortable: spec.sortable } : {}), ...(spec.filterable ? { filterable: spec.filterable } : {}) },
      ...(screen.columns ? { columns: screen.columns } : {}),
    };
  }
  return result;
}

/**
 * The `screens` source the store contributes to ui (`contributes.ui.screens`). ui calls it once at activation
 * with the route project root; the store reads its own block from the reviewed project document there. A project
 * that does not declare the store contributes no screens.
 */
export async function contributedScreens({ root }: { readonly root: string }): Promise<Record<string, StoreScreen>> {
  const { loadDocument } = await import('@jimhoyd/urlcode');
  const loaded = await loadDocument(root);
  return storeScreens(loaded.document.extensions?.store?.config);
}
