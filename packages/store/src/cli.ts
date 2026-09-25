#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { isAbsolute } from 'node:path';
import { assignOwnerless, deleteOwnerless, reassignOwner, reportOwnerless } from './ownership.ts';
import type { CollectionSpec } from './collection.ts';

const usage = 'urlcode-store ownerless --directory /absolute/data/store --collection <name>\n'
  + 'urlcode-store ownerless-assign --directory /absolute/data/store --collection <name> --owner <principal id>\n'
  + 'urlcode-store ownerless-delete --directory /absolute/data/store --collection <name>\n'
  + 'urlcode-store reassign --directory /absolute/data/store --project /absolute/site/app --from <principal id> --to <principal id> [--collection <name>] [--dry-run]\n'
  + 'Records in an `ownership: owner` collection with no owner (written before it became owned) are served to nobody.\n'
  + 'Report them, then assign them to one principal or delete them. reassign moves every record one principal owns to\n'
  + 'another (for example a revoked API key\'s apikey:<id> to its replacement) in the project\'s owned collections, and\n'
  + 'refuses as a whole if that would put --to over a collection\'s maxRecordsPerOwner. Run it with --dry-run first.\n'
  + 'Stop the server first: these take the directory lock.\n';

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
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { directory: { type: 'string' }, collection: { type: 'string' }, owner: { type: 'string' }, project: { type: 'string' }, from: { type: 'string' }, to: { type: 'string' }, 'dry-run': { type: 'boolean' }, help: { type: 'boolean' } } });
  const command = positionals[0];
  if (values.help || !command) process.stdout.write(usage);
  else {
    if (positionals.length !== 1) throw new Error('Invalid command');
    const directory = values.directory, collection = values.collection;
    if (command !== 'ownerless-assign' && values.owner !== undefined) throw new Error('--owner applies to ownerless-assign only');
    if (command !== 'reassign' && (values.project !== undefined || values.from !== undefined || values.to !== undefined || values['dry-run'] !== undefined)) throw new Error('--project, --from, --to and --dry-run apply to reassign only');
    let output: unknown;
    if (command === 'reassign') {
      if (!directory || !values.project || values.from === undefined || values.to === undefined) throw new Error('--directory, --project, --from and --to are required');
      output = await reassignOwner(directory, { from: values.from, to: values.to, collections: await declaredCollections(values.project), ...(collection === undefined ? {} : { collection }), dryRun: values['dry-run'] === true });
    }
    else {
      if (!directory || !collection) throw new Error('--directory and --collection are required');
      if (command === 'ownerless') output = await reportOwnerless(directory, collection);
      else if (command === 'ownerless-assign') { if (!values.owner) throw new Error('--owner is required'); output = await assignOwnerless(directory, collection, values.owner); }
      else if (command === 'ownerless-delete') output = await deleteOwnerless(directory, collection);
      else throw new Error('Unknown command');
    }
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  }
} catch (error) {
  process.stderr.write(`urlcode-store: ${error instanceof Error ? error.message : 'failed'}\n`);
  process.exitCode = 1;
}
