import assert from 'node:assert/strict';
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
