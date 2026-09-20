// A/B benchmark entry point (`benchmarks/ab/run`). Reads a task spec, describes the
// two arms and the acceptance script, and writes measurements.json in the shape of
// the recorded runs. It launches no model unless explicitly told to and authorized
// (see README.md, "Cost and authorization"); the default is a plan.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { parse } from 'yaml';
import { aggregate, summarizeTranscript, toMeasurement } from './summarize.ts';
import type { TranscriptSummary } from './summarize.ts';

export const armIds = ['a', 'b'] as const;
export type ArmId = (typeof armIds)[number];
export interface CommandSpec { cwd: string; command: string[] }
export interface TaskSpec {
  id: string; title: string; prompt: string; promptFile?: string;
  arms: Record<ArmId, { label: string; suffix: string }>;
  acceptance: Record<ArmId, CommandSpec>;
}
export const maxRepeat = 20;
const repoRoot = resolve(import.meta.dirname, '../..');
/** Environment variable that must carry the authorization reference (an issue, PR or approval id) before any model launch. */
export const authorizationVariable = 'URLCODE_AB_LAUNCH_AUTHORIZED';

export class UsageError extends Error {}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown, what: string) => { if (typeof v !== 'string' || !v.trim()) throw new UsageError(`spec: ${what} must be a non-empty string`); return v; };

export function parseSpec(source: string): TaskSpec {
  const raw: unknown = parse(source);
  if (!isRecord(raw) || !isRecord(raw.arms) || !isRecord(raw.acceptance)) throw new UsageError('spec: needs id, title, prompt, arms and acceptance');
  const arms = {} as TaskSpec['arms'], acceptance = {} as TaskSpec['acceptance'];
  for (const id of armIds) {
    const arm = raw.arms[id], accept = raw.acceptance[id];
    if (!isRecord(arm)) throw new UsageError(`spec: arms.${id} is missing`);
    arms[id] = { label: str(arm.label, `arms.${id}.label`), suffix: str(arm.suffix, `arms.${id}.suffix`) };
    if (!isRecord(accept) || !Array.isArray(accept.command) || !accept.command.length || !accept.command.every(c => typeof c === 'string')) throw new UsageError(`spec: acceptance.${id}.command must be a non-empty list of strings`);
    acceptance[id] = { cwd: str(accept.cwd, `acceptance.${id}.cwd`), command: accept.command as string[] };
  }
  const spec: TaskSpec = { id: str(raw.id, 'id'), title: str(raw.title, 'title'), prompt: str(raw.prompt, 'prompt'), arms, acceptance };
  if (raw.promptFile !== undefined) spec.promptFile = str(raw.promptFile, 'promptFile');
  return spec;
}

const fill = (text: string, values: Record<string, string>) => text.replace(/\{(\w+)\}/g, (m, key: string) => values[key] ?? m);

export interface ArmPlan { arm: ArmId; label: string; workdir: string; prompt: string; promptSha256: string; acceptance: { cwd: string; command: string[] } }
export interface Plan { task: string; title: string; repeat: number; modelRuns: number; out: string; arms: ArmPlan[]; notes: string[] }

/** Build the plan for one repeat. `workRoot` is where agents would work; nothing is created. */
export function buildPlan(spec: TaskSpec, options: { repeat: number; out: string; workRoot: string }): Plan {
  if (!Number.isInteger(options.repeat) || options.repeat < 1 || options.repeat > maxRepeat) throw new UsageError(`--repeat must be an integer from 1 to ${maxRepeat}`);
  const arms = armIds.map((arm): ArmPlan => {
    const workdir = join(options.workRoot, `agent-${arm}`);
    const values = { dir: workdir, root: repoRoot, spec: spec.promptFile ? join(repoRoot, spec.promptFile) : '' };
    const prompt = `${fill(spec.prompt, values).trim()}\n\n${fill(spec.arms[arm].suffix, values).trim()}\n`;
    const { cwd, command } = spec.acceptance[arm];
    return { arm, label: spec.arms[arm].label, workdir, prompt, promptSha256: createHash('sha256').update(prompt).digest('hex'), acceptance: { cwd: fill(cwd, values), command: command.map(c => fill(c, values)) } };
  });
  return {
    task: spec.id, title: spec.title, repeat: options.repeat, modelRuns: options.repeat * armIds.length, out: options.out, arms,
    notes: ['Each arm is one agent session; token use is roughly the size of the recorded runs in benchmarks/ab/README.md times the number of model runs.', 'Both arms start from the same empty directory and the same harness prefix; keep model, effort and tools identical across repeats.'],
  };
}

