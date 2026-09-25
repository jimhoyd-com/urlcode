#!/usr/bin/env node
// urlcode-audit list|backup|restore. Input is bounded JSON on stdin, never argv. `list` opens the database
// read-only and prints one page; it never creates, migrates or writes the file.
import { parseArgs } from 'node:util';
import { isAbsolute } from 'node:path';
import { createBackup, restoreBackup } from './backup.ts';
import { openAuditReader } from './store.ts';
import { validateAuditQuery } from './event.ts';

const usage = 'urlcode-audit list     JSON {"database": "/abs/data/audit.sqlite", "query"?: {source, actor, subject, action, actionPrefix, from, to, after, limit, order}} on stdin\n'
  + 'urlcode-audit backup   JSON {"database", "destination", "projectRoot"} on stdin (back up after the auth backup)\n'
  + 'urlcode-audit restore  JSON {"backup", "destination", "projectRoot"} on stdin (restores to a new path only)\n'
  + 'Paths are absolute. list prints one page of at most 100 events; pass its "next" back as query.after for the next page.\n';

async function input(): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const part of process.stdin) {
    const bytes = Buffer.from(part as Uint8Array);
    size += bytes.length;
    if (size > 65536) throw new Error('Input exceeds 64 KiB');
    chunks.push(bytes);
  }
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Input must be a JSON object');
  return value as Record<string, unknown>;
}
function path(value: unknown, name: string): string {
  if (typeof value !== 'string' || !isAbsolute(value)) throw new Error(`${name} must be an absolute path`);
  return value;
}
function only(data: Record<string, unknown>, keys: readonly string[]): void {
  const extra = Object.keys(data).find(key => !keys.includes(key));
  if (extra !== undefined) throw new Error('Unknown input field');
}

try {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { help: { type: 'boolean' } } });
  const command = positionals[0];
  if (values.help || !command) process.stdout.write(usage);
  else {
    if (positionals.length !== 1 || !['list', 'backup', 'restore'].includes(command)) throw new Error('Unknown command');
    const data = await input();
    let output: unknown;
    if (command === 'list') {
      only(data, ['database', 'query']);
      const query = validateAuditQuery(data.query ?? {});
      const reader = await openAuditReader(path(data.database, 'database'));
      try { output = reader.query(query); } finally { reader.close(); }
    }
    else if (command === 'backup') {
      only(data, ['database', 'destination', 'projectRoot']);
      output = await createBackup({ database: path(data.database, 'database'), destination: path(data.destination, 'destination'), projectRoot: path(data.projectRoot, 'projectRoot') });
    }
    else {
      only(data, ['backup', 'destination', 'projectRoot']);
      output = await restoreBackup({ backup: path(data.backup, 'backup'), destination: path(data.destination, 'destination'), projectRoot: path(data.projectRoot, 'projectRoot') });
    }
    process.stdout.write(`${JSON.stringify(output)}\n`);
  }
} catch (error) {
  process.stderr.write(`urlcode-audit: ${error instanceof Error ? error.message : 'failed'}\n`);
  process.exitCode = 1;
}
