// The Anthropic adapter: the arm's prompt becomes a workspace through an
// agentic loop over the Messages API. It speaks HTTP with Node's global fetch
// (no new dependency), gives the model a bounded tool set that never leaves
// the workspace, reports the API's own usage fields, and stops at hard caps
// on turns, wall time and bytes written. README.md, "Running against a
// model", says how to configure it; test/agent-benchmark.test.ts drives it
// with a fake fetch and a fake command runner, so no test touches the network.
import { spawn } from 'node:child_process';
import { mkdir, readdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { ConfigError } from '../../../src/errors.ts';
import type { AdapterRequest, AdapterResult, Arm, ModelAdapter } from '../adapters.ts';

/** The model the workflow and the CLI use when URLCODE_BENCHMARK_MODEL is unset. */
export const defaultModel = 'claude-opus-5';
const apiVersion = '2023-06-01';
/** Server-side refusal fallbacks: a declined request is re-run on Anthropic's recommended substitute inside the same call. */
const fallbackBeta = 'server-side-fallback-2026-07-01';

export interface AnthropicAdapterOptions {
  apiKey: string;
  model?: string | undefined;
  /** The core checkout that supplies the `urlcode` CLI and the reference material. */
  core?: string | undefined;
  baseUrl?: string | undefined;
  /** Injected for tests: replays canned responses instead of calling the API. */
  fetch?: typeof fetch | undefined;
  /** Injected for tests: runs an allowed command in the workspace. */
  exec?: CommandRunner | undefined;
  sleep?: ((ms: number) => Promise<void>) | undefined;
  now?: (() => number) | undefined;
  /** Hard caps. A run that reaches one stops with an error the harness records as a generation failure. */
  maxTurns?: number | undefined;
  maxWallMs?: number | undefined;
  maxBytes?: number | undefined;
  maxRetries?: number | undefined;
  maxTokens?: number | undefined;
  commandTimeoutMs?: number | undefined;
  /** Send `fallbacks: "default"` (on by default). */
  fallbacks?: boolean | undefined;
}

export type CommandRunner = (command: { file: string; args: string[]; cwd: string; env: Record<string, string>; timeoutMs: number }) => Promise<{ code: number; output: string }>;

// --- Messages API shapes (only the fields this adapter reads or writes) ---
interface TextBlock { type: 'text'; text: string }
interface ToolUseBlock { type: 'tool_use'; id: string; name: string; input: unknown }
interface ToolResultBlock { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean }
type ContentBlock = TextBlock | ToolUseBlock | { type: string; [key: string]: unknown };
interface MessageParam { role: 'user' | 'assistant'; content: string | (ContentBlock | ToolResultBlock)[] }
interface Usage { input_tokens?: number; output_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number }
interface MessageResponse { model?: string; content: ContentBlock[]; stop_reason: string; stop_details?: { category?: string | null; explanation?: string } | null; usage?: Usage }
interface ToolDefinition { name: string; description: string; input_schema: Record<string, unknown> }

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown, what: string): string => { if (typeof value !== 'string') throw new Error(`${what} must be text`); return value; };

/** Tools the model gets. Files stay under the workspace; commands come from a per-arm allow-list. */
function toolDefinitions(arm: Arm): ToolDefinition[] {
  const commands = arm === 'urlcode'
    ? 'Only `urlcode <validate|test|context|routes|explain|audit|permissions> [options]` is allowed; it runs against the workspace project.'
    : 'Only `node <file> [args]` and `npm <install|ci|test|run> [args]` are allowed; they run in the workspace with a timeout.';
  return [
    { name: 'list_files', description: 'List every file in the workspace, as workspace-relative paths.', input_schema: { type: 'object', properties: {}, additionalProperties: false } },
    { name: 'read_file', description: 'Read a text file from the workspace.', input_schema: { type: 'object', properties: { path: { type: 'string', description: 'Workspace-relative path' } }, required: ['path'], additionalProperties: false } },
    { name: 'write_file', description: 'Create or replace a text file in the workspace, creating directories as needed.', input_schema: { type: 'object', properties: { path: { type: 'string', description: 'Workspace-relative path' }, content: { type: 'string' } }, required: ['path','content'], additionalProperties: false } },
    { name: 'run_command', description: `Run a command in the workspace and return its exit code and output. ${commands}`, input_schema: { type: 'object', properties: { command: { type: 'string', description: 'The command line, for example "urlcode test"' } }, required: ['command'], additionalProperties: false } },
    { name: 'finish', description: 'Report that the task is done. Call this exactly once, last.', input_schema: { type: 'object', properties: {
      start: { type: 'string', description: 'Conventional arm only: the command that serves the application on $PORT from the workspace' },
      modules: { type: 'array', items: { type: 'string' }, description: 'Workspace-relative files or directories beyond functions/ that are the application itself (the idea), not plumbing' },
      summary: { type: 'string', description: 'One paragraph on what was built' },
    }, additionalProperties: false } },
  ];
}

