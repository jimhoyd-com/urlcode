import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Agent } from 'node:http';
import { startServer } from './server.ts';
import type { Server, ServerOptions } from './server.ts';
import { readFixtures, runFixtures } from './readiness.ts';
import type { RestartableApp } from './readiness.ts';
import type { LogFn } from './types.ts';
import { ConfigError } from './errors.ts';

export interface ProjectTestOptions { extensions?: ServerOptions['extensions']; plugins?: ServerOptions['plugins']; log?: LogFn | undefined; permissions?: ServerOptions['permissions']; origin?: string | undefined; aliasOrigins?: ServerOptions['aliasOrigins']; passkeyRpId?: ServerOptions['passkeyRpId'] }
export interface ProjectTestResult { total: number; failed: number }

/**
 * A server that fixture `restart` steps can close and start again on the same project and the
 * same data directory. The data directory is fresh and empty, offered to the project as
 * `URLCODE_DATA_DIR`, and removed by `close()`; on a filesystem where it cannot be created, none is offered. `restart()` gets a new port; read `address` after it.
 */
export async function startRestartable(options: ServerOptions): Promise<RestartableApp & { close(): Promise<void> }> {
  // A read-only filesystem (a locked-down container) has nowhere to put it: run without one instead of
  // failing every test run. A project that reads `URLCODE_DATA_DIR` then refuses to activate, as it would unset.
  const dataDir = await mkdtemp(join(tmpdir(), 'urlcode-data-')).catch(() => undefined);
  const cleanup = async (): Promise<void> => { if (dataDir !== undefined) await rm(dataDir, { recursive: true, force: true }); };
  let current: Server | undefined;
  try { current = await startServer({ ...options, dataDir }); } catch (error) { await cleanup(); throw error; }
  const running = (): Server => { if (!current) throw new Error('Server is not running'); return current; };
  return {
    get address() { return running().address; }, get root() { return running().root; }, testPlan: () => running().testPlan(),
    async restart() { const old = running(); current = undefined; await old.close(); current = await startServer({ ...options, dataDir }); },
    async close() { try { await current?.close(); } finally { current = undefined; await cleanup(); } },
  };
}

export async function runProjectTests(project: string, { log = () => {}, permissions, origin, aliasOrigins, passkeyRpId, extensions, plugins }: ProjectTestOptions = {}): Promise<ProjectTestResult> {
  // A newly initialized project has no behavior yet, so it intentionally has no
  // fixture file. Once an application has routes, its author adds this file.
  const root = await realpath(project), fixtures = await readFixtures(root, true);
  const app = await startRestartable({ project, port: 0, local: true, log, permissions, origin, aliasOrigins, passkeyRpId, extensions, plugins });
  const agent = new Agent({keepAlive:true,maxSockets:1}); let failed = 0, total = 0;
  try {
    if (!fixtures.length) {
      // Zero cases is a false green once there is behavior to test; a bare scaffold (no active route) is still a pass.
      const active = app.testPlan().inventory.filter(route => route.state === 'active').length;
      if (active) throw new ConfigError(`No request fixtures: tests/requests.json is missing or empty, but the project has ${active} active route${active === 1 ? '' : 's'}. Add a case per route and method (format: schemas/requests.schema.json)`, { code: 'no-test-cases', file: 'tests/requests.json' });
      log({event:'warning',code:'no-test-cases',message:'No request fixtures yet; add tests/requests.json with the first route'});
    }
    // A failing case names the fixture's own path and method as written and each failed assertion (expected and actual,
    // shortened, with captured values put back as {{name}}); a passing case logs only its number and status.
    await runFixtures(fixtures, { app, agent, restart: () => app.restart() }, ({ case: n, original, result }) => {
      total++;
      if(!result.pass)failed++;
      log(result.pass ? {event:'test',case:n,pass:true,status:result.status}
        : {event:'test',case:n,pass:false,method:original.method ?? 'GET',path:original.path,status:result.status,...(result.error ? {error:result.error} : {}),...(result.mismatches?.length ? {failures:result.mismatches} : {})});
    });
  } finally {agent.destroy();await app.close();}
  return {total,failed};
}
