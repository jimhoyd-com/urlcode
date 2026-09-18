// The application-specific code ratio: of the lines an agent generated, how
// many are the idea and how many are plumbing. This module is the documented
// counting rule and has no I/O; the harness feeds it a manifest of generated
// files and stores the classified result beside the other metrics.
//
// Rule (see README.md, "The code ratio"):
// - A line is counted when it is not blank. Comments count: the agent wrote them.
// - Idea: files under `functions/` (any depth, either arm), plus any path the
//   task or the answer lists as an application module. A listed module names
//   a file exactly or a directory prefix.
// - Plumbing: every other generated file: routing (including `urlcode.yaml`),
//   servers, auth, sessions, middleware, validation, headers, static serving,
//   deployment, test scaffolding, config, lockfiles, documentation and the
//   published assets themselves.
// - Excluded: files the harness itself wrote into the workspace (the acceptance
//   fixture), dependency and build output directories, and version control.

export type LineKind = 'idea' | 'plumbing';
/** One generated file as the harness collected it: a workspace-relative POSIX path and its text. */
export interface GeneratedFile { path: string; content: string }
export interface ClassifiedFile { path: string; lines: number; kind: LineKind }
export interface CodeRatio {
  files: ClassifiedFile[]; idea: number; plumbing: number; total: number;
  /** idea / total, or null when nothing was generated. */
  ratio: number | null;
}

const ideaPrefixes = ['functions/'];
export const excludedSegments = new Set(['node_modules', '.git', 'dist', 'coverage', '.urlcode']);

/** Normalize a workspace path to POSIX, without a leading `./` or `/`. */
export function normalizePath(path: string): string { return path.replace(/\\/g,'/').replace(/^(?:\.\/)+/,'').replace(/^\/+/,''); }

/** True when the harness never counts this path: dependencies, build output, version control. */
export function isExcluded(path: string): boolean { return normalizePath(path).split('/').some(segment => excludedSegments.has(segment)); }

export function countLines(content: string): number { return content.split(/\r?\n/).filter(line => line.trim().length > 0).length; }

/** Classify one path. `modules` are task-declared application modules: exact files or directory prefixes. */
export function classify(path: string, modules: readonly string[] = []): LineKind {
  const file = normalizePath(path);
  const inside = (prefix: string) => { const dir = normalizePath(prefix).replace(/\/+$/,''); return dir.length > 0 && (file === dir || file.startsWith(`${dir}/`)); };
  if (ideaPrefixes.some(prefix => file.startsWith(prefix) || file.includes(`/${prefix}`))) return 'idea';
  return modules.some(inside) ? 'idea' : 'plumbing';
}

/** Pure: the code ratio of a manifest. Excluded paths are dropped; the rest are classified and counted. */
export function codeRatio(files: readonly GeneratedFile[], modules: readonly string[] = []): CodeRatio {
  const classified = files.filter(file => !isExcluded(file.path))
    .map(file => ({ path: normalizePath(file.path), lines: countLines(file.content), kind: classify(file.path, modules) }))
    .sort((a,b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const idea = classified.filter(file => file.kind === 'idea').reduce((sum,file) => sum + file.lines, 0);
  const plumbing = classified.filter(file => file.kind === 'plumbing').reduce((sum,file) => sum + file.lines, 0);
  const total = idea + plumbing;
  return { files: classified, idea, plumbing, total, ratio: total === 0 ? null : idea / total };
}