/** The reference material the URLCode arm is promised: the skill, the recipes and the YAML reference. The conventional arm gets nothing URLCode-specific. */
async function systemPrompt(core: string, arm: Arm): Promise<{ type: 'text'; text: string; cache_control?: { type: 'ephemeral' } }[]> {
  const rules = 'You are an autonomous software agent working in an empty workspace through the tools provided. Use the tools for every file you create and every command you run; text outside tool calls is not recorded. Never write outside the workspace, never ask questions, and call `finish` when the work is complete.';
  if (arm !== 'urlcode') return [{ type: 'text', text: rules, cache_control: { type: 'ephemeral' } }];
  const sections = await Promise.all([['skills','urlcode','SKILL.md'], ['docs','RECIPES.md'], ['docs','YAML-REFERENCE.md']].map(async parts => `<reference path="${parts.join('/')}">\n${await readFile(join(core, ...parts), 'utf8')}\n</reference>`));
  return [{ type: 'text', text: `${rules}\n\nThe URLCode reference material follows. \`urlcode context\` is available through run_command.` }, { type: 'text', text: sections.join('\n\n'), cache_control: { type: 'ephemeral' } }];
}

/** Split a command line on whitespace; quotes are not interpreted, which keeps the allow-list a plain word check. */
const words = (command: string): string[] => command.trim().split(/\s+/).filter(Boolean);
const armAllows = (arm: Arm, argv: readonly string[]): string | undefined => {
  const [program, sub] = argv;
  if (arm === 'urlcode') return program === 'urlcode' && sub !== undefined && ['validate','test','context','routes','explain','audit','permissions'].includes(sub) ? undefined : 'only urlcode validate/test/context/routes/explain/audit/permissions is allowed';
  if (program === 'node') return argv.length > 1 ? undefined : 'node needs a file';
  if (program === 'npm') return sub !== undefined && ['install','ci','test','run'].includes(sub) ? undefined : 'only npm install/ci/test/run is allowed';
  return 'only node and npm are allowed';
};
const dangerous = (argv: readonly string[]): boolean => argv.some(arg => /^--(?:host-file|project|eval|require|import|loader|experimental-permission)/.test(arg) || arg.startsWith('-e') || arg === '-p' || /^(?:\/|\.\.|[A-Za-z]:)/.test(arg) || arg.includes('..'));

const defaultExec: CommandRunner = ({ file, args, cwd, env, timeoutMs }) => new Promise(done => {
  const child = spawn(file, args, { cwd, env, stdio: ['ignore','pipe','pipe'] });
  let output = '';
  const collect = (chunk: string) => { if (output.length < 32768) output += chunk; };
  child.stdout.setEncoding('utf8').on('data', collect); child.stderr.setEncoding('utf8').on('data', collect);
  const timer = setTimeout(() => { child.kill('SIGKILL'); output += `\n[killed after ${timeoutMs} ms]`; }, timeoutMs);
  child.on('error', error => { clearTimeout(timer); done({ code: -1, output: `${output}\n${error.message}` }); });
  child.on('exit', code => { clearTimeout(timer); done({ code: code ?? -1, output }); });
});

