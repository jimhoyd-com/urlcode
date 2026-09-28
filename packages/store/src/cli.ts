#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { isAbsolute } from 'node:path';
import { assignOwnerless, deleteOwnerless, reassignOwner, reportOwnerless } from './ownership.ts';
import { backupStore } from './backup.ts';
import { addMember, listMembers, removeMember } from './membership.ts';
import type { CollectionSpec } from './collection.ts';

const usage = 'urlcode-store ownerless --database /absolute/data/store.sqlite --collection <name>\n'
  + 'urlcode-store ownerless-assign --database /absolute/data/store.sqlite --collection <name> --owner <principal id>\n'
  + 'urlcode-store ownerless-delete --database /absolute/data/store.sqlite --collection <name>\n'
  + 'urlcode-store reassign --database /absolute/data/store.sqlite --project /absolute/site/app --from <principal id> --to <principal id> [--collection <name>] [--dry-run]\n'
  + 'urlcode-store backup --database /absolute/data/store.sqlite --destination /absolute/backups/store-<date>.sqlite\n'
  + 'urlcode-store members add|remove --database /absolute/data/store.sqlite --project /absolute/site/app --collection <name> --principal <principal id>\n'
  + 'urlcode-store members list --database /absolute/data/store.sqlite --project /absolute/site/app --collection <name>\n'
  + 'Records in an `ownership: owner` collection with no owner (written while it was still shared) are served to nobody.\n'
  + 'Report them, then assign them to one principal or delete them. reassign moves every record one principal owns to\n'
  + 'another (for example a revoked API key\'s apikey:<id> to its replacement) in the project\'s owned collections, moves\n'
  + 'its membership in the membership collections with them, and refuses as a whole if that would put --to over a\n'
  + 'collection\'s maxRecordsPerOwner. Run it with --dry-run first.\n'
  + 'members adds, removes or lists the principal ids of a membership: true collection (who passes its gate); on an\n'
  + 'audit: true collection each change is recorded in the audit outbox in the same transaction, with actor operator.\n'
  + 'backup writes a consistent online copy (SQLite\'s backup API) to a new 0600 file, refusing an existing destination,\n'
  + 'and checks it opens as a store database before it appears. To restore, stop the server and put the copy in place.\n'
  + 'Every other command is one transaction on the store database. All of them may run while the server is serving.\n';

/** The declared store collections, read through core's own project loader (the same validation `urlcode serve` applies). */
async function declaredCollections(project: string): Promise<Record<string, CollectionSpec>> {
  if (!isAbsolute(project)) throw new Error('--project must be an absolute path');
  const { loadDocument } = await import('@jimhoyd/urlcode');
  const { document } = await loadDocument(project);
  const collections = (document.extensions?.store?.config as { collections?: Record<string, CollectionSpec> } | undefined)?.collections;
  if (!collections) throw new Error('The project does not declare the store extension with collections');
  return collections;
}

try {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { database: { type: 'string' }, destination: { type: 'string' }, collection: { type: 'string' }, owner: { type: 'string' }, project: { type: 'string' }, from: { type: 'string' }, to: { type: 'string' }, principal: { type: 'string' }, 'dry-run': { type: 'boolean' }, help: { type: 'boolean' } } });
  const command = positionals[0];
  if (values.help || !command) process.stdout.write(usage);
  else {
    if (positionals.length !== (command === 'members' ? 2 : 1)) throw new Error('Invalid command');
    const database = values.database, collection = values.collection;
    if (command !== 'ownerless-assign' && values.owner !== undefined) throw new Error('--owner applies to ownerless-assign only');
    if (command !== 'reassign' && (values.from !== undefined || values.to !== undefined || values['dry-run'] !== undefined)) throw new Error('--from, --to and --dry-run apply to reassign only');
    if (command !== 'reassign' && command !== 'members' && values.project !== undefined) throw new Error('--project applies to reassign and members only');
    if (!(command === 'members' && positionals[1] !== 'list') && values.principal !== undefined) throw new Error('--principal applies to members add and members remove only');
    if (command !== 'backup' && values.destination !== undefined) throw new Error('--destination applies to backup only');
    let output: unknown;
    if (command === 'backup') {
      if (collection !== undefined) throw new Error('--collection does not apply to backup');
      if (!database || !values.destination) throw new Error('--database and --destination are required');
      output = await backupStore({ database, destination: values.destination });
    }
    else if (command === 'members') {
      const action = positionals[1];
      if (action !== 'add' && action !== 'remove' && action !== 'list') throw new Error('Use members add, members remove or members list');
      if (!database || !values.project || !collection) throw new Error('--database, --project and --collection are required');
      const options = { collections: await declaredCollections(values.project), collection };
      if (action === 'list') output = await listMembers(database, options);
      else {
        if (values.principal === undefined) throw new Error('--principal is required');
        output = await (action === 'add' ? addMember : removeMember)(database, { ...options, principal: values.principal });
      }
    }
    else if (command === 'reassign') {
      if (!database || !values.project || values.from === undefined || values.to === undefined) throw new Error('--database, --project, --from and --to are required');
      output = await reassignOwner(database, { from: values.from, to: values.to, collections: await declaredCollections(values.project), ...(collection === undefined ? {} : { collection }), dryRun: values['dry-run'] === true });
    }
    else {
      if (!database || !collection) throw new Error('--database and --collection are required');
      if (command === 'ownerless') output = await reportOwnerless(database, collection);
      else if (command === 'ownerless-assign') { if (!values.owner) throw new Error('--owner is required'); output = await assignOwnerless(database, collection, values.owner); }
      else if (command === 'ownerless-delete') output = await deleteOwnerless(database, collection);
      else throw new Error('Unknown command');
    }
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  }
} catch (error) {
  process.stderr.write(`urlcode-store: ${error instanceof Error ? error.message : 'failed'}\n`);
  process.exitCode = 1;
}
