import { lstat, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Agent } from 'node:http';
import { startServer } from './server.ts';
import type { Server, ServerOptions } from './server.ts';
import { readFixtures, runFixtures } from './readiness.ts';
import type { RestartableApp } from './readiness.ts';
import type { LogFn } from './types.ts';
import { ConfigError } from './errors.ts';
import { safeFile } from './config.ts';
import { isRecord } from './object-guards.ts';
import { seedFile } from './extensions.ts';
import { SignalRecorder } from './signal-recorder.ts';

export interface ProjectTestOptions { extensions?: ServerOptions['extensions']; plugins?: ServerOptions['plugins']; log?: LogFn | undefined; permissions?: ServerOptions['permissions']; origin?: string | undefined; aliasOrigins?: ServerOptions['aliasOrigins'] }
export interface ProjectTestResult { total: number; failed: number }

const MAX_SEED_BYTES = 1024 * 1024;
/**
 * The project's declared test seed, `tests/seed.json` (RIM-EXT-HERMETIC-001): a JSON object keyed by extension name,
 * each entry that extension's seed (its registration's `seedSchema` checks the shape at activation). Undefined when the
 * project has none.
 */
export async function readSeed(project: string): Promise<Record<string, unknown> | undefined> {
  const root = await realpath(project);
  try { await lstat(join(root, seedFile)); }
  catch (error) { if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined; throw error; }
  const details = { code: 'invalid-seed', file: seedFile };
  const bytes = await readFile(await safeFile(root, seedFile));
  if (bytes.length > MAX_SEED_BYTES) throw new ConfigError(`${seedFile} exceeds 1 MiB`, details);
  let seed: unknown;
  try { seed = JSON.parse(bytes.toString('utf8')); } catch { throw new ConfigError(`${seedFile} is not valid JSON`, details); }
  if (!isRecord(seed) || Array.isArray(seed)) throw new ConfigError(`${seedFile} must be an object keyed by extension name, such as {"auth": {"users": [...]}}`, details);
  for (const name of Object.keys(seed)) if (!/^[a-z][a-z0-9-]{0,63}$/.test(name)) throw new ConfigError(`${seedFile} key ${JSON.stringify(name.slice(0, 64))} is not an extension name`, { ...details, pointer: `/${name}` });
  return seed;
}

/**
 * A server that fixture `restart` steps can close and start again on the same project and the
 * same data directory. The data directory is fresh and empty, offered to the project as
 * `URLCODE_DATA_DIR`, and removed by `close()`; on a filesystem where it cannot be created, none is offered. `restart()` gets a new port; read `address` after it.
 * The first start hands the project's `tests/seed.json` (when it has one) to the extensions it names; a restart never
 * seeds again, so the data the fixtures wrote survives it (RIM-EXT-HERMETIC-001).
 */
export async function startRestartable(options: ServerOptions): Promise<RestartableApp & { close(): Promise<void> }> {
  const seed = await readSeed(options.project ?? '.');
  // A read-only filesystem (a locked-down container) has nowhere to put it: run without one instead of
  // failing every test run. A project that reads `URLCODE_DATA_DIR` then refuses to activate, as it would unset.
  const dataDir = await mkdtemp(join(tmpdir(), 'urlcode-data-')).catch(() => undefined);
  const cleanup = async (): Promise<void> => { if (dataDir !== undefined) await rm(dataDir, { recursive: true, force: true }); };
  let current: Server | undefined;
  try { current = await startServer({ ...options, dataDir, seed }); } catch (error) { await cleanup(); throw error; }
  const running = (): Server => { if (!current) throw new Error('Server is not running'); return current; };
  return {
    get address() { return running().address; }, get root() { return running().root; }, get origin() { return running().origin; }, testPlan: () => running().testPlan(),
    async restart() { const old = running(); current = undefined; await old.close(); current = await startServer({ ...options, dataDir, seed: undefined }); },
    async close() { try { await current?.close(); } finally { current = undefined; await cleanup(); } },
  };
}

export async function runProjectTests(project: string, { log = () => {}, permissions, origin, aliasOrigins, extensions, plugins }: ProjectTestOptions = {}): Promise<ProjectTestResult> {
  // A newly initialized project has no behavior yet, so it intentionally has no
  // fixture file. Once an application has routes, its author adds this file.
  const root = await realpath(project), fixtures = await readFixtures(root, true);
  // Signals are recorded in process, never delivered, so fixtures can assert them with expectSignals.
  const signals = new SignalRecorder();
  const app = await startRestartable({ project, port: 0, local: true, log, permissions, origin, aliasOrigins, extensions, plugins, signalRecorder: signals });
  const agent = new Agent({keepAlive:true,maxSockets:1}); let failed = 0, total = 0;
  try {
    if (!fixtures.length) {
      // Zero cases is a false green once there is behavior to test; a bare scaffold (no active route) is still a pass.
      const active = app.testPlan().inventory.filter(route => route.state === 'active').length;
      if (active) throw new ConfigError(`No request fixtures: tests/requests.json is missing or empty, but the project has ${active} active route${active === 1 ? '' : 's'}. Add a case per route and method (format: schemas/requests.schema.json)`, { code: 'no-test-cases', file: 'tests/requests.json' });
      log({event:'warning',code:'no-test-cases',message:'No request fixtures yet; add tests/requests.json with the first route'});
    }
    // A failing case names the method and the path as sent (captured values filled in; `fixturePath` is the path as
    // written when that differs) and each failed assertion (expected and actual, shortened). A secret capture
    // (`secret: true`, any cookie) is put back as {{name}} and a cookie value as <cookie NAME> wherever it appears.
    // A passing case logs only its number and status.
    await runFixtures(fixtures, { app, agent, signals, restart: () => app.restart() }, ({ case: n, original, shown, result }) => {
      total++;
      if(!result.pass)failed++;
      log(result.pass ? {event:'test',case:n,pass:true,status:result.status}
        : {event:'test',case:n,pass:false,method:original.method ?? 'GET',path:shown,...(shown === original.path ? {} : {fixturePath:original.path}),status:result.status,...(result.error ? {error:result.error} : {}),...(result.mismatches?.length ? {failures:result.mismatches} : {})});
    });
  } finally {agent.destroy();await app.close();}
  return {total,failed};
}
