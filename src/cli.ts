#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { initAdministration } from './scaffold.ts';
try {
    const { values, positionals } = parseArgs({ allowPositionals: true, options: { directory: { type: 'string' }, help: { type: 'boolean' } } });
    if (values.help || !positionals.length)
        process.stdout.write('urlcode-admin init --directory NEW_DIRECTORY\nCreates a private auth/admin operator host and route project. Review before activation.\n');
    else if (positionals.length === 1 && positionals[0] === 'init' && values.directory)
        process.stdout.write(JSON.stringify(await initAdministration(values.directory)) + '\n');
    else
        throw new Error('Invalid command');
}
catch {
    process.stderr.write('Admin initialization failed; provide a new directory with an existing parent.\n');
    process.exitCode = 1;
}
