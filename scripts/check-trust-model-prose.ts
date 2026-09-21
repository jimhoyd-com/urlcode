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
// It also scans the *comments* of runnable project material under examples/
// and starters/ -- `.mjs`/`.js`/`.ts` modules and `urlcode.yaml` -- because a
// stale claim there is read by exactly the people copying the file. Only
// comment text is scanned; code and YAML values are not prose.
//
// Finally it cross-checks each example/starter project against its own YAML:
// a project whose prose claims sandbox or QuickJS/WASM isolation must have at
// least one route declaring `sandbox: true`. examples/prerender claimed in a
// `.mjs` comment that it "runs in the QuickJS/WASM sandbox" while declaring no
// such route, so under the trusted default it ran in-process with full Node
// access -- a Markdown-only scan could not see either half of that.
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
// Scanned wherever they appear, not just at the root: each workspace package
// under `packages/` ships its own `llms.txt`, and it is the most agent-facing
// file in the package.
const EXTRA_FILE_NAMES = ['llms.txt', 'llms-full.txt'];
const EXTRA_FILES = [...EXTRA_FILE_NAMES];
const SKIP_FILES = new Set(['docs/SPIKE-DEFAULT-TRUST-MODEL.md']);

// Runnable project material whose comments ship to readers who copy it, plus
// the runtime's own source: `src/` emits CLI help, `doctor`'s JSON report and
// the generated agent guide, so a stale sentence there reaches users directly.
// `packages/` carries the workspace packages folded in from their own
// repositories; their comments ship to readers exactly like core's do, and
// reaching them is the whole point of consolidating (docs/SPIKE-MONOREPO.md).
// `test/` is here for test *names*: a name is a claim about what the test
// exercises, and test/typescript-authoring.test.ts asserted "executes only in
// QuickJS" over a fixture declaring no `sandbox` (#196). Only the title string
// of a `test(...)`/`it(...)` call is read, alongside comments -- never the
// fixture source those calls embed, which legitimately contains both modes.
const PROJECT_ROOTS = ['examples/', 'starters/', 'recipes/', 'src/', 'scripts/', 'packages/', 'test/'];
const COMMENTED_SOURCE = /\.(?:mjs|cjs|js|ts|tsx)$/;
// `recipe.yaml` and `example.yaml` carry the catalog `description`, `tags` and
// `behavior` that `urlcode recipes show`, `urlcode examples` and the MCP
// `search_recipes` tool emit verbatim -- among the most agent-facing strings in
// the repository, and previously unscanned.
const PROJECT_CONFIG = /(?:^|\/)(?:urlcode|recipe|example)\.ya?ml$/;
// A claim of isolation that a project must back with a `sandbox: true` route.
const CLAIMS_ISOLATION =
  /\b(?:quickjs|webassembly|wasm)\b|\bin\s+the\s+sandbox\b|\bsandboxed\b|\bno\s+filesystem,\s*network\s+or\s+host\s+code\b/i;
