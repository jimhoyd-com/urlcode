/**
 * The operator step for records that predate `ownership: owner` on their collection (urlcode#331). An owned
 * collection serves a record only to the principal stamped on it, so a record written while the collection was
 * shared, which carries no owner, is served to nobody. The store never guesses an owner for it: the operator
 * reports such records and then either assigns them to one named principal or deletes them, with the server
 * stopped (these functions take the directory's single-writer lock, so they refuse while a store process holds it).
 *
 * They work on the data file alone and do not read the project: re-validation against the declared fields happens,
 * as always, when the store next activates.
 */
import { randomUUID } from 'node:crypto';
import { open, readFile, rename, rm } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { principalIdPattern } from '@jimhoyd/urlcode/extensions';
import { OWNER_FIELD } from './collection.ts';
import { lockStoreDirectory } from './store.ts';

const NAME = /^[a-z][a-z0-9_-]{0,63}$/;
type StoredFile = { version: number; records: Record<string, unknown>[]; idempotency?: unknown };

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
  try { await handle.writeFile(JSON.stringify({ version: 2, records: value.records, idempotency: value.version === 2 ? value.idempotency : [] })); await handle.sync(); }
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
