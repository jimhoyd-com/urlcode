import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Agent } from 'node:http';
import { startServer } from './server.ts';
import type { Server, ServerOptions } from './server.ts';
import { readFixtures, runFixtures } from './readiness.ts';
import type { RestartableApp } from './readiness.ts';
import type { LogFn } from './types.ts';

export interface ProjectTestOptions { extensions?: ServerOptions['extensions']; plugins?: ServerOptions['plugins']; log?: LogFn | undefined; permissions?: ServerOptions['permissions']; origin?: string | undefined }
export interface ProjectTestResult { total: number; failed: number }

/**
 * A server that fixture `restart` steps can close and start again on the same project and the
 * same data directory. The data directory is fresh and empty, offered to the project as
 * `URLCODE_DATA_DIR`, and removed by `close()`. `restart()` gets a new port; read `address` after it.
 */
export async function startRestartable(options: ServerOptions): Promise<RestartableApp & { close(): Promise<void> }> {
  const dataDir = await mkdtemp(join(tmpdir(), 'urlcode-data-'));
  let current: Server | undefined;
  try { current = await startServer({ ...options, dataDir }); } catch (error) { await rm(dataDir, { recursive: true, force: true }); throw error; }
  const running = (): Server => { if (!current) throw new Error('Server is not running'); return current; };
  return {
    get address() { return running().address; }, get root() { return running().root; }, testPlan: () => running().testPlan(),
    async restart() { const old = running(); current = undefined; await old.close(); current = await startServer({ ...options, dataDir }); },
    async close() { try { await current?.close(); } finally { current = undefined; await rm(dataDir, { recursive: true, force: true }); } },
  };
}

export async function runProjectTests(project: string, { log = () => {}, permissions, origin, extensions, plugins }: ProjectTestOptions = {}): Promise<ProjectTestResult> {
  const root = await realpath(project), fixtures = await readFixtures(root);
  const app = await startRestartable({ project, port: 0, local: true, log, permissions, origin, extensions, plugins });
  const agent = new Agent({keepAlive:true,maxSockets:1}); let failed = 0, total = 0;
  try {
    // Only case number, pass and status are logged: never a path, header or body, which may hold captured values.
    await runFixtures(fixtures, { app, agent, restart: () => app.restart() }, ({ case: n, result }) => {
      total++;
      if(!result.pass)failed++;
      log({event:'test',case:n,pass:result.pass,status:result.status});
    });
  } finally {agent.destroy();await app.close();}
  return {total,failed};
}