export function describePlan(plan: Plan): string {
  const lines = [`Task ${plan.task}: ${plan.title}`, `Repeats ${plan.repeat} per arm -> ${plan.modelRuns} model runs (0 are launched by a dry run)`, `Output ${plan.out}/measurements.json`, ''];
  for (const arm of plan.arms) lines.push(`Arm ${arm.arm.toUpperCase()} (${arm.label})`, `  workdir     ${arm.workdir}`, `  prompt      sha256 ${arm.promptSha256.slice(0, 16)}, ${arm.prompt.split('\n').length - 1} lines`, `  acceptance  (cwd ${arm.acceptance.cwd}) ${arm.acceptance.command.join(' ')}`, '');
  lines.push(...plan.notes.map(n => `Note: ${n}`));
  return lines.join('\n');
}

/** Returns why a launch is refused, or null when the explicit flag, a launcher and the authorization reference are all present. */
export function launchRefusal(flags: { launchModels: boolean; launcher?: string | undefined }, env: Record<string, string | undefined>): string | null {
  if (!flags.launchModels) return 'Model launches are off. Pass --launch-models to start agents; without it this command only plans and summarizes existing transcripts.';
  if (!flags.launcher) return '--launch-models needs --launcher <command>: this repository ships no model driver, so the command that starts one agent session for one arm must be supplied.';
  if (!env[authorizationVariable]?.trim()) return `Launching models spends API budget and needs the maintainer's explicit authorization for this run. Set ${authorizationVariable} to the issue, PR or approval that grants it (see benchmarks/ab/README.md, "Cost and authorization").`;
  return null;
}

export interface ArmRun { summary: TranscriptSummary; transcript: string }
export function buildMeasurements(input: { task: string; runs: Record<ArmId, ArmRun[]>; provenance: Record<string, unknown>; acceptance?: Record<ArmId, unknown> }) {
  const arm = (id: ArmId) => {
    const runs = input.runs[id];
    if (runs.length === 1) return { ...toMeasurement(runs[0]!.summary), transcript: runs[0]!.transcript };
    return { runs: runs.map(r => ({ ...toMeasurement(r.summary), transcript: r.transcript })), summary: aggregate(runs.map(r => r.summary)) };
  };
  return { task: input.task, ...input.provenance, n: Math.min(input.runs.a.length, input.runs.b.length), agent_a: arm('a'), agent_b: arm('b'), ...(input.acceptance ? { acceptance: input.acceptance } : {}) };
}

const run = (command: string[], options: { cwd: string; env?: Record<string, string> }) => new Promise<{ code: number; output: string }>(res => {
  const child = spawn(command[0]!, command.slice(1), { cwd: options.cwd, env: { ...process.env, ...options.env } });
  let output = '';
  child.stdout.on('data', d => { output += d; }); child.stderr.on('data', d => { output += d; });
  child.on('error', e => res({ code: 127, output: String(e) })); child.on('close', code => res({ code: code ?? 1, output }));
});

const usage = `Usage: benchmarks/ab/run --task <spec.yaml> [options]
  --task file           task spec (benchmarks/ab/tasks/hello-world.yaml, blog.yaml)
  --repeat n            runs per arm (default 1, at most ${maxRepeat})
  --out dir             where measurements.json (and plan.json) go (default benchmarks/ab/runs/<task>)
  --work-root dir       where agents would work (default <out>/work)
  --dry-run             describe the plan and write nothing (this is the default)
  --transcript a=file   summarize an existing transcript instead of launching; repeat per arm and per repeat (a=..., b=...)
  --launch-models       START REAL AGENT SESSIONS. Costs API budget; needs --launcher and ${authorizationVariable}
  --launcher command    command run once per arm and repeat with AB_TASK, AB_ARM, AB_REPEAT, AB_PROMPT_FILE, AB_WORKDIR, AB_TRANSCRIPT set
  --model, --urlcode    provenance strings recorded in measurements.json
  --derived-note text   provenance note recorded in measurements.json`;

