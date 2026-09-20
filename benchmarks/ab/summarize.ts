// Shared A/B transcript summarizer. Replaces the per-run summarize_transcript.py
// that lived beside one recorded run. It reads a Claude Code agent transcript
// (JSONL, or a JSON array of the same records) and reports what the agent spent
// and did, from the transcript alone: nothing is estimated and nothing is
// launched. README.md in this directory defines every field.
import { readFile } from 'node:fs/promises';

export interface TokenTotals { input: number; output: number; cache_read: number; cache_creation: number; total: number }
export interface ToolCall { id: string; name: string; command: string; path: string; messageIndex: number; failed: boolean; resultSeen: boolean; resultAt: number | null }
export interface TranscriptSummary {
  tokens: TokenTotals;
  apiCalls: number;
  toolCalls: number;
  shellCommands: number;
  failedCommands: number;
  failedToolCalls: number;
  /** Cumulative four-way token sum through the API call that issued the first successful run command; null when none. */
  tokensToFirstSuccess: number | null;
  /** Tool calls (not distinct files) that read a path under docs/, llms*.txt, schemas/ or recipes/. */
  docReads: number;
  docReadPaths: string[];
  /** Read-only exploration calls issued before the first successful run (all calls when none succeeded). */
  discoveryCalls: number;
  discoveryShare: number | null;
  durationS: number | null;
  timeToFirstSuccessS: number | null;
}

type Json = Record<string, unknown>;
const isRecord = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** Accepts JSONL (one record per line) or a JSON array. Blank lines and non-record lines are skipped. */
export function parseTranscript(raw: string): Json[] {
  const trimmed = raw.trim();
  if (trimmed.startsWith('[')) {
    const parsed: unknown = JSON.parse(trimmed);
    return Array.isArray(parsed) ? parsed.filter(isRecord) : [];
  }
  const out: Json[] = [];
  for (const [i, line] of trimmed.split('\n').entries()) {
    if (!line.trim()) continue;
    let value: unknown;
    try { value = JSON.parse(line); } catch { throw new Error(`transcript line ${i + 1} is not JSON`); }
    if (isRecord(value)) out.push(value);
  }
  return out;
}

