// A package's peer floor must include every core API the package needs.
//
// A peer range is the compatibility contract: a package that calls something
// core added after the range's lower bound is broken against the very core the
// range still allows (#346: the store scaffold refuses without an --ack acknowledgement
// while core 0.4.2 rejects that flag). Tests that run against the workspace or the
// floor cannot see it, because they never exercise the older core's CLI. This
// table makes the requirement explicit and checkable.
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import semver from 'semver';
import ts from 'typescript';

export const coreName = '@jimhoyd/urlcode';

/**
 * `ScaffoldRequest`/`ScaffoldResult` (src/extensions.ts) members introduced after the
 * baseline below, mapped to the first core release that contains them. A package whose
 * scaffold uses one needs a core peer floor at or above it. When a core release ships
 * under a different number than the one recorded here, correct the entry in the same
 * pull request; `test/peer-api.test.ts` fails when a new member has no decision.
 */
export const scaffoldApiSince: Readonly<Record<string, string>> = {
  acknowledgements: '0.4.3', acknowledged: '0.4.3', routeNotes: '0.4.3', // #343, #354
  provides: '0.4.3', requires: '0.4.3', after: '0.4.3', conflicts: '0.4.3', // #342
  // Bundle-backed scaffolding is new in the next core release. Packages that
  // consume either member must not claim compatibility with 0.4.8, which has
  // no verified-bundle initializer or generated bundle host.
  distribution: '0.4.9', hostBundleExports: '0.4.9', // #398
};
/**
 * Other core API introduced after core 0.4.2 that package source imports or sets, wherever it appears in `src/`
 * (an extension's `authoring` contract, #285). Only names distinctive enough not to collide with ordinary properties.
 */
export const coreApiSince: Readonly<Record<string, string>> = {
  authoring: '0.4.3', ExtensionAuthoringContract: '0.4.3', ExtensionAuthoringSurface: '0.4.3', ExtensionAuthoringKind: '0.4.3',
};
/** Members already present in every published core a peer range can allow (core 0.4.2 and earlier). */
export const scaffoldApiBaseline: readonly string[] = [
  'directory', 'project', 'hostFile', 'names',
  'name', 'extensions', 'routes', 'hostImports', 'hostSetup', 'hostEntries', 'hostClose', 'files', 'readme', 'nextSteps', 'env',
  'path', 'content', 'mode',
];

export interface ApiUse { field: string; since: string }
export interface PeerApiViolation extends ApiUse { floor: string }

function collectNames(node: ts.Node, names: Set<string>): void {
  if ((ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node) || ts.isPropertySignature(node) || ts.isMethodSignature(node)) && ts.isIdentifier(node.name)) names.add(node.name.text);
  else if (ts.isPropertyAccessExpression(node)) names.add(node.name.text);
  else if (ts.isImportSpecifier(node)) names.add((node.propertyName ?? node.name).text);
  else if (ts.isBindingElement(node)) {
    const key = node.propertyName ?? node.name;
    if (ts.isIdentifier(key)) names.add(key.text);
  }
  ts.forEachChild(node, child => collectNames(child, names));
}
/** Property names a TypeScript source uses, ignoring comments and string contents. */
export function propertyNames(source: string): Set<string> {
  const names = new Set<string>();
  collectNames(ts.createSourceFile('scaffold.ts', source, ts.ScriptTarget.ES2024, true), names);
  return names;
}
/** Declared members of the scaffold contract interfaces in core's extensions source. */
export function scaffoldContractMembers(source: string): string[] {
  const members = new Set<string>();
  const file = ts.createSourceFile('extensions.ts', source, ts.ScriptTarget.ES2024, true);
  file.forEachChild(node => {
    if (ts.isInterfaceDeclaration(node) && ['ScaffoldRequest', 'ScaffoldResult', 'ScaffoldFile'].includes(node.name.text)) {
      for (const member of node.members) if (member.name && ts.isIdentifier(member.name)) members.add(member.name.text);
    }
  });
  return [...members];
}
export function apiUsed(source: string, since: Readonly<Record<string, string>> = scaffoldApiSince): ApiUse[] {
  const names = propertyNames(source);
  return Object.entries(since).filter(([field]) => names.has(field)).map(([field, version]) => ({ field, since: version }));
}
/** The uses a core peer range does not cover. An absent core peer is a violation for any use. */
export function peerApiViolations(uses: readonly ApiUse[], peers: Readonly<Record<string, string>> | undefined): PeerApiViolation[] {
  const range = peers?.[coreName];
  const floor = range === undefined ? undefined : semver.minVersion(range)?.version;
  return uses.filter(use => !floor || semver.lt(floor, use.since)).map(use => ({ ...use, floor: floor ?? 'none' }));
}
const newest = (violations: readonly PeerApiViolation[]): string => violations.map(item => item.since).sort(semver.compare).at(-1)!;
export function describeViolations(name: string, violations: readonly PeerApiViolation[]): string {
  return `${name}: it uses core API (${violations.map(item => `${item.field} since ${item.since}`).join(', ')}) that the declared ${coreName} peer floor ${violations[0]!.floor} does not include; raise the peer floor to >=${newest(violations)}, which needs that core release`;
}
/** Core API a package uses: the scaffold contract in `src/scaffold.ts`, and `coreApiSince` names anywhere in `src/`. */
export async function scaffoldApiUsed(root: string, directory: string): Promise<ApiUse[]> {
  const sourceDirectory = directory === '.' ? join('packages', 'core') : directory;
  let files: string[];
  try { files = (await readdir(join(root, sourceDirectory, 'src'), { recursive: true })).map(String).filter(file => file.endsWith('.ts')).sort(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  const uses = new Map<string, ApiUse>();
  for (const file of files) {
    const source = await readFile(join(root, sourceDirectory, 'src', file), 'utf8');
    for (const use of apiUsed(source, coreApiSince)) uses.set(use.field, use);
    if (file === 'scaffold.ts') for (const use of apiUsed(source)) uses.set(use.field, use);
  }
  return [...uses.values()];
}
/** Refuse to release a package whose peer floor allows a core that lacks an API it uses. */
export async function assertPeerFloorCoversApi(root: string, directory: string, name: string, peers: Readonly<Record<string, string>> | undefined): Promise<void> {
  // Core defines these APIs and has no peer on itself; only a package that consumes core has a floor to hold to.
  if (name === coreName) return;
  const violations = peerApiViolations(await scaffoldApiUsed(root, directory), peers);
  assert(violations.length === 0, violations.length ? describeViolations(name, violations) : '');
}
/**
 * The core peer range a selected package needs, or undefined when its floor already covers what it uses.
 * Keeps the declared upper bound. Only possible once the in-repo core has the API (`coreVersion >= since`).
 */
export function raisedCorePeer(name: string, uses: readonly ApiUse[], peers: Readonly<Record<string, string>> | undefined, coreVersion: string): string | undefined {
  const violations = peerApiViolations(uses, peers);
  if (!violations.length) return undefined;
  const needed = newest(violations);
  assert(semver.gte(coreVersion, needed), `${describeViolations(name, violations)}; core in this checkout is ${coreVersion}, so release core ${needed} first, or select all packages, whose peer floors advance together (release:run --version ${needed})`);
  const upper = /<\s*[^\s|]+/.exec(peers?.[coreName] ?? '')?.[0] ?? `<${semver.major(needed)}.${semver.minor(needed) + 1}.0`;
  return `>=${needed} ${upper}`;
}
