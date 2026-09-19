// Enforcing guard against prose that describes the pre-0.4.0-alpha.2 trust
// model as if it were current behavior.
//
// Since 0.4.0-alpha.2, `function`/`middleware` routes run trusted and
// unsandboxed by default, in the host process, and `sandbox: true` is a
// per-route opt-in into the QuickJS/WebAssembly isolate
// (docs/SPIKE-DEFAULT-TRUST-MODEL.md, docs/FUNCTION-SECURITY.md). Documents
// written before that reversal claim the opposite -- that functions are
// untrusted, always sandboxed, or executed in QuickJS/WASM full stop -- and
// those claims are wrong about the current release rather than merely dated.
//
// Unlike scripts/check-downstream-skill-drift.ts, which only reports, this
// check FAILS (exit 1) on a violation: a stale trust-model claim in shipped
// documentation is a correctness bug, not drift for a human to weigh.
//
// What it scans: every Markdown file in the checkout, plus llms.txt and
// llms-full.txt. Build output, dependencies and version-control metadata are
// skipped. docs/SPIKE-DEFAULT-TRUST-MODEL.md is skipped because it is the
// decision record itself and quotes the old wording verbatim in order to
// retract it.
//
// Opting out for legitimate historical text
// -----------------------------------------
// Release history and dated spike documents must keep describing what a past
// release actually did. Mark those passages instead of weakening the patterns:
//
//   <!-- trust-model-prose: historical -->      exempts the paragraph it
//       appears in, or the paragraph immediately after it when the marker sits
//       on its own line.
//   <!-- trust-model-prose: historical-file --> exempts the whole file.
//
// Use the marker only for text that is explicitly about a past release or a
// superseded proposal, and keep the surrounding entry honest by pointing at
// docs/SPIKE-DEFAULT-TRUST-MODEL.md nearby. Live documentation gets fixed, not
// marked.
import { readdir, readFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);

const SKIP_DIRECTORIES = new Set(['node_modules', '.git', 'dist', 'coverage', '.worktrees']);
const EXTRA_FILES = ['llms.txt', 'llms-full.txt'];
const SKIP_FILES = new Set(['docs/SPIKE-DEFAULT-TRUST-MODEL.md']);

const LINE_MARKER = 'trust-model-prose: historical';
const FILE_MARKER = 'trust-model-prose: historical-file';

interface Rule {
  name: string;
  pattern: RegExp;
  // When true, a sentence that already qualifies the claim -- it names
  // `sandbox`, "sandboxed" or "trusted" -- is not a violation, because the
  // scoped form ("a route declaring `sandbox: true` runs in QuickJS") is the
  // correct way to describe the isolate today.
  allowScoped: boolean;
  hint: string;
}

const RULES: Rule[] = [
  {
    name: 'functions-are-untrusted',
    pattern:
      /\b(?:functions?|middleware|guests?)\b(?:\s+code)?\s+(?:is|are|run|runs|remain|remains|execute|executes)\b[^.]{0,40}\buntrusted\b/i,
    allowScoped: false,
    hint: 'functions/middleware are trusted by default; say so, or scope the claim to `sandbox: true`',
  },
  {
    name: 'untrusted-guest',
    pattern: /\buntrusted\s+(?:quickjs|wasm|webassembly|guests?)\b/i,
    allowScoped: false,
    hint: 'only a `sandbox: true` route runs as a guest, and trusting it is the project’s call',
  },
  {
    name: 'sandboxed-by-default',
    pattern:
      /\b(?:is|are|run|runs|remain|remains|execute|executes)\s+(?:\w+\s+){0,3}(?:sandboxed|isolated)\b[^.]{0,30}\bby default\b|\b(?:sandboxed|isolated)\s+by default\b/i,
    allowScoped: false,
    hint: 'the default is trusted and unsandboxed; `sandbox: true` is the opt-in',
  },
  {
    name: 'always-sandboxed',
    pattern: /\balways\s+(?:sandboxed|isolated|untrusted)\b/i,
    allowScoped: false,
    hint: 'isolation is per route, not unconditional',
  },
  {
    name: 'unscoped-quickjs-execution',
    pattern:
      /\b(?:functions?|middleware)\b[^.]{0,60}\b(?:run|runs|execute|executes|dispatched)\b[^.]{0,40}\b(?:quickjs|wasm|webassembly)\b/i,
    allowScoped: true,
    hint: 'name the `sandbox: true` opt-in, or say which execution mode is meant',
  },
];

