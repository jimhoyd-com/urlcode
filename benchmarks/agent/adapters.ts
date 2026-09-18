// Model adapters: how an arm's prompt becomes a workspace. The runner is
// indifferent to what produced the files; it only needs the interface below.
// The stub below calls no API; adapters/anthropic.ts is the real one. README.md,
// "Adding a real adapter", says what a real one must and must not do.
import { cp, readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { ConfigError } from '../../src/errors.ts';
import { anthropicFromEnvironment } from './adapters/anthropic.ts';

export type Arm = 'conventional' | 'urlcode';
/** What the runner hands an adapter: the full prompt for the arm and an empty workspace to fill. */
export interface AdapterRequest { task: string; arm: Arm; prompt: string; workspace: string }
/** What an adapter reports. Counts are the model's own accounting for this run; the harness never estimates them. */
export interface AdapterResult {
  tokensIn: number; tokensOut: number; turns: number; retries: number;
  /** Workspace-relative paths the adapter wrote. The harness re-reads them for the code ratio. */
  files: string[];
  /** Conventional arm: the command that serves the application on `$PORT` from the workspace. */
  start?: string | undefined;
  /** Application modules beyond `functions/` the agent declares as the idea. */
  modules?: string[] | undefined;
  /** Commands the agent ran in the workspace, in order; the evals score `urlcode validate`/`urlcode test` from this list. */
  commands?: string[] | undefined;
  /** Free text the adapter wants stored with the run (a session id, a transcript path). */
  notes?: string | undefined;
}
export interface ModelAdapter { name: string; run(request: AdapterRequest): Promise<AdapterResult> }

interface StubAnswer { tokensIn?: number; tokensOut?: number; turns?: number; retries?: number; start?: string; modules?: string[]; commands?: string[]; files: string[] }

// The stub copies `answers/<task>/<arm>/` into the workspace. `answer.json`
// there lists the files the "agent" produced and, optionally, the counts a
// real run would have reported. Stub numbers exercise the pipeline; they are
// not evidence, and the run record says so.
export function stubAdapter(answers: string): ModelAdapter {
  return {
    name: 'stub',
    async run({ task, arm, workspace }) {
      const source = resolve(answers, task, arm);
      if (!(await stat(source).catch(() => null))?.isDirectory()) throw new ConfigError(`No prepared ${arm} answer for ${task} under ${answers}`);
      const answer = JSON.parse(await readFile(join(source,'answer.json'),'utf8')) as StubAnswer;
      if (!Array.isArray(answer.files) || !answer.files.every(file => typeof file === 'string')) throw new ConfigError(`${task}/${arm}/answer.json must list files`);
      for (const file of answer.files) await cp(join(source,file), join(workspace,file), { recursive:true });
      return { tokensIn: answer.tokensIn ?? 0, tokensOut: answer.tokensOut ?? 0, turns: answer.turns ?? 0, retries: answer.retries ?? 0,
        files: answer.files, start: answer.start, modules: answer.modules, commands: answer.commands, notes: `prepared answer copied from ${source}` };
    },
  };
}

/** Resolve `--adapter`: `stub` (prepared answers, no network) or `anthropic` (adapters/anthropic.ts, needs ANTHROPIC_API_KEY). */
export function selectAdapter(name: string, options: { answers: string }): ModelAdapter {
  if (name === 'stub') return stubAdapter(options.answers);
  if (name === 'anthropic') return anthropicFromEnvironment();
  throw new ConfigError(`Unknown adapter "${name}"; "stub" and "anthropic" ship. README.md explains how to add one.`);
}
