#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { isAbsolute } from 'node:path';
import { validateAuditQuery } from '@jimhoyd/urlcode/extensions';
import { reassignOwner } from './ownership.ts';
import { backupStore, restoreStore } from './backup.ts';
import { addMember, listMembers, removeMember } from './membership.ts';
import { queryAudit } from './audit.ts';
import { openStoreReader } from './database.ts';
import type { CollectionSpec } from './collection.ts';

const usage = 'urlcode-store reassign --database /absolute/data/store.sqlite --project /absolute/site/app --from <principal id> --to <principal id> [--collection <name>] [--dry-run] [--actor <principal id>]\n'
  + 'urlcode-store members add|remove --database /absolute/data/store.sqlite --project /absolute/site/app --collection <name> --principal <principal id> [--actor <principal id>]\n'
  + 'urlcode-store members list --database /absolute/data/store.sqlite --project /absolute/site/app --collection <name>\n'
  + 'urlcode-store audit --database /absolute/data/store.sqlite [--source <name>] [--actor <id>] [--subject <text>] [--action <action>] [--action-prefix <action>] [--from <epoch ms>] [--to <epoch ms>] [--after <seq>] [--limit 1-100] [--order asc|desc]\n'
  + 'urlcode-store backup --database /absolute/data/store.sqlite --destination /absolute/backups/store-<date>.sqlite\n'
  + 'urlcode-store restore --backup /absolute/backups/store-<date>.sqlite --destination /absolute/data/store-restored.sqlite\n'
  + 'reassign moves every record one principal owns to another (for example a revoked API key\'s apikey:<id> to its\n'
  + 'replacement) in the project\'s owned collections, moves its membership in the membership collections with them, and\n'
  + 'refuses as a whole if that would put --to over a collection\'s maxRecordsPerOwner. Run it with --dry-run first.\n'
  + 'members adds, removes or lists the principal ids of a membership: true collection (who passes its gate).\n'
  + 'On an audit: true collection, members and reassign record each change in the store\'s audit log in the same\n'
  + 'transaction. The event actor is operator, or the --actor principal id: operator-asserted, not authenticated.\n'
  + 'audit prints one page of the audit log (at most 100 events), opening the database read-only; pass its "next" back\n'
  + 'as --after for the next page.\n'
  + 'backup writes a consistent online copy (SQLite\'s backup API), audit log included, to a new 0600 file, refusing an\n'
  + 'existing destination, and checks it opens as a store database before it appears. restore makes the same checked\n'
  + 'copy from a backup to a new path; stop the server and move it into place yourself.\n'
  + 'Every other command is one transaction on the store database. All of them may run while the server is serving.\n';

/**
 * The declared store collections, the project's named schemas (which `schema: <name>` resolves against) and its
 * `auditRetention`, read through core's own project loader (the same validation `urlcode serve` applies).
 */
async function declared(project: string): Promise<{ collections: Record<string, CollectionSpec>; schemas: Record<string, unknown>; auditRetention?: number }> {
  if (!isAbsolute(project)) throw new Error('--project must be an absolute path');
  const { loadDocument } = await import('@jimhoyd/urlcode');
  const { document, schemas } = await loadDocument(project);
  const config = document.extensions?.store?.config as { collections?: Record<string, CollectionSpec>; auditRetention?: number } | undefined;
  if (!config?.collections) throw new Error('The project does not declare the store extension with collections');
  return { collections: config.collections, schemas: schemas ?? {}, ...(config.auditRetention === undefined ? {} : { auditRetention: config.auditRetention }) };
}
/** The flags each command takes; any other given flag is refused, naming it. */
const accepted: Record<string, readonly string[]> = {
  reassign: ['database', 'project', 'from', 'to', 'collection', 'dry-run', 'actor'],
  members: ['database', 'project', 'collection', 'principal', 'actor'],
  audit: ['database', 'source', 'actor', 'subject', 'action', 'action-prefix', 'from', 'to', 'after', 'limit', 'order'],
  backup: ['database', 'destination'],
  restore: ['backup', 'destination'],
};
const integer = (value: string | undefined, flag: string): number | undefined => {
  if (value === undefined) return undefined;
  if (!/^(0|[1-9][0-9]{0,15})$/.test(value)) throw new Error(`--${flag} must be a whole number`);
  return Number(value);
};

try {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { database: { type: 'string' }, destination: { type: 'string' }, backup: { type: 'string' }, collection: { type: 'string' }, project: { type: 'string' }, from: { type: 'string' }, to: { type: 'string' }, principal: { type: 'string' }, actor: { type: 'string' }, 'dry-run': { type: 'boolean' }, source: { type: 'string' }, subject: { type: 'string' }, action: { type: 'string' }, 'action-prefix': { type: 'string' }, after: { type: 'string' }, limit: { type: 'string' }, order: { type: 'string' }, help: { type: 'boolean' } } });
  const command = positionals[0];
  if (values.help || !command) process.stdout.write(usage);
  else {
    if (!Object.hasOwn(accepted, command)) throw new Error('Unknown command');
    if (positionals.length !== (command === 'members' ? 2 : 1)) throw new Error('Invalid command');
    const given = Object.keys(values).find(flag => values[flag as keyof typeof values] !== undefined && !accepted[command]!.includes(flag));
    if (given !== undefined) throw new Error(`--${given} does not apply to ${command}`);
    const database = values.database, collection = values.collection;
    const actor = values.actor === undefined ? {} : { actor: values.actor };
    let output: unknown;
    if (command === 'backup') {
      if (!database || !values.destination) throw new Error('--database and --destination are required');
      output = await backupStore({ database, destination: values.destination });
    }
    else if (command === 'restore') {
      if (!values.backup || !values.destination) throw new Error('--backup and --destination are required');
      output = await restoreStore({ backup: values.backup, destination: values.destination });
    }
    else if (command === 'audit') {
      if (!database || !isAbsolute(database)) throw new Error('--database must be an absolute path');
      const query = validateAuditQuery(Object.fromEntries(Object.entries({
        source: values.source, actor: values.actor, subject: values.subject, action: values.action, actionPrefix: values['action-prefix'],
        from: integer(values.from, 'from'), to: integer(values.to, 'to'), after: values.after, limit: integer(values.limit, 'limit'), order: values.order,
      }).filter(([, value]) => value !== undefined)));
      const db = await openStoreReader(database);
      try { output = queryAudit(db, query); } finally { db.close(); }
    }
    else if (command === 'members') {
      const action = positionals[1];
      if (action !== 'add' && action !== 'remove' && action !== 'list') throw new Error('Use members add, members remove or members list');
      if (!database || !values.project || !collection) throw new Error('--database, --project and --collection are required');
      if (action === 'list' && (values.principal !== undefined || values.actor !== undefined)) throw new Error('--principal and --actor apply to members add and members remove only');
      const options = { ...await declared(values.project), collection };
      if (action === 'list') output = await listMembers(database, options);
      else {
        if (values.principal === undefined) throw new Error('--principal is required');
        output = await (action === 'add' ? addMember : removeMember)(database, { ...options, principal: values.principal, ...actor });
      }
    }
    else {
      if (!database || !values.project || values.from === undefined || values.to === undefined) throw new Error('--database, --project, --from and --to are required');
      output = await reassignOwner(database, { from: values.from, to: values.to, ...await declared(values.project), ...(collection === undefined ? {} : { collection }), dryRun: values['dry-run'] === true, ...actor });
    }
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  }
} catch (error) {
  process.stderr.write(`urlcode-store: ${error instanceof Error ? error.message : 'failed'}\n`);
  process.exitCode = 1;
}
