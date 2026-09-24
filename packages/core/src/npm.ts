import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { ConfigError } from './errors.ts';

/**
 * The one place core runs npm. Site commands (`extensions add|remove`, `artifacts add|remove`, `upgrade`) install
 * through it with `--ignore-scripts`, so no package lifecycle script ever runs. `URLCODE_NPM` replaces the binary
 * (a JavaScript file is run with this Node), which is how tests substitute a recording fake.
 */
function command(args: readonly string[]): { file: string; args: string[] } {
  const override = process.env.URLCODE_NPM;
  if (override) return ['.js', '.mjs', '.cjs', '.ts'].includes(extname(override)) ? { file: process.execPath, args: [override, ...args] } : { file: override, args: [...args] };
  if (process.platform !== 'win32') return { file: 'npm', args: [...args] };
  const cli = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  if (!existsSync(cli)) throw new ConfigError('Cannot locate npm next to this Node installation; install npm or set URLCODE_NPM');
  return { file: process.execPath, args: [cli, ...args] };
}

/** Runs npm in `cwd` and resolves its stdout; a non-zero exit rejects with npm's own stderr excerpt. */
export function runNpm(args: readonly string[], cwd: string): Promise<string> {
  const { file, args: argv } = command(args);
  return new Promise((resolve, reject) => {
    execFile(file, argv, { cwd, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 10 * 60 * 1000, env: { ...process.env, npm_config_fund: 'false', npm_config_audit: 'false', npm_config_update_notifier: 'false' } }, (error, stdout, stderr) => {
      if (!error) { resolve(stdout); return; }
      const excerpt = String(stderr || error.message).trim().split('\n').slice(-12).join('\n');
      reject(new ConfigError(`npm ${args.join(' ')} failed in ${cwd}:\n${excerpt}`));
    });
  });
}
