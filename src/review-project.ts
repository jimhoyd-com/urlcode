import { loadDocument } from './config.ts';
import { prepareFunctionSnapshot } from './policy.ts';

/**
 * v1 of the `review_project` capability (issue #428, scoped down in the
 * issue discussion): detect exactly one pattern — hand-written JSON body
 * validation in function/middleware source that duplicates the declarative
 * `request.body.schema` capability (src/body-schema.ts). No other pattern
 * types, and no native-alternative/extension-alternative/gap/manual-review
 * taxonomy, ship in this v1; see docs/TOOLING.md.
 *
 * This is read-only and deterministic: it reuses `prepareFunctionSnapshot`
 * (which itself is built on `collectSourcesFor`/`collectTrustedSources` in
 * function-sources.ts) for loading function/middleware source text. That
 * collector already never executes or imports project code, never reads
 * env/secret bindings, never makes network calls, and stays within the
 * existing per-module/total byte budgets — this module adds no new file
 * access and no new trust boundary, only a lexical scan over source text
 * already loaded for other tooling.
 */
export type ReviewPattern = 'manual-body-validation';
export interface ReviewFinding { file: string; line?: number; pattern: ReviewPattern; suggestion: string }
export interface ReviewProjectResult { format: 1; findings: ReviewFinding[]; truncated?: boolean }

/** Bounded like every other MCP/CLI tool result in this codebase (agent-context.ts caps search_docs at 3 hits, capability catalogs page). */
export const REVIEW_FINDINGS_LIMIT = 50;

const bodySchemaSuggestion = 'Use request.body.schema instead of hand-written validation';

// Deliberately conservative: matched only against a line that itself names
// `request.body` or a single whole-body alias (`const body = request.body`).
// Destructured per-field aliases (`const { name } = request.body`) are not
// tracked, because a short field name is too easy to collide with unrelated
// code elsewhere in the same file; missing that case is preferred over a
// false positive here (see issue #428 discussion).
const validationShapes: RegExp[] = [
  /\bJSON\.parse\s*\(/,
  /\btypeof\s+\S+\s*(===|!==)\s*['"]/,
  /\bArray\.isArray\s*\(/,
  // Required-field-shaped checks: `!x.y`, `x.y === undefined`, `x.y == null`, etc.
  /!\s*[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+\b/,
  /[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+\s*(?:===|==|!==|!=)\s*(?:undefined|null)\b/,
];

const bodyAliasPattern = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*request\.body\b(?!\s*\.)/g;

function moduleFindings(file: string, source: string): ReviewFinding[] {
  const aliases = new Set<string>();
  for (const match of source.matchAll(bodyAliasPattern)) aliases.add(match[1]!);
  const findings: ReviewFinding[] = [];
  const lines = source.split('\n');
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    const referencesBody = line.includes('request.body') || [...aliases].some(alias => new RegExp(`\\b${alias}\\b`).test(line));
    if (!referencesBody) continue;
    if (!validationShapes.some(shape => shape.test(line))) continue;
    findings.push({ file, line: index + 1, pattern: 'manual-body-validation', suggestion: bodySchemaSuggestion });
  }
  return findings;
}

/**
 * Scans every function/middleware module reachable from the project's routes
 * (sandboxed and trusted alike, exactly the set `prepareFunctionSnapshot`
 * already assembles for policy pinning) for hand-written `request.body`
 * validation. Read-only: no project code runs.
 */
export async function reviewProject(project: string): Promise<ReviewProjectResult> {
  const loaded = await loadDocument(project);
  const snapshot = await prepareFunctionSnapshot(loaded);
  const findings: ReviewFinding[] = [];
  for (const [file, source] of Object.entries(snapshot.sources)) {
    findings.push(...moduleFindings(file, source));
    if (findings.length >= REVIEW_FINDINGS_LIMIT) break;
  }
  const truncated = findings.length > REVIEW_FINDINGS_LIMIT;
  return { format: 1, findings: findings.slice(0, REVIEW_FINDINGS_LIMIT), ...(truncated ? { truncated: true } : {}) };
}
