// Route-inventory diff: compares two `urlcode routes` reports and reports what
// was added, removed or changed. Pure and generic: it knows nothing about
// pull requests; the GitHub action renders its Markdown into a PR comment.
import { ConfigError } from './errors.ts';
import { isRecord } from './object-guards.ts';
import type { PlanInventoryEntry, RouteState } from './types.ts';

/** One route as the diff sees it: the inventory entry plus its policy description from the `policies` map. */
interface RouteRecord extends PlanInventoryEntry { policy?: Record<string, unknown> }
/** The parts of a `urlcode routes` report the diff reads. */
export interface RouteSnapshot { inventory: PlanInventoryEntry[]; policies?: Record<string, Record<string, unknown>> | undefined }
interface RouteChange { path: string; before: RouteRecord; after: RouteRecord }
interface RouteDiff { added: RouteRecord[]; removed: RouteRecord[]; changed: RouteChange[] }

const states: readonly RouteState[] = ['active','disabled','expired'];
const isStrings = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === 'string');
function entry(value: unknown, index: number): PlanInventoryEntry {
  const fail = (what: string): never => { throw new ConfigError(`Route report inventory[${index}] ${what}`); };
  if (!isRecord(value)) return fail('is not an object');
  const { path, handler, methods, middleware, policies, generated, state, sandbox, sandboxReason } = value;
  if (typeof path !== 'string' || !path) return fail('needs a path');
  if (handler !== undefined && typeof handler !== 'string') return fail('has an invalid handler');
  if (!isStrings(methods)) return fail('needs methods');
  if (typeof middleware !== 'number' || !Number.isInteger(middleware) || middleware < 0) return fail('needs a middleware count');
  if (!isStrings(policies)) return fail('needs policies');
  if (generated !== undefined && typeof generated !== 'string') return fail('has an invalid generated marker');
  if (typeof state !== 'string' || !states.includes(state as RouteState)) return fail('needs a state');
  // `sandbox`/`sandboxReason` postdate the report format, so an older report
  // omits them: absent is carried through as absent rather than defaulted to
  // `false`, which would read as a trust change that never happened.
  if (sandbox !== undefined && typeof sandbox !== 'boolean') return fail('has an invalid sandbox flag');
  if (sandboxReason !== undefined && typeof sandboxReason !== 'string') return fail('has an invalid sandboxReason');
  return { path, handler, methods, middleware, policies, ...(generated !== undefined ? { generated } : {}), state:state as RouteState,
    ...(sandbox !== undefined ? { sandbox } : {}), ...(sandboxReason !== undefined ? { sandboxReason } : {}) };
}
/** Validates a parsed `urlcode routes` JSON report (a child-process or file boundary) into a snapshot. */
export function parseRouteSnapshot(value: unknown): RouteSnapshot {
  if (!isRecord(value) || !Array.isArray(value.inventory)) throw new ConfigError('Route report needs an inventory array');
  const inventory = value.inventory.map(entry);
  const policies: Record<string, Record<string, unknown>> = {};
  if (value.policies !== undefined) {
    if (!isRecord(value.policies)) throw new ConfigError('Route report policies must be an object');
    for (const [path, description] of Object.entries(value.policies)) {
      if (!isRecord(description)) throw new ConfigError(`Route report policies[${path}] must be an object`);
      policies[path] = description;
    }
  }
  return { inventory, policies };
}
// Key order in a report is not a change: compare canonical JSON.
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (isRecord(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
function records(snapshot: RouteSnapshot): Map<string, RouteRecord> {
  const map = new Map<string, RouteRecord>();
  for (const item of snapshot.inventory) {
    if (map.has(item.path)) throw new ConfigError(`Route report lists ${item.path} twice`);
    const policy = snapshot.policies?.[item.path];
    map.set(item.path, policy ? { ...item, policy } : { ...item });
  }
  return map;
}
/** Compares two route reports. Paths are sorted; an entry changes when any inventory field or its policy description differs. */
export function diffRoutes(before: RouteSnapshot, after: RouteSnapshot): RouteDiff {
  const previous = records(before), current = records(after);
  const paths = [...new Set([...previous.keys(), ...current.keys()])].sort();
  const diff: RouteDiff = { added:[], removed:[], changed:[] };
  for (const path of paths) {
    const old = previous.get(path), now = current.get(path);
    if (old && !now) diff.removed.push(old);
    else if (now && !old) diff.added.push(now);
    else if (old && now && canonical(old) !== canonical(now)) diff.changed.push({ path, before:old, after:now });
  }
  return diff;
}
export const hasRouteChanges = (diff: RouteDiff): boolean => diff.added.length + diff.removed.length + diff.changed.length > 0;

const fields = ['handler','methods','state','sandbox','sandboxReason','middleware','policies','generated','policy'] as const;
type Field = typeof fields[number];
const cell = (value: unknown): string => {
  const text = value === undefined ? '' : Array.isArray(value) && value.every(item => typeof item === 'string') ? value.join(', ') : typeof value === 'string' ? value : canonical(value);
  // Backslashes first, so an escape this adds is never itself re-escaped.
  return text.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ') || '-';
};
const code = (value: string): string => `\`${value.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\|/g, '\\|')}\``;
function table(headers: string[], rows: string[][]): string[] {
  return [`| ${headers.join(' | ')} |`, `|${headers.map(() => '---').join('|')}|`, ...rows.map(row => `| ${row.join(' | ')} |`)];
}
const routeRow = (record: RouteRecord): string[] => [code(record.path), cell(record.handler), cell(record.methods), cell(record.state),
  cell(record.sandbox), cell(record.sandboxReason), String(record.middleware), cell(record.policies), cell(record.generated)];
/** Renders a diff as Markdown: one table per nonempty section, or "No route changes". */
export function renderRouteDiff(diff: RouteDiff): string {
  if (!hasRouteChanges(diff)) return 'No route changes\n';
  const lines: string[] = [];
  const routeHeaders = ['Route','Handler','Methods','State','Sandbox','Sandbox reason','Middleware','Policies','Generated'];
  const section = (title: string, list: RouteRecord[]) => {
    if (!list.length) return;
    lines.push(`### ${title} (${list.length})`, '', ...table(routeHeaders, list.map(routeRow)), '');
  };
  section('Added routes', diff.added);
  section('Removed routes', diff.removed);
  if (diff.changed.length) {
    const rows: string[][] = [];
    for (const change of diff.changed) {
      const differing = fields.filter((field: Field) => canonical(change.before[field]) !== canonical(change.after[field]));
      for (const field of differing) rows.push([code(change.path), field, cell(change.before[field]), cell(change.after[field])]);
    }
    lines.push(`### Changed routes (${diff.changed.length})`, '', ...table(['Route','Field','Before','After'], rows), '');
  }
  return lines.join('\n');
}
