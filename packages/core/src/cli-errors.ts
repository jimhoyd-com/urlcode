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

export const systemErrorMessages: Record<string, string | undefined> = { EEXIST:'Destination or edit lock already exists', ENOENT:'Required file or directory not found', EADDRINUSE:'Port is already in use', EACCES:'Permission denied' };