const DECLARES_SANDBOX = /^\s*sandbox\s*:\s*true\s*(?:#.*)?$/m;
// Prose that explicitly conditions isolation on the opt-in is correct even in a
// project that never declares it -- "in QuickJS/WASM for a `sandbox: true`
// route" is the wording we want, not a violation.
const SCOPES_TO_OPT_IN = /sandbox\s*:\s*true|sandboxed[- ]route|if you add|when a route declares|opts? into/i;

// The title argument of a test declaration, single or double quoted. Anything
// else on the line -- the fixture module source, the assertions -- is dropped.
const TEST_TITLE = /^(?:await\s+)?(?:test|it|describe)(?:\.\w+)?\(\s*(?:'([^']*)'|"([^"]*)")/;

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
    // Policies run outside function/middleware execution, trusted or sandboxed
    // alike. "Outside the sandbox" implies the sandbox is the thing they sit
    // outside of, which is wrong in both directions once trusted is the
    // default. Fixed by hand in docs/POLICIES.md and src/policies.ts before any
    // rule existed for it; this is that rule.
    name: 'outside-the-sandbox',
    pattern: /\b(?:outside|beyond)\s+(?:the\s+)?sandbox\b/i,
    allowScoped: false,
    hint: 'say "outside function/middleware execution -- trusted or sandboxed alike"; the sandbox is not the boundary policies sit outside of',
  },
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
  // The rules below cover the forms #196 found still shipping green. Each one
  // reads as an unconditional statement about the runtime while describing
  // only what the guest does, and none of the rules above matched them: they
  // never use the words "untrusted", "by default", "always" or "QuickJS".
  {
    // test/typescript-authoring.test.ts named itself "executes only in
    // QuickJS" over a fixture that declares no `sandbox`, so it in fact
    // exercised the trusted path. A test name is a claim like any other.
    name: 'guest-only-execution',
    pattern:
      /\b(?:runs?|ran|executes?|executed|executing|dispatched)\s+only\s+in\s+(?:the\s+)?(?:quickjs|wasm|webassembly|guest|sandbox|isolate)\b/i,
    allowScoped: true,
    hint: 'trusted, in-process execution is the default; scope the claim to `sandbox: true` or name the mode actually exercised',
  },
  {
    // docs/yaml/functions.md listed the guest's missing capabilities directly
    // under a route that declares no `sandbox`, where every one of them works.
    name: 'unscoped-no-node-access',
    pattern:
      /\b(?:node\s+(?:apis?|builtins?)|npm\s+(?:imports?|packages?|modules?))\b[^.]{0,120}\b(?:do not|does not|don['’]t|doesn['’]t|are not|is not|aren['’]t|isn['’]t|cannot|can['’]t|unavailable|unsupported)\b|\b(?:no|without|never)\s+(?:node\s+(?:apis?|builtins?)|npm\s+(?:imports?|packages?|modules?))\b/i,
    allowScoped: true,
    hint: 'Node builtins and npm packages do work on a trusted (default) route; scope the restriction to `sandbox: true`',
  },
  {
    // docs/yaml/middleware.md: "share one sandbox/deadline". The chain shares
    // the route's execution mode -- which may be no sandbox at all.
    name: 'chain-shares-a-sandbox',
    pattern: /\bshare[sd]?\s+(?:one|a|the\s+same|its)\s+(?:\w+[/\s])?sandbox\b/i,
    allowScoped: false,
    hint: 'the chain shares the route\'s execution mode and one deadline; on the default route there is no sandbox to share',
  },
  {
    // docs/MIDDLEWARE.md described the guest Response contract -- no clone(),
    // opaque native bodies -- as the middleware contract. A trusted chain gets
    // Node's own Request/Response and can read a native body.
    name: 'unscoped-response-limits',
    pattern:
      /\b(?:there\s+is\s+)?no\s+`?clone\(\)`?|\bcannot\s+be\s+read\s+through\s+`?(?:text|json)\(\)`?|\bnative\s+(?:\w+\s+){0,4}bodies\s+are\s+opaque\b/i,
    allowScoped: true,
    hint: 'these are guest limits; scope them to `sandbox: true` (a trusted chain gets Node\'s Request/Response)',
  },
  {
    // docs/READINESS.md called the activated runtime "isolated" -- it
    // activates each route in the route's own declared mode.
    name: 'isolated-runtime',
    pattern: /\b(?:isolated|sandboxed)\s+runtime\b/i,
    allowScoped: false,
    hint: 'the runtime activates each route in its declared mode; say "the same runtime that serves it" instead',
  },
  {
    // README.md and docs/FRAMEWORK.md made grants the sole path by which a
    // secret can reach code. Grants govern the context the runtime *injects*;
    // they are not a statement about what ambient Node access exists.
    name: 'grants-are-the-only-path',
    pattern:
      /\bsecrets?\b[^.]{0,80}\b(?:reach|reaches|arrive|arrives|available|exposed)\b[^.]{0,80}\bonly\b[^.]{0,60}\bgrants?\b|\bonly\s+way\s+(?:a\s+)?secrets?\b/i,
    allowScoped: false,
    hint: 'grants govern the injected `env`/`secrets` context, not ambient Node access; say which one is meant',
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
    if (!entry.isFile()) continue;
    const relPath = `${prefix}${entry.name}`;
    const inProject = PROJECT_ROOTS.some((projectRoot) => relPath.startsWith(projectRoot));
    if (
      entry.name.endsWith('.md') ||
      (inProject && (COMMENTED_SOURCE.test(entry.name) || PROJECT_CONFIG.test(relPath)))
    ) {
      found.push(relPath);
    }
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

// Blank out everything that is not comment text, keeping line numbers intact,
// so a rule matches prose a reader reads and never a string literal or a route
// name that happens to contain the word.
function isProseFile(relPath: string): boolean {
  return relPath.endsWith('.md') || EXTRA_FILE_NAMES.includes(relPath.split('/').pop() ?? '');
}

function commentsOnly(relPath: string, text: string): string {
  const lines = text.split('\n');
  if (PROJECT_CONFIG.test(relPath)) {
    return lines
      .map((line) => {
        if (/^\s*#/.test(line)) return line.replace(/^\s*#\s?/, '');
        // `description:` reaches agents through explain/context/manifest and the
        // recipe catalog; `tags:` and the `behavior:` bullets reach them through
        // `urlcode recipes show` and MCP `search_recipes`.
        const described = /^\s*(?:description|summary|tags)\s*:\s*(.*)$/.exec(line);
        if (described) return described[1] ?? '';
        const bullet = /^\s*-\s+(.*)$/.exec(line);
        if (bullet) return bullet[1] ?? '';
        return '';
      })
      .join('\n');
  }
  let inBlock = false;
  return lines
    .map((line) => {
      const trimmed = line.trim();
      const title = TEST_TITLE.exec(trimmed);
      if (!inBlock && title) return title[1] ?? title[2] ?? '';
      if (inBlock) {
        const end = trimmed.indexOf('*/');
        if (end === -1) return trimmed.replace(/^\*\s?/, '');
        inBlock = false;
        return trimmed.slice(0, end).replace(/^\*\s?/, '');
      }
      if (trimmed.startsWith('//')) return trimmed.slice(2).trim();
      if (trimmed.startsWith('/*')) {
        const end = trimmed.indexOf('*/');
        if (end !== -1) return trimmed.slice(2, end).trim();
        inBlock = true;
        return trimmed.slice(2).trim();
      }
      return '';
    })
    .join('\n');
}

// A project that tells the reader its code is isolated must declare it. The
// default is trusted, so the claim is false unless some route opts in.
async function checkProjectIsolationClaims(files: string[]): Promise<Violation[]> {
  const rule: Rule = {
    name: 'unbacked-isolation-claim',
    pattern: CLAIMS_ISOLATION,
    allowScoped: false,
    hint: 'no route in this project declares `sandbox: true`, so its code runs trusted and in-process; declare it or drop the claim',
  };
  const configs = files.filter((relPath) => PROJECT_CONFIG.test(relPath));
  const byDirectory = new Map<string, string[]>();
  for (const config of configs) {
    const projectDir = config.slice(0, config.lastIndexOf('/') + 1);
    byDirectory.set(projectDir, [...(byDirectory.get(projectDir) ?? []), config]);
  }
  const violations: Violation[] = [];
  for (const [projectDir, dirConfigs] of byDirectory) {
    // A route declaring the opt-in in ANY of the directory's config files backs
    // the whole project's prose.
    let declares = false;
    for (const config of dirConfigs) {
      if (DECLARES_SANDBOX.test(await readFile(new URL(config, root), 'utf8'))) declares = true;
    }
    if (declares) continue;
    for (const relPath of files) {
      if (!relPath.startsWith(projectDir)) continue;
      const text = await readFile(new URL(relPath, root), 'utf8');
      if (text.includes(FILE_MARKER)) continue;
      const prose = isProseFile(relPath) ? text : commentsOnly(relPath, text);
      prose.split('\n').forEach((line, index) => {
        if (!CLAIMS_ISOLATION.test(line) || SCOPES_TO_OPT_IN.test(line) || line.includes(LINE_MARKER)) return;
        violations.push({
          file: relPath,
          line: index + 1,
          rule,
          text: line.trim().length > 160 ? `${line.trim().slice(0, 157)}...` : line.trim(),
        });
      });
    }
  }
  return violations;
}

// The workspace packages, read from disk rather than from a list that would go
// stale the next time one is folded in or retired.
async function workspacePackages(): Promise<string[]> {
  const entries = await readdir(new URL('packages/', root), { withFileTypes: true }).catch(() => []);
  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
}

// Regression fixtures
// -------------------
// Every rule above exists because a real sentence shipped green. Each fixture
// pins one of those sentences (`violates`) together with the corrected wording
// that replaced it (`clean`), so a later loosening of a pattern -- or a
// "clean" rewrite that happens to trip a different rule -- fails here instead
// of silently reopening the hole. These run on every invocation: they are pure
// string matching and cost nothing.
interface Fixture { rule: string; violates: string; clean: string }

const FIXTURES: Fixture[] = [
  {
    rule: 'outside-the-sandbox',
    violates: 'Policies are evaluated outside the sandbox, before the handler runs.',
    clean: 'Policies are evaluated outside function/middleware execution -- trusted or sandboxed alike -- before the handler runs.',
  },
  {
    rule: 'functions-are-untrusted',
    violates: 'Functions run as untrusted code, so treat every module as hostile.',
    clean: 'Functions run trusted and in-process unless the route declares `sandbox: true`.',
  },
  {
    rule: 'untrusted-guest',
    violates: 'Each call gets a fresh untrusted QuickJS guest.',
    clean: 'A `sandbox: true` route gets a fresh QuickJS guest per call.',
  },
  {
    rule: 'sandboxed-by-default',
    violates: 'Project code is sandboxed by default.',
    clean: 'Project code is trusted and unsandboxed by default; `sandbox: true` is the opt-in.',
  },
  {
    rule: 'always-sandboxed',
    violates: 'Middleware is always sandboxed, with no way to opt out.',
    clean: 'Middleware is sandboxed only on a route declaring `sandbox: true`.',
  },
  {
    rule: 'unscoped-quickjs-execution',
    violates: 'Functions run in QuickJS compiled to WebAssembly.',
    clean: 'A function on a `sandbox: true` route runs in QuickJS compiled to WebAssembly.',
  },
  // #196, test/typescript-authoring.test.ts:10 -- a test name claiming a mode
  // its own fixture does not declare.
  {
    rule: 'guest-only-execution',
    violates: 'TypeScript guest graph builds with rewritten imports and executes only in QuickJS',
    clean: 'TypeScript graph builds with rewritten imports and executes trusted (fixture declares no sandbox)',
  },
  // #196, docs/yaml/functions.md:57 -- guest limits listed under a route that
  // declares no `sandbox`, where all of them in fact work.
  {
    rule: 'unscoped-no-node-access',
    violates: '`.js` and `.mjs` ES modules work; TypeScript, Node APIs, npm imports, network access and filesystem access do not.',
    clean: 'On a `sandbox: true` route, Node APIs and npm imports do not work; a trusted route has both.',
  },
  // #196, docs/yaml/middleware.md:26 -- the chain shares a mode, which on the
  // default route is not a sandbox at all.
  {
    rule: 'chain-shares-a-sandbox',
    violates: 'Up to 16 middleware entries share one sandbox/deadline and approved route bindings.',
    clean: "Up to 16 middleware entries share the route's execution mode, one deadline and one set of approved route bindings.",
  },
  // #196, docs/MIDDLEWARE.md:49-56 -- the guest Response contract presented as
  // the middleware contract.
  {
    rule: 'unscoped-response-limits',
    violates: 'There is no `clone()` or streaming API; pass parsed data through `context.state`.',
    clean: 'On a `sandbox: true` route there is no `clone()` or streaming API; pass parsed data through `context.state`.',
  },
  {
    rule: 'unscoped-response-limits',
    violates: 'Native redirect/respond/page/static/download bodies are opaque and cannot be read through `text()`.',
    clean: 'On a `sandbox: true` route, native bodies are opaque and cannot be read through `text()`.',
  },
  // #196, docs/READINESS.md:13.
  {
    rule: 'isolated-runtime',
    violates: 'All three activate the project with the same isolated runtime.',
    clean: 'All three activate the project with the same runtime that serves it, each route in its declared trust mode.',
  },
  // #196, README.md:35 and docs/FRAMEWORK.md -- grants govern injected
  // context, not ambient Node access.
  {
    rule: 'grants-are-the-only-path',
    violates: 'Either way, secrets reach them only through operator grants pinned to the project revision.',
    clean: 'Either way, the `env`/`secrets` the runtime hands a route come only from operator grants pinned to the project revision.',
  },
];

function checkFixtures(): string[] {
  const failures: string[] = [];
  const names = new Set(RULES.map((rule) => rule.name));
  for (const rule of RULES) {
    if (!FIXTURES.some((fixture) => fixture.rule === rule.name)) {
      failures.push(`rule ${rule.name} has no regression fixture`);
    }
  }
  for (const fixture of FIXTURES) {
    if (!names.has(fixture.rule)) {
      failures.push(`fixture names unknown rule ${fixture.rule}`);
      continue;
    }
    const violations = scan(`fixture:${fixture.rule}`, fixture.violates);
    if (!violations.some((violation) => violation.rule.name === fixture.rule)) {
      failures.push(`${fixture.rule} no longer catches: ${fixture.violates}`);
    }
    const remaining = scan(`fixture:${fixture.rule}`, fixture.clean);
    if (remaining.length > 0) {
      failures.push(`${fixture.rule} corrected wording trips ${remaining.map((v) => v.rule.name).join(', ')}: ${fixture.clean}`);
    }
  }
  return failures;
}

async function main() {
  const fixtureFailures = checkFixtures();
  if (fixtureFailures.length > 0) {
    console.error('Trust-model prose check: its own regression fixtures failed.\n');
    for (const failure of fixtureFailures) console.error(`  ${failure}`);
    console.error('\nA rule may not be loosened past the sentence that motivated it.');
    process.exitCode = 1;
    return;
  }
  const files: string[] = [];
  await collectFiles(root, '', files);
  for (const extra of EXTRA_FILES) files.push(extra);
  for (const pkg of await workspacePackages()) {
    for (const extra of EXTRA_FILE_NAMES) files.push(`packages/${pkg}/${extra}`);
  }
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
    violations.push(...scan(relPath, isProseFile(relPath) ? text : commentsOnly(relPath, text)));
  }
  violations.push(...(await checkProjectIsolationClaims(files)));
  violations.sort((a, b) => (a.file === b.file ? a.line - b.line : a.file < b.file ? -1 : 1));

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
