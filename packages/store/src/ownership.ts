/**
 * The operator step for records that predate `ownership: owner` on their collection (urlcode#331). An owned
 * collection serves a record only to the principal stamped on it, so a record written while the collection was
 * shared, which carries no owner, is served to nobody. The store never guesses an owner for it: the operator
 * reports such records and then either assigns them to one named principal or deletes them, with the server
 * stopped (these functions take the directory's single-writer lock, so they refuse while a store process holds it).
 *
 * They work on the data file alone and do not read the project: re-validation against the declared fields happens,
 * as always, when the store next activates.
 *
 * `reassignOwner` (urlcode#732) is the other operator step: it moves every record one principal owns to another (a
 * revoked or rotated API key's `apikey:<id>` to its replacement or to a user). It does need the project's declared
 * collections, to know which are owned and each one's `maxRecordsPerOwner`, and is refused as a whole rather than
 * leaving any principal over its limit.
 */
import { randomUUID } from 'node:crypto';
import { access, open, readFile, rename, rm } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { principalIdPattern } from '@jimhoyd/urlcode/extensions';
import { OWNER_FIELD, normalize } from './collection.ts';
import type { CollectionSpec } from './collection.ts';
import { lockStoreDirectory } from './store.ts';

const NAME = /^[a-z][a-z0-9_-]{0,63}$/;
/** `audit` is the undelivered audit outbox: these operator commands keep it as written and add no event of their own. */
type StoredFile = { version: number; records: Record<string, unknown>[]; idempotency?: unknown; audit?: unknown };

export interface OwnerlessReport { collection: string; records: number; ownerless: number; ids: string[] }

function fileOf(directory: string, collection: string): string {
  if (!isAbsolute(directory)) throw new Error('Store directory must be an absolute path');
  if (!NAME.test(collection)) throw new Error('Collection name is not valid');
  return join(directory, `${collection}.json`);
}
async function readStored(file: string): Promise<StoredFile> {
  let parsed: unknown;
  try { parsed = JSON.parse(await readFile(file, 'utf8')); } catch { throw new Error('Collection data file is missing or is not valid JSON'); }
  const value = parsed as StoredFile;
  if (!value || typeof value !== 'object' || ![1, 2].includes(value.version) || !Array.isArray(value.records) || value.records.some(record => !record || typeof record !== 'object' || typeof record.id !== 'string')) throw new Error('Collection data file has an unsupported shape');
  return value;
}
async function writeStored(file: string, value: StoredFile): Promise<void> {
  const temporary = `${file}.${randomUUID()}.tmp`, handle = await open(temporary, 'wx', 0o600);
  try { await handle.writeFile(JSON.stringify({ version: 2, records: value.records, idempotency: value.version === 2 ? value.idempotency : [], ...(value.version === 2 && value.audit !== undefined ? { audit: value.audit } : {}) })); await handle.sync(); }
  catch (error) { await handle.close().catch(() => undefined); await rm(temporary, { force: true }); throw error; }
  await handle.close();
  try { await rename(temporary, file); } catch (error) { await rm(temporary, { force: true }); throw error; }
}
const ownerless = (value: StoredFile): Record<string, unknown>[] => value.records.filter(record => record[OWNER_FIELD] === undefined);
async function locked<T>(directory: string, work: () => Promise<T>): Promise<T> {
  const unlock = await lockStoreDirectory(directory);
  try { return await work(); } finally { await unlock(); }
}

/** Counts (and lists the ids of) a collection's records that carry no owner. Changes nothing. */
export async function reportOwnerless(directory: string, collection: string): Promise<OwnerlessReport> {
  const file = fileOf(directory, collection);
  return locked(directory, async () => {
    const value = await readStored(file), found = ownerless(value);
    return { collection, records: value.records.length, ownerless: found.length, ids: found.map(record => record.id as string) };
  });
}
/**
 * Stamps `owner` (a principal id, exactly as the principal provider sets it: for auth, the user id, or
 * `apikey:<key id>` for a bearer key) on every record that has none. Records that already have an owner are untouched.
 */
export async function assignOwnerless(directory: string, collection: string, owner: string): Promise<OwnerlessReport> {
  if (typeof owner !== 'string' || !principalIdPattern.test(owner)) throw new Error('Owner must be a principal id: 1 to 128 ASCII letters, digits, ".", "_", ":" or "-", starting with a letter or digit');
  const file = fileOf(directory, collection);
  return locked(directory, async () => {
    const value = await readStored(file), found = ownerless(value);
    if (found.length) await writeStored(file, { ...value, records: value.records.map(record => record[OWNER_FIELD] === undefined ? { ...record, [OWNER_FIELD]: owner } : record) });
    return { collection, records: value.records.length, ownerless: 0, ids: found.map(record => record.id as string) };
  });
}
/** Deletes every record that has no owner. Records that have one are untouched. */
export async function deleteOwnerless(directory: string, collection: string): Promise<OwnerlessReport> {
  const file = fileOf(directory, collection);
  return locked(directory, async () => {
    const value = await readStored(file), found = ownerless(value);
    if (found.length) await writeStored(file, { ...value, records: value.records.filter(record => record[OWNER_FIELD] !== undefined) });
    return { collection, records: value.records.length - found.length, ownerless: 0, ids: found.map(record => record.id as string) };
  });
}

