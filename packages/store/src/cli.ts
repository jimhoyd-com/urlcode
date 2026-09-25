#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { assignOwnerless, deleteOwnerless, reportOwnerless } from './ownership.ts';

const usage = 'urlcode-store ownerless --directory /absolute/data/store --collection <name>\n'
  + 'urlcode-store ownerless-assign --directory /absolute/data/store --collection <name> --owner <principal id>\n'
  + 'urlcode-store ownerless-delete --directory /absolute/data/store --collection <name>\n'
  + 'Records in an `ownership: owner` collection with no owner (written before it became owned) are served to nobody.\n'
  + 'Report them, then assign them to one principal or delete them. Stop the server first: these take the directory lock.\n';
try {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { directory: { type: 'string' }, collection: { type: 'string' }, owner: { type: 'string' }, help: { type: 'boolean' } } });
  const command = positionals[0];
  if (values.help || !command) process.stdout.write(usage);
  else {
    if (positionals.length !== 1) throw new Error('Invalid command');
    const directory = values.directory, collection = values.collection;
    if (!directory || !collection) throw new Error('--directory and --collection are required');
    if (command !== 'ownerless-assign' && values.owner !== undefined) throw new Error('--owner applies to ownerless-assign only');
    let output: unknown;
    if (command === 'ownerless') output = await reportOwnerless(directory, collection);
    else if (command === 'ownerless-assign') { if (!values.owner) throw new Error('--owner is required'); output = await assignOwnerless(directory, collection, values.owner); }
    else if (command === 'ownerless-delete') output = await deleteOwnerless(directory, collection);
    else throw new Error('Unknown command');
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  }
} catch (error) {
  process.stderr.write(`urlcode-store: ${error instanceof Error ? error.message : 'failed'}\n`);
  process.exitCode = 1;
}
