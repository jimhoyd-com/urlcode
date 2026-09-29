// One serving process for the multi-process tests in auth.test.ts: `serve-child.ts <project> <database> <sha256> [settings JSON]`.
// Prints {"port": n} once listening and closes the server (and so its SQLite handle) on SIGTERM or a closed stdin.
import { startServer } from '@jimhoyd/urlcode';
import { createAuthExtension } from '../src/index.ts';

const [project, database, projectSha256, settings = '{}'] = process.argv.slice(2) as [string, string, string, string?];
const server = await startServer({ project, origin: 'http://localhost:8123', port: 0, log: () => {}, extensions: [createAuthExtension({ projectSha256, database, secret: 's'.repeat(40), ...JSON.parse(settings) as object })] });
process.stdout.write(JSON.stringify({ port: server.address.port }) + '\n');
let closing = false;
const close = (): void => { if (!closing) { closing = true; void server.close().then(() => process.exit(0)); } };
process.on('SIGTERM', close);
process.stdin.on('end', close).resume();