const principalMessage = (flag: string) => `${flag} must be a principal id: 1 to 128 ASCII letters, digits, ".", "_", ":" or "-", starting with a letter or digit`;
export interface ReassignCollectionReport { collection: string; moved: number; toBefore: number; toAfter: number; maxRecordsPerOwner: number | null }
export interface ReassignReport { from: string; to: string; dryRun: boolean; moved: number; collections: ReassignCollectionReport[] }
export interface ReassignOptions {
  /** The principal id the records belong to now, exactly as stored (`apikey:<key id>`, a user id, ...). */
  from: string;
  /** The principal id they move to. */
  to: string;
  /** The project's declared store collections (`extensions.store.config.collections`); only `ownership: owner` ones are touched. */
  collections: Record<string, CollectionSpec>;
  /** Limit the move to one owned collection. */
  collection?: string;
  /** Report what would move and change nothing. */
  dryRun?: boolean;
}

/**
 * Moves every record owned by `from` to `to` in the owned collections (or the one named), with the directory lock held.
 * Counts are computed for every affected collection first; when any move would leave `to` holding more than that
 * collection's `maxRecordsPerOwner`, the whole operation is refused, naming the collection, and nothing is written.
 * Otherwise each changed file is replaced atomically, one after another. A failure between two files (a disk error)
 * can leave the earlier ones moved; running the same command again moves the rest, because it only ever moves what
 * `from` still holds.
 */
export async function reassignOwner(directory: string, options: ReassignOptions): Promise<ReassignReport> {
  const { from, to } = options;
  if (typeof from !== 'string' || !principalIdPattern.test(from)) throw new Error(principalMessage('--from'));
  if (typeof to !== 'string' || !principalIdPattern.test(to)) throw new Error(principalMessage('--to'));
  if (from === to) throw new Error('--from and --to name the same principal');
  if (!options.collections || typeof options.collections !== 'object') throw new Error('The project declares no store collections');
  const owned = Object.entries(options.collections).map(([name, spec]) => ({ name, spec: normalize(name, spec) })).filter(entry => entry.spec.ownership === 'owner');
  let selected = owned;
  if (options.collection !== undefined) {
    if (!Object.hasOwn(options.collections, options.collection)) throw new Error(`Collection ${options.collection} is not declared`);
    selected = owned.filter(entry => entry.name === options.collection);
    if (!selected.length) throw new Error(`Collection ${options.collection} is not declared with ownership: owner`);
  }
  if (!selected.length) throw new Error('The project declares no collection with ownership: owner');
  const files = selected.map(entry => ({ ...entry, file: fileOf(directory, entry.name) }));
  return locked(directory, async () => {
    const plans: { file: string; value: StoredFile; report: ReassignCollectionReport }[] = [];
    for (const { name, spec, file } of files) {
      let value: StoredFile;
      try { await access(file); value = await readStored(file); }
      catch (error) { if ((error as { code?: string }).code === 'ENOENT') continue; throw new Error(`Collection ${name}: ${(error as Error).message}`, { cause: error }); }
      const moved = value.records.filter(record => record[OWNER_FIELD] === from).length, toBefore = value.records.filter(record => record[OWNER_FIELD] === to).length;
      plans.push({ file, value, report: { collection: name, moved, toBefore, toAfter: toBefore + moved, maxRecordsPerOwner: spec.maxRecordsPerOwner ?? null } });
    }
    const over = plans.map(plan => plan.report).filter(report => report.moved > 0 && report.maxRecordsPerOwner !== null && report.toAfter > report.maxRecordsPerOwner);
    if (over.length) throw new Error(`Nothing was moved: ${over.map(report => `collection ${report.collection} would give ${to} ${report.toAfter} records, over its maxRecordsPerOwner of ${report.maxRecordsPerOwner}`).join('; ')}. Delete or reassign some of its records first, or raise the limit.`);
    if (!options.dryRun) for (const plan of plans) if (plan.report.moved > 0) await writeStored(plan.file, { ...plan.value, records: plan.value.records.map(record => record[OWNER_FIELD] === from ? { ...record, [OWNER_FIELD]: to } : record) });
    const collections = plans.map(plan => plan.report);
    return { from, to, dryRun: options.dryRun === true, moved: collections.reduce((sum, report) => sum + report.moved, 0), collections };
  });
}
