import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import type { SpawnSyncOptionsWithStringEncoding } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** Invoke npm's JavaScript entry point on Windows, without .cmd shell quoting. */
export function npmCommand(args: string[], options: {
  platform?: NodeJS.Platform;
  execPath?: string;
  npmExecPath?: string;
  exists?: (path: string) => boolean;
} = {}): { command: string; args: string[] } {
  const execPath = options.execPath ?? process.execPath;
  const npmPath = options.npmExecPath ?? process.env.npm_execpath;
  if (npmPath) return { command: execPath, args: [npmPath, ...args] };
  if ((options.platform ?? process.platform) !== 'win32') return { command: 'npm', args };
  const adjacent = join(dirname(execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  assert((options.exists ?? existsSync)(adjacent), 'Cannot locate npm-cli.js. Run this helper through npm run so npm_execpath is available.');
  return { command: execPath, args: [adjacent, ...args] };
}

/**
 * Settings forced on every npm a test or script runs synchronously (#1130): no update check, funding or audit request
 * and no progress output, so nothing but the command itself is left for the child to finish before it exits.
 */
export const quietNpmEnv: Readonly<Record<string, string>> = {
  npm_config_update_notifier: 'false',
  npm_config_fund: 'false',
  npm_config_audit: 'false',
  npm_config_progress: 'false',
};

export interface NpmSyncOptions {
  cwd: string;
  /** The child's whole environment before the quiet settings are layered over it; defaults to this process's. */
  env?: NodeJS.ProcessEnv;
  timeoutMs: number;
}

/**
 * The exact spawn of one synchronous npm run: npm's JavaScript entry under this Node (never npm.cmd through a shell,
 * whose cmd.exe wrapper can outlive a timeout kill), no stdin to hold open or read, and no console window on Windows.
 */
export function npmSpawn(args: string[], options: NpmSyncOptions & Parameters<typeof npmCommand>[1]): {
  command: string; args: string[]; options: SpawnSyncOptionsWithStringEncoding;
} {
  const { cwd, env = process.env, timeoutMs, ...locate } = options;
  const command = npmCommand(args, locate);
  return {
    ...command,
    options: {
      cwd, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'], env: { ...env, ...quietNpmEnv },
    },
  };
}

export interface NpmRun {
  command: string; args: string[]; cwd: string;
  status: number | null; signal: NodeJS.Signals | null; timedOut: boolean;
  elapsedMs: number; timeoutMs: number; stdout: string; stderr: string; error?: string;
}

/** Runs npm once, synchronously, and records what a failure needs to be diagnosed: signal, timeout and elapsed time. */
export function runNpmSync(args: string[], options: NpmSyncOptions): NpmRun {
  const spawn = npmSpawn(args, options);
  const started = performance.now();
  const result = spawnSync(spawn.command, spawn.args, spawn.options);
  const elapsedMs = Math.round(performance.now() - started);
  const code = (result.error as NodeJS.ErrnoException | undefined)?.code;
  return {
    command: spawn.command, args: spawn.args, cwd: options.cwd, status: result.status, signal: result.signal,
    timedOut: code === 'ETIMEDOUT', elapsedMs, timeoutMs: options.timeoutMs,
    stdout: result.stdout ?? '', stderr: result.stderr ?? '', ...(result.error ? { error: result.error.message } : {}),
  };
}

const tail = (text: string, lines = 20): string => {
  const kept = text.trimEnd().split('\n');
  return kept.length > lines ? [`... [${kept.length - lines} earlier lines]`, ...kept.slice(-lines)].join('\n') : kept.join('\n');
};

/** One message naming the command, how it ended, how long it took against its limit, and the end of both streams. */
export function describeNpmRun(run: NpmRun): string {
  return [
    `${JSON.stringify([run.command, ...run.args])} in ${run.cwd}`,
    `exited with status ${run.status}, signal ${run.signal}, timedOut ${run.timedOut} after ${run.elapsedMs} ms (timeout ${run.timeoutMs} ms)`,
    ...(run.error ? [`spawn error: ${run.error}`] : []),
    `stderr (tail):\n${tail(run.stderr) || '(empty)'}`,
    `stdout (tail):\n${tail(run.stdout) || '(empty)'}`,
  ].join('\n');
}

export function assertNpmSucceeded(run: NpmRun): asserts run is NpmRun & { status: 0 } {
  assert.equal(run.status, 0, describeNpmRun(run));
}