const docPath = /(?:^|[\s/"'=:])(?:docs\/|llms[\w.-]*\.txt|schemas\/|recipes\/)/;
const bashReadsPath = /\b(cat|head|tail|sed|grep|rg|awk|less|more|ls|find|cp|jq|wc)\b/;
/** Commands that run the built app or its checks; the first one that exits cleanly is "the first successful run". */
const runCommand = /\b(curl|wget)\b|\bnpm\s+(start|test|run\s+(start|test|dev))\b|\bnode\s+--test\b|\burlcode\s+(serve|test)\b|\bnode\s+(?!--version|-v\b|-e\b|[\w./-]*cli\.ts)[\w./-]+\.(?:m?js|ts)\b/;
/** A Bash command with any of these creates state or runs something, so it is not discovery. */
const notDiscovery = />|\btee\b|\bmkdir\b|\bnpm\s+(install|i|ci)\b|<<|\brm\b|\bmv\b|\bsed\s+-i|\bkill\b|\btouch\b|\bchmod\b|\bnpm\s+(start|test|run)\b|\bnode\b|\bnpx\b|\burlcode\s+(serve|test|init)\b|\bcurl\b/;
const readTools = new Set(['Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch', 'LS']);

// `2>/dev/null` and `2>&1` are redirections of noise, not writes.
const stripNoise = (command: string) => command.replace(/\d?>\s*&?\s*\/dev\/null/g, '').replace(/\d>&\d/g, '').replace(/\bmkdir\s+-p\s+[^;&|\n]*/g, '').replace(/\bnode\s+(-v|--version)\b/g, '');
// `urlcode serve --help` prints usage; it does not run anything.
// Text written by a here-document is file content, not something the command runs.
const stripHeredocs = (command: string) => command.replace(/<<-?\s*['"]?(\w+)['"]?[^\n]*\n[\s\S]*?\n\s*\1\b/g, '<<HEREDOC');
export const isRunCommand = (command: string) => runCommand.test(stripHeredocs(command).replace(/\burlcode\s+\w+\s+--help\b/g, ''));
export const isDiscoveryCall = (call: Pick<ToolCall, 'name' | 'command'>) => readTools.has(call.name) || (call.name === 'Bash' && !notDiscovery.test(stripNoise(stripHeredocs(call.command))));

export function docPathsOf(call: Pick<ToolCall, 'name' | 'command' | 'path'>): string[] {
  const hits: string[] = [];
  if (call.path && docPath.test(call.path)) hits.push(call.path);
  if (call.name === 'Bash' && bashReadsPath.test(call.command)) {
    for (const token of call.command.split(/[\s;&|()<>"'`]+/)) if (token && docPath.test(`/${token}`) && /^[\w./~*-]+$/.test(token)) hits.push(token);
    // `cd .../docs && cat GUIDE.md`: the directory is the documentation, so the files read from it are doc reads.
    const cd = /\bcd\s+(\S*?(?:docs|recipes|schemas))\/?(?=\s|;|&|$)/.exec(call.command);
    if (cd && !hits.length) hits.push(`${cd[1]}/`);
  }
  return hits;
}

const resultText = (content: unknown): string => typeof content === 'string' ? content : Array.isArray(content) ? content.map(c => (isRecord(c) && typeof c.text === 'string' ? c.text : '')).join('') : '';

export function summarizeRecords(records: Json[]): TranscriptSummary {
  // One API response can be written as several records that share message.id (streamed content blocks);
  // each repeats the usage and the last one is complete. Count each message once, from its last record.
  const messageOrder: string[] = [];
  const usageOf = new Map<string, Json>();
  const calls: ToolCall[] = [];
  const byId = new Map<string, ToolCall>();
  const stamps: number[] = [];
  let anon = 0;
  for (const record of records) {
    const at = typeof record.timestamp === 'string' ? Date.parse(record.timestamp) : NaN;
    if (Number.isFinite(at)) stamps.push(at);
    const message = isRecord(record.message) ? record.message : undefined;
    if (!message) continue;
    if (record.type === 'assistant') {
      const id = typeof message.id === 'string' ? message.id : `anon-${anon++}`;
      if (!usageOf.has(id)) messageOrder.push(id);
      if (isRecord(message.usage)) usageOf.set(id, message.usage); else if (!usageOf.has(id)) usageOf.set(id, {});
      const index = messageOrder.indexOf(id);
      for (const block of Array.isArray(message.content) ? message.content : []) {
        if (!isRecord(block) || block.type !== 'tool_use' || typeof block.id !== 'string' || byId.has(block.id)) continue;
        const input = isRecord(block.input) ? block.input : {};
        const call: ToolCall = { id: block.id, name: String(block.name ?? ''), command: typeof input.command === 'string' ? input.command : '', path: String(input.file_path ?? input.path ?? ''), messageIndex: index, failed: false, resultSeen: false, resultAt: null };
        byId.set(call.id, call); calls.push(call);
      }
    } else if (record.type === 'user' && Array.isArray(message.content)) {
      for (const block of message.content) {
        if (!isRecord(block) || block.type !== 'tool_result' || typeof block.tool_use_id !== 'string') continue;
        const call = byId.get(block.tool_use_id);
        if (!call) continue;
        call.resultSeen = true; call.resultAt = Number.isFinite(at) ? at : null;
        call.failed = block.is_error === true || (call.name === 'Bash' && /^Exit code [1-9]/.test(resultText(block.content)));
      }
    }
  }
  const tokens: TokenTotals = { input: 0, output: 0, cache_read: 0, cache_creation: 0, total: 0 };
  const perMessage = messageOrder.map(id => { const u = usageOf.get(id) ?? {}; return { input: num(u.input_tokens), output: num(u.output_tokens), cache_read: num(u.cache_read_input_tokens), cache_creation: num(u.cache_creation_input_tokens) }; });
  for (const m of perMessage) { tokens.input += m.input; tokens.output += m.output; tokens.cache_read += m.cache_read; tokens.cache_creation += m.cache_creation; }
  tokens.total = tokens.input + tokens.output + tokens.cache_read + tokens.cache_creation;
  const first = calls.find(c => c.name === 'Bash' && c.resultSeen && !c.failed && isRunCommand(c.command));
  const sum = (upTo: number) => perMessage.slice(0, upTo + 1).reduce((s, m) => s + m.input + m.output + m.cache_read + m.cache_creation, 0);
  const cutoff = first ? calls.indexOf(first) : calls.length - 1;
  const discovery = calls.slice(0, cutoff + 1).filter(isDiscoveryCall).length;
  const docCalls = calls.map(c => docPathsOf(c)).filter(p => p.length > 0);
  const start = stamps.length ? Math.min(...stamps) : null, end = stamps.length ? Math.max(...stamps) : null;
  const seconds = (ms: number) => Math.round(ms / 100) / 10;
  const shell = calls.filter(c => c.name === 'Bash');
  return {
    tokens, apiCalls: messageOrder.length, toolCalls: calls.length, shellCommands: shell.length,
    failedCommands: shell.filter(c => c.failed).length, failedToolCalls: calls.filter(c => c.failed).length,
    tokensToFirstSuccess: first ? sum(first.messageIndex) : null,
    docReads: docCalls.length, docReadPaths: [...new Set(docCalls.flat())],
    discoveryCalls: discovery, discoveryShare: calls.length ? Math.round((discovery / calls.length) * 100) / 100 : null,
    durationS: start !== null && end !== null ? seconds(end - start) : null,
    timeToFirstSuccessS: first?.resultAt != null && start !== null ? seconds(first.resultAt - start) : null,
  };
}

export const summarizeTranscript = async (file: string): Promise<TranscriptSummary> => summarizeRecords(parseTranscript(await readFile(file, 'utf8')));

// --- aggregation across repeats -------------------------------------------------------------
export interface Spread { n: number; median: number; min: number; max: number }
export function spread(values: readonly number[]): Spread | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b), mid = s.length >> 1;
  return { n: s.length, median: s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2, min: s[0]!, max: s[s.length - 1]! };
}
const metricOf: Record<string, (s: TranscriptSummary) => number | null> = {
  input: s => s.tokens.input, output: s => s.tokens.output, cache_read: s => s.tokens.cache_read, cache_creation: s => s.tokens.cache_creation, total_tokens: s => s.tokens.total,
  tokens_to_first_success: s => s.tokensToFirstSuccess, api_calls: s => s.apiCalls, tool_calls: s => s.toolCalls, failed_commands: s => s.failedCommands,
  doc_reads: s => s.docReads, discovery_calls: s => s.discoveryCalls, discovery_share: s => s.discoveryShare, duration_s: s => s.durationS,
};
export function aggregate(runs: readonly TranscriptSummary[]): Record<string, Spread | null> {
  return Object.fromEntries(Object.entries(metricOf).map(([name, get]) => [name, spread(runs.map(get).filter((v): v is number => v !== null))]));
}

/** The summary in the shape of the existing measurements.json arm entries (tokens block plus the counted fields). */
export function toMeasurement(s: TranscriptSummary) {
  return {
    tokens: { input: s.tokens.input, output: s.tokens.output, cache_read: s.tokens.cache_read, cache_creation: s.tokens.cache_creation, cumulative_total: s.tokens.total },
    tokens_to_first_success_incl_issuing_call: s.tokensToFirstSuccess, api_calls: s.apiCalls, tool_calls: s.toolCalls, shell_commands: s.shellCommands,
    doc_reads: s.docReads, failed_commands: s.failedCommands, duration_s: s.durationS, time_to_first_success_s: s.timeToFirstSuccessS,
    discovery_calls: s.discoveryCalls, discovery_share_of_calls: s.discoveryShare,
  };
}

export function formatTable(arms: Record<string, TranscriptSummary>): string {
  const names = Object.keys(arms);
  const rows: [string, (s: TranscriptSummary) => string][] = [
    ['Input tokens (uncached)', s => String(s.tokens.input)], ['Output tokens', s => String(s.tokens.output)], ['Cache-creation tokens', s => String(s.tokens.cache_creation)],
    ['Cache-read tokens', s => String(s.tokens.cache_read)], ['Total tokens (all four)', s => String(s.tokens.total)],
    ['Tokens to first successful run', s => s.tokensToFirstSuccess === null ? 'none' : String(s.tokensToFirstSuccess)], ['Agent turns (API calls)', s => String(s.apiCalls)],
    ['Tool calls', s => String(s.toolCalls)], ['Failed commands', s => String(s.failedCommands)], ['Documentation reads', s => String(s.docReads)],
    ['Discovery calls / share', s => `${s.discoveryCalls} / ${s.discoveryShare ?? 'n/a'}`], ['Duration (s)', s => String(s.durationS ?? 'n/a')],
  ];
  return [`| Metric | ${names.join(' | ')} |`, `|---|${names.map(() => '---:').join('|')}|`, ...rows.map(([label, get]) => `| ${label} | ${names.map(n => get(arms[n]!)).join(' | ')} |`)].join('\n');
}

// --- CLI ------------------------------------------------------------------------------------
if (import.meta.filename === process.argv[1]) {
  const args = process.argv.slice(2);
  if (!args.length || args.includes('--help')) { console.log('Usage: node benchmarks/ab/summarize.ts [--json] [label=]transcript.jsonl ...'); process.exit(args.length ? 0 : 2); }
  const json = args.includes('--json'), arms: Record<string, TranscriptSummary> = {};
  for (const arg of args.filter(a => a !== '--json')) {
    const eq = arg.indexOf('='), label = eq > 0 ? arg.slice(0, eq) : arg, file = eq > 0 ? arg.slice(eq + 1) : arg;
    arms[label] = await summarizeTranscript(file);
  }
  console.log(json ? JSON.stringify(arms, null, 2) : formatTable(arms));
}