async function main(argv: string[]) {
  const { values } = parseArgs({ args: argv, options: {
    task: { type: 'string' }, repeat: { type: 'string', default: '1' }, out: { type: 'string' }, 'work-root': { type: 'string' }, 'dry-run': { type: 'boolean', default: false },
    transcript: { type: 'string', multiple: true }, 'launch-models': { type: 'boolean', default: false }, launcher: { type: 'string' },
    model: { type: 'string' }, urlcode: { type: 'string' }, 'derived-note': { type: 'string' }, help: { type: 'boolean', default: false },
  } });
  if (values.help) { console.log(usage); return 0; }
  if (!values.task) throw new UsageError('--task is required');
  const spec = parseSpec(await readFile(values.task, 'utf8'));
  const out = resolve(values.out ?? join('benchmarks/ab/runs', spec.id));
  const plan = buildPlan(spec, { repeat: Number(values.repeat), out, workRoot: resolve(values['work-root'] ?? join(out, 'work')) });
  const provenance = { run: new Date().toISOString().slice(0, 10), urlcode: values.urlcode ?? 'unrecorded', model: values.model ?? 'unrecorded', ...(values['derived-note'] ? { derived_note: values['derived-note'] } : {}) };
  const transcripts = values.transcript ?? [];

  if (transcripts.length) {
    if (values['launch-models']) throw new UsageError('--transcript and --launch-models exclude each other');
    const runs: Record<ArmId, ArmRun[]> = { a: [], b: [] };
    for (const item of transcripts) {
      const match = /^([ab])=(.+)$/.exec(item);
      if (!match) throw new UsageError(`--transcript must look like a=<file> or b=<file>, got "${item}"`);
      runs[match[1] as ArmId].push({ summary: await summarizeTranscript(match[2]!), transcript: match[2]! });
    }
    if (!runs.a.length || !runs.b.length) throw new UsageError('give at least one --transcript for each of a and b');
    if (values['dry-run']) { console.log(JSON.stringify(buildMeasurements({ task: spec.id, runs, provenance }), null, 2)); return 0; }
    await mkdir(out, { recursive: true });
    await writeFile(join(out, 'measurements.json'), `${JSON.stringify(buildMeasurements({ task: spec.id, runs, provenance }), null, 2)}\n`);
    console.log(`wrote ${join(out, 'measurements.json')} from ${transcripts.length} existing transcripts (no model was launched)`);
    return 0;
  }

  if (values['dry-run'] || !values['launch-models']) {
    console.log(describePlan(plan));
    if (!values['dry-run']) console.log(`\n${launchRefusal({ launchModels: false }, process.env)}`);
    return 0;
  }
  const refusal = launchRefusal({ launchModels: true, launcher: values.launcher }, process.env);
  if (refusal) throw new UsageError(refusal);

  console.log(describePlan(plan));
  console.log(`\nLaunching ${plan.modelRuns} model runs. Authorization reference: ${process.env[authorizationVariable]}`);
  await mkdir(out, { recursive: true });
  await writeFile(join(out, 'plan.json'), `${JSON.stringify({ ...plan, authorization: process.env[authorizationVariable] }, null, 2)}\n`);
  const runs: Record<ArmId, ArmRun[]> = { a: [], b: [] }, acceptance: Record<ArmId, unknown[]> = { a: [], b: [] };
  for (let i = 1; i <= plan.repeat; i++) for (const arm of plan.arms) {
    const workdir = plan.repeat > 1 ? join(arm.workdir, `run-${i}`) : arm.workdir;
    const promptFile = join(dirname(workdir), `prompt-${arm.arm}-${i}.md`), transcript = join(dirname(workdir), `transcript-${arm.arm}-${i}.jsonl`);
    await mkdir(workdir, { recursive: true });
    await writeFile(promptFile, arm.prompt.replaceAll(arm.workdir, workdir));
    const launched = await run(['sh', '-c', values.launcher!], { cwd: process.cwd(), env: { AB_TASK: spec.id, AB_ARM: arm.arm, AB_REPEAT: String(i), AB_PROMPT_FILE: promptFile, AB_WORKDIR: workdir, AB_TRANSCRIPT: transcript } });
    if (launched.code !== 0) throw new Error(`launcher failed for arm ${arm.arm} repeat ${i} (exit ${launched.code}): ${launched.output.slice(-400)}`);
    runs[arm.arm].push({ summary: await summarizeTranscript(transcript), transcript });
    const accepted = await run(arm.acceptance.command.map(c => c.replaceAll(arm.workdir, workdir)), { cwd: arm.acceptance.cwd.replaceAll(arm.workdir, workdir) });
    acceptance[arm.arm].push({ repeat: i, exit: accepted.code, pass: accepted.code === 0, output_tail: accepted.output.slice(-800) });
  }
  await writeFile(join(out, 'measurements.json'), `${JSON.stringify(buildMeasurements({ task: spec.id, runs, provenance, acceptance }), null, 2)}\n`);
  console.log(`wrote ${join(out, 'measurements.json')}`);
  return 0;
}

if (import.meta.filename === process.argv[1]) {
  main(process.argv.slice(2)).then(code => process.exit(code), (error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(error instanceof UsageError ? 2 : 1);
  });
}