const SCOPED = /sandbox|trusted/i;

interface Violation {
  file: string;
  line: number;
  rule: Rule;
  text: string;
}

async function collectFiles(dir: URL, prefix: string, found: string[]): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SKIP_DIRECTORIES.has(entry.name) || entry.name.startsWith('.')) continue;
      await collectFiles(new URL(`${entry.name}/`, dir), `${prefix}${entry.name}/`, found);
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
    found.push(`${prefix}${entry.name}`);
  }
}

// A paragraph is a run of non-blank lines; `start` is its 1-based first line.
interface Paragraph {
  start: number;
  lines: string[];
  precededByMarker: boolean;
}

function paragraphs(text: string): Paragraph[] {
  const lines = text.split('\n');
  const result: Paragraph[] = [];
  let current: string[] = [];
  let start = 1;
  let markerPending = false;
  const flush = () => {
    if (current.length > 0) {
      result.push({ start, lines: current, precededByMarker: markerPending });
      markerPending = false;
      current = [];
    }
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim() === '') {
      flush();
      continue;
    }
    if (current.length === 0 && line.trim() === `<!-- ${LINE_MARKER} -->`) {
      markerPending = true;
      start = i + 2;
      continue;
    }
    if (current.length === 0) start = i + 1;
    current.push(line);
  }
  flush();
  return result;
}

// Sentence split good enough for prose and Markdown tables: a period followed
// by whitespace, or a table cell boundary, ends a claim.
function sentences(block: string): string[] {
  return block
    .split(/(?<=\.)\s+|\s*\|\s*/)
    .map((part) => part.trim())
    .filter((part) => part !== '');
}

function scan(relPath: string, text: string): Violation[] {
  if (text.includes(FILE_MARKER)) return [];
  const violations: Violation[] = [];
  for (const paragraph of paragraphs(text)) {
    const block = paragraph.lines.join(' ');
    if (paragraph.precededByMarker || block.includes(LINE_MARKER)) continue;
    for (const sentence of sentences(block.replace(/\s+/g, ' '))) {
      for (const rule of RULES) {
        if (!rule.pattern.test(sentence)) continue;
        if (rule.allowScoped && SCOPED.test(sentence)) continue;
        const offset = paragraph.lines.findIndex((line) =>
          rule.pattern.test(line.replace(/\s+/g, ' ')),
        );
        violations.push({
          file: relPath,
          line: paragraph.start + (offset === -1 ? 0 : offset),
          rule,
          text: sentence.length > 160 ? `${sentence.slice(0, 157)}...` : sentence,
        });
      }
    }
  }
  return violations;
}

async function main() {
  const files: string[] = [];
  await collectFiles(root, '', files);
  for (const extra of EXTRA_FILES) files.push(extra);
  files.sort();

  const violations: Violation[] = [];
  let scanned = 0;
  for (const relPath of files) {
    if (SKIP_FILES.has(relPath)) continue;
    let text: string;
    try {
      text = await readFile(new URL(relPath, root), 'utf8');
    } catch {
      continue; // llms-full.txt need not exist on every branch
    }
    scanned++;
    violations.push(...scan(relPath, text));
  }

  if (violations.length === 0) {
    console.log(`Trust-model prose check: ${scanned} file(s) scanned, no stale claims.`);
    return;
  }

  console.error('Trust-model prose check failed. These read as present-tense claims');
  console.error('about current behavior, but describe the pre-0.4.0-alpha.2 default:\n');
  for (const violation of violations) {
    console.error(`${violation.file}:${violation.line} [${violation.rule.name}]`);
    console.error(`  ${violation.text}`);
    console.error(`  -> ${violation.rule.hint}\n`);
  }
  console.error(
    'Fix the wording, or -- only for text about a past release -- mark it with\n' +
      `<!-- ${LINE_MARKER} --> (see this script's header comment).`,
  );
  process.exitCode = 1;
}

await main();
