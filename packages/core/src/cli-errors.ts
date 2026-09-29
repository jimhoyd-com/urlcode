import { closestKey } from './config.ts';
import type { ErrorDetails } from './errors.ts';

// Name the bound host and port (from the error, never user text) and a next step. Values are validated, not echoed.
export function addressInUseMessage(error: unknown): string {
  const { address,port } = error as { address?: unknown; port?: unknown };
  const where = typeof port === 'number' && Number.isInteger(port) && port > 0 && port < 65536 ? `Port ${port}${typeof address === 'string' && /^[0-9A-Fa-f:.]{2,45}$/.test(address) ? ` on ${address}` : ''}` : 'The port';
  return `${where} is already in use; pick another with --port N, or stop the process using it`;
}

/** Turn parseArgs failures into safe, useful CLI errors without echoing arbitrary argument text. */
export function argumentError(code: string, message: string, optionNames: string[]): { message: string; details: ErrorDetails } | undefined {
  const option = /'(--?[A-Za-z0-9][A-Za-z0-9-]{0,40})(?: <value>)?'/.exec(message)?.[1];
  if (code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION') {
    if (!option) return { message:'Unknown option; use --help', details:{ code:'unknown-option' } };
    const close = closestKey(option.replace(/^-+/, ''), optionNames);
    return { message:`Unknown option ${option}${close ? `; did you mean --${close}?` : ''} (use --help for the options)`, details:{ code:'unknown-option' } };
  }
  if (code === 'ERR_PARSE_ARGS_INVALID_OPTION_VALUE' && option) return { message:`Option ${option} needs a value, as in ${option} <value>; to pass an argument that starts with -, put it after a -- separator`, details:{ code:'missing-option-value' } };
  return undefined;
}

export const systemErrorMessages: Record<string, string | undefined> = { EEXIST:'Destination or edit lock already exists', ENOENT:'Required file or directory not found', EADDRINUSE:'Port is already in use', EACCES:'Permission denied', EPERM:'Operation not permitted (EPERM): the operating system or a sandbox policy refused a file operation; use a location this process is allowed to write to', EROFS:'Read-only file system (EROFS): use a writable location' };

/**
 * Environment fallbacks for the operator context flags (#834). An npm script runs under sh on POSIX and cmd on
 * Windows, so a generated script cannot portably expand a variable; the CLI reads it instead. An explicit flag always
 * wins, and an empty variable counts as unset. Nothing here creates, discovers or repins a policy.
 */
export const contextEnv = { origin: 'URLCODE_ORIGIN', policy: 'URLCODE_POLICY' } as const;
export function contextFromEnv(name: keyof typeof contextEnv, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const value = env[contextEnv[name]];
  return value === undefined || value === '' ? undefined : value;
}
/** Placeholders a refusal prints for context the operator has to supply; never a guessed value. */
export const contextPlaceholders = { origin: '<https://your.site>', policy: '<operator/policy.json>' } as const;
/** Commands that activate extensions, so they need the canonical origin as well as the reviewed revision. */
const activatingCommands = new Set(['dev', 'serve', 'validate', 'test', 'routes', 'audit', 'benchmark', 'mcp']);
/** Refusals that name missing operator context; the CLI answers each with one complete command. */
export const missingContextCodes: ReadonlySet<string> = new Set(['origin-required', 'revision-pin-required']);
type ContextName = keyof typeof contextEnv;
/**
 * One complete command for a refusal caused by missing operator context: the actual invocation, unchanged, with an
 * explicit placeholder appended for each value that is still missing. The origin is missing when the command
 * activates extensions without one; the policy when neither `--policy` nor `PROJECT_SHA256` pins the revision.
 */
export function missingContextCommand(cli: string, argv: readonly string[], supplied: { origin?: string | undefined; policy?: string | undefined; revision?: string | undefined }, quote: (word: string) => string): { command: string; missing: ContextName[] } {
  const command = argv.find(word => !word.startsWith('-'));
  const missing: ContextName[] = [];
  if (supplied.origin === undefined && command !== undefined && activatingCommands.has(command)) missing.push('origin');
  if (supplied.policy === undefined && !supplied.revision) missing.push('policy');
  const words = [...argv.map(quote), ...missing.flatMap(name => [`--${name}`, contextPlaceholders[name]])];
  return { command: `${cli} ${words.join(' ')}`, missing };
}
/** The refusal text: the original reason, the one command, and what each placeholder stands for. */
export function missingContextMessage(reason: string, command: string, missing: readonly ContextName[]): string {
  if (!missing.length) return reason;
  const explained = missing.map(name => name === 'origin'
    ? `${contextPlaceholders.origin} is the public https origin the site is served from`
    : `${contextPlaceholders.policy} is the operator's reviewed policy, the output of \`urlcode permissions\` reviewed and saved outside app/ (nothing creates or repins it for you)`);
  return `${reason}. Run: ${command} where ${explained.join('; ')}. Without the flags, the CLI (and so every npm script) reads ${missing.map(name => contextEnv[name]).join(' and ')}`;
}