export function anthropicAdapter(options: AnthropicAdapterOptions): ModelAdapter {
  const model = options.model ?? defaultModel;
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(model)) throw new ConfigError(`Model id "${model}" must be a plain name`);
  if (!options.apiKey) throw new ConfigError('The anthropic adapter needs ANTHROPIC_API_KEY');
  const core = options.core ?? resolve(import.meta.dirname, '..', '..', '..');
  const call = options.fetch ?? fetch, exec = options.exec ?? defaultExec, now = options.now ?? (() => performance.now());
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>(done => setTimeout(done, ms)));
  const caps = { turns: options.maxTurns ?? 40, wallMs: options.maxWallMs ?? 20 * 60_000, bytes: options.maxBytes ?? 512 * 1024, retries: options.maxRetries ?? 3, commandMs: options.commandTimeoutMs ?? 120_000 };
  const url = `${(options.baseUrl ?? 'https://api.anthropic.com').replace(/\/$/, '')}/v1/messages`;
  const fallbacks = options.fallbacks ?? true;

  return {
    name: model,
    async run({ arm, prompt, workspace }: AdapterRequest): Promise<AdapterResult> {
      const root = await realpath(workspace), began = now();
      const written = new Set<string>(), commands: string[] = [], served = new Set<string>();
      let tokensIn = 0, tokensOut = 0, turns = 0, retries = 0, bytes = 0, finished: { start: string | undefined; modules: string[]; summary: string | undefined } | undefined;
      const tools = toolDefinitions(arm), system = await systemPrompt(core, arm);
      const messages: MessageParam[] = [{ role: 'user', content: prompt }];

      /** A workspace-relative path that stays inside the workspace, including through symlinks in existing parents. */
      const inside = async (path: string): Promise<{ rel: string; abs: string }> => {
        const rel = relative(root, resolve(root, path));
        if (!rel || rel.startsWith('..') || rel.startsWith(sep) || /^[A-Za-z]:/.test(rel)) throw new Error(`path ${JSON.stringify(path)} leaves the workspace`);
        let parent = dirname(resolve(root, rel));
        while (!(await readdir(parent).then(() => true, () => false))) parent = dirname(parent);
        const real = await realpath(parent);
        if (real !== root && !real.startsWith(root + sep)) throw new Error(`path ${JSON.stringify(path)} leaves the workspace through a link`);
        return { rel: rel.split(sep).join('/'), abs: resolve(root, rel) };
      };
      const listFiles = async (dir: string): Promise<string[]> => (await Promise.all((await readdir(dir, { withFileTypes: true })).map(async entry => {
        const path = join(dir, entry.name);
        if (entry.name === 'node_modules' || entry.name === '.git') return [];
        return entry.isDirectory() ? listFiles(path) : [relative(root, path).split(sep).join('/')];
      }))).flat().sort();

      const runTool = async (name: string, input: unknown): Promise<string> => {
        const args = isRecord(input) ? input : {};
        switch (name) {
          case 'list_files': return (await listFiles(root)).join('\n') || '(empty)';
          case 'read_file': { const { abs } = await inside(text(args.path, 'path')); return await readFile(abs, 'utf8'); }
          case 'write_file': {
            const { rel, abs } = await inside(text(args.path, 'path')), content = text(args.content, 'content');
            bytes += Buffer.byteLength(content);
            if (bytes > caps.bytes) throw new Error(`byte cap of ${caps.bytes} reached`);
            await mkdir(dirname(abs), { recursive: true }); await writeFile(abs, content); written.add(rel);
            return `wrote ${rel} (${Buffer.byteLength(content)} bytes)`;
          }
          case 'run_command': {
            const line = text(args.command, 'command'), argv = words(line);
            const refused = armAllows(arm, argv) ?? (dangerous(argv.slice(1)) ? 'arguments may not name paths outside the workspace or load code' : undefined);
            if (refused) throw new Error(`command not allowed: ${refused}`);
            commands.push(line);
            const env: Record<string, string> = { PATH: process.env.PATH ?? '', HOME: root, NODE_ENV: 'development' };
            const invocation = argv[0] === 'urlcode'
              ? { file: process.execPath, args: ['--conditions=development', join(core, 'src', 'cli.ts'), ...argv.slice(1), '--project', root] }
              : { file: argv[0]!, args: argv.slice(1) };
            const result = await exec({ ...invocation, cwd: root, env, timeoutMs: caps.commandMs });
            if (argv[0] === 'urlcode') for (const file of await listFiles(root)) if (!file.startsWith('.urlcode/')) written.add(file);
            return `exit ${result.code}\n${result.output.slice(-16384)}`;
          }
          case 'finish': {
            const modules = Array.isArray(args.modules) ? args.modules.filter((m): m is string => typeof m === 'string') : [];
            finished = { start: typeof args.start === 'string' ? args.start : undefined, modules, summary: typeof args.summary === 'string' ? args.summary : undefined };
            return 'recorded';
          }
          default: throw new Error(`unknown tool ${name}`);
        }
      };

      const request = async (): Promise<MessageResponse> => {
        const body: Record<string, unknown> = { model, max_tokens: options.maxTokens ?? 16000, system, tools, messages, ...(fallbacks ? { fallbacks: 'default' } : {}) };
        const headers: Record<string, string> = { 'content-type': 'application/json', 'x-api-key': options.apiKey, 'anthropic-version': apiVersion, ...(fallbacks ? { 'anthropic-beta': fallbackBeta } : {}) };
        for (let attempt = 0; ; attempt++) {
          let response: Response | undefined, failure: string | undefined;
          try { response = await call(url, { method: 'POST', headers, body: JSON.stringify(body) }); } catch (error) { failure = error instanceof Error ? error.message : String(error); }
          if (response?.ok) return await response.json() as MessageResponse;
          const status = response?.status ?? 0, detail = response ? (await response.text()).slice(0, 500) : failure ?? 'request failed';
          const retryable = status === 0 || status === 408 || status === 409 || status === 429 || status >= 500;
          if (!retryable || attempt >= caps.retries) throw new Error(`Messages API ${status || 'network'} error: ${detail}`);
          retries++;
          const after = Number(response?.headers.get('retry-after'));
          await sleep(Number.isFinite(after) && after > 0 ? after * 1000 : 1000 * 2 ** attempt);
        }
      };

      while (finished === undefined) {
        if (turns >= caps.turns) throw new Error(`turn cap of ${caps.turns} reached`);
        if (now() - began > caps.wallMs) throw new Error(`wall-time cap of ${caps.wallMs} ms reached`);
        const response = await request();
        turns++;
        const usage = response.usage ?? {};
        tokensIn += (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0);
        tokensOut += usage.output_tokens ?? 0;
        if (response.model) served.add(response.model);
        messages.push({ role: 'assistant', content: response.content });
        if (response.stop_reason === 'refusal') throw new Error(`model refused (${response.stop_details?.category ?? 'no category'}): ${response.stop_details?.explanation ?? ''}`.trim());
        const uses = response.content.filter((block): block is ToolUseBlock => block.type === 'tool_use');
        if (uses.length === 0) {
          if (response.stop_reason === 'pause_turn') continue;
          if (response.stop_reason === 'max_tokens') { messages.push({ role: 'user', content: 'The response was cut off at max_tokens. Continue with tool calls; write shorter files if needed.' }); continue; }
          messages.push({ role: 'user', content: 'Continue using the tools, and call `finish` when the work is complete.' });
          continue;
        }
        const results: ToolResultBlock[] = [];
        for (const use of uses) {
          try { results.push({ type: 'tool_result', tool_use_id: use.id, content: await runTool(use.name, use.input) }); }
          catch (error) {
            if (error instanceof Error && /cap of .* reached/.test(error.message)) throw error;
            results.push({ type: 'tool_result', tool_use_id: use.id, content: error instanceof Error ? error.message : String(error), is_error: true });
          }
        }
        messages.push({ role: 'user', content: results });
      }
      const notes = [`served by ${[...served].join(', ') || model}`, finished.summary ? `summary: ${finished.summary}` : ''].filter(Boolean).join('\n');
      return { tokensIn, tokensOut, turns, retries, files: [...written].sort(), start: finished.start, modules: finished.modules, commands, notes };
    },
  };
}

/** The adapter as the runner configures it: the key from the environment, the model from URLCODE_BENCHMARK_MODEL. */
export function anthropicFromEnvironment(env: NodeJS.ProcessEnv = process.env): ModelAdapter {
  const apiKey = env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new ConfigError('The anthropic adapter needs ANTHROPIC_API_KEY in the environment');
  return anthropicAdapter({ apiKey, model: env.URLCODE_BENCHMARK_MODEL || undefined, baseUrl: env.ANTHROPIC_BASE_URL || undefined });
}
