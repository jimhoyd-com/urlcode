import { readFile } from 'node:fs/promises';
import { ConfigError, assert } from './errors.ts';
import { isCode, isRecord } from './object-guards.ts';
import type { ExtensionAuthoringContract, ExtensionHookContract } from './extensions.ts';

/**
 * Add-on-owned, inert pointers for agents. The add-on remains the source of
 * truth: core only transports this bounded metadata after pin verification.
 */
export interface AddonAgentReference { name: string; description: string; path: string }
export interface AddonAgentTooling { description: string; references: AddonAgentReference[] }

/**
 * Add-ons are the extensions and artifacts released with core. Both have one shape: a package named
 * `@jimhoyd/urlcode-<name>` carrying a static `urlcode.json` descriptor, released as a tarball on the same GitHub
 * Release as core and at the same version. Core pins every one of them: the release build writes `addons.json`
 * (name, kind, requirements, download URL and sha512 integrity) into core's own `dist/` before core is packed, so
 * the trust in core's npm provenance extends to every add-on it installs. There is no other install catalog: the
 * `addon-catalog.json` beside it (`readAddonCatalog`) is agent discovery metadata only and pins nothing.
 *
 * An extension is executable and wired into host.mjs; an artifact is inert data for tooling and is never imported.
 */
export type AddonKind = 'extension' | 'artifact';
export interface AddonPin {
  kind: AddonKind;
  package: string;
  description: string;
  requires: string[];
  /** A release asset URL, or a `file:` path in a development manifest. */
  url: string;
  /** npm-style sha512 SRI of the tarball; null only for a development manifest's `file:` directories. */
  integrity: string | null;
}
export interface AddonManifest { format: 1; version: string; addons: Record<string, AddonPin> }
/** The static descriptor every add-on package carries as `urlcode.json`. */
export interface AddonDescriptor {
  kind: AddonKind;
  name: string;
  description: string;
  requires: string[];
  /**
   * Extensions this one hands a value through `contributes` (for example `["ui"]`), sorted. An optional edge in the
   * add-on graph: unlike `requires`, the target need not be installed.
   */
  contributes?: string[];
  schema?: object;
  policySchema?: object;
  hooks?: ExtensionHookContract[];
  authoring?: ExtensionAuthoringContract;
  agent?: AddonAgentTooling;
}

export const addonNamePattern = /^[a-z][a-z0-9-]{0,63}$/;
export const addonPackage = (name: string): string => `@jimhoyd/urlcode-${name}`;
const integrityPattern = /^sha512-[A-Za-z0-9+/]{86}==$/;
const releaseUrl = /^https:\/\/github\.com\/jimhoyd-com\/urlcode\/releases\/download\/v[0-9A-Za-z.-]+\/[A-Za-z0-9._-]+\.tgz$/;

export function parseAddonManifest(raw: unknown, source: string): AddonManifest {
  assert(isRecord(raw) && raw.format === 1 && typeof raw.version === 'string' && isRecord(raw.addons), `${source} is not an add-on manifest`);
  const addons: Record<string, AddonPin> = Object.create(null) as Record<string, AddonPin>;
  for (const [name, value] of Object.entries(raw.addons)) {
    assert(addonNamePattern.test(name) && isRecord(value), `${source}: invalid add-on ${name}`);
    const { kind, package: pkg, description, requires, url, integrity } = value;
    assert(kind === 'extension' || kind === 'artifact', `${source}: ${name} has an unknown kind`);
    assert(pkg === addonPackage(name) && typeof description === 'string' && Array.isArray(requires) && requires.every(item => typeof item === 'string' && addonNamePattern.test(item)), `${source}: ${name} is malformed`);
    assert(typeof url === 'string' && (releaseUrl.test(url) || url.startsWith('file:')), `${source}: ${name} has an invalid URL`);
    assert(integrity === null ? url.startsWith('file:') : typeof integrity === 'string' && integrityPattern.test(integrity), `${source}: ${name} must pin a sha512 integrity`);
    addons[name] = { kind, package: pkg, description, requires: [...requires] as string[], url, integrity: integrity as string | null };
  }
  for (const [name, pin] of Object.entries(addons)) for (const requirement of pin.requires) assert(Object.hasOwn(addons, requirement), `${source}: ${name} requires ${requirement}, which the manifest does not list`);
  return { format: 1, version: raw.version, addons };
}

/**
 * The add-on manifest of the running core: `dist/addons.json` in an installed package or a built checkout.
 * `URLCODE_ADDONS` names another manifest file (tests and local development).
 */
export async function readAddonManifest(): Promise<AddonManifest> {
  const candidates = process.env.URLCODE_ADDONS ? [process.env.URLCODE_ADDONS] : [new URL('./addons.json', import.meta.url), new URL('../../../dist/addons.json', import.meta.url)];
  for (const candidate of candidates) {
    let text: string;
    try { text = await readFile(candidate, 'utf8'); } catch (error) { if (isCode(error, 'ENOENT')) continue; throw error; }
    return parseAddonManifest(JSON.parse(text), String(candidate));
  }
  throw new ConfigError('This core has no add-on manifest (dist/addons.json). A released core always has one; in a source checkout run `npm run build` first');
}

/** True when every pin points at a local `file:` source: a development manifest from `npm run build`, never a release. */
export const isDevelopmentManifest = (manifest: AddonManifest): boolean => Object.values(manifest.addons).some(pin => pin.integrity === null);

/** `names` plus everything they require, transitively, each once. */
export function withRequirements(manifest: AddonManifest, names: readonly string[]): string[] {
  const result = new Set<string>();
  const visit = (name: string): void => {
    if (result.has(name)) return;
    const pin = manifest.addons[name];
    assert(pin, `Unknown add-on ${name}`);
    for (const requirement of pin.requires) visit(requirement);
    result.add(name);
  };
  for (const name of names) visit(name);
  return [...result];
}

function assertAgentTooling(agent: unknown, source: string): asserts agent is AddonAgentTooling {
  assert(isRecord(agent) && typeof agent.description === 'string' && agent.description.length > 0 && agent.description.length <= 300 && Array.isArray(agent.references), `${source}: agent tooling is malformed`);
  for (const reference of agent.references) assert(isRecord(reference) && typeof reference.name === 'string' && reference.name.length > 0 && reference.name.length <= 128 && typeof reference.description === 'string' && reference.description.length > 0 && reference.description.length <= 300 && typeof reference.path === 'string' && /^(?:[A-Za-z0-9][A-Za-z0-9._-]*\/)*[A-Za-z0-9][A-Za-z0-9._-]*\.(?:md|json)$/.test(reference.path), `${source}: agent reference must name a bounded local .md or .json file`);
}

export function parseDescriptor(raw: unknown, source: string): AddonDescriptor {
  assert(isRecord(raw) && (raw.kind === 'extension' || raw.kind === 'artifact') && typeof raw.name === 'string' && addonNamePattern.test(raw.name) && typeof raw.description === 'string', `${source} is not an add-on descriptor`);
  assert(Array.isArray(raw.requires) && raw.requires.every(item => typeof item === 'string'), `${source}: requires must be a list of names`);
  assert(raw.contributes === undefined || Array.isArray(raw.contributes) && raw.contributes.every(item => typeof item === 'string' && addonNamePattern.test(item) && item !== raw.name), `${source}: contributes must be a list of other extension names`);
  if (raw.agent !== undefined) assertAgentTooling(raw.agent, source);
  if (raw.kind === 'artifact') assert(raw.schema === undefined && raw.policySchema === undefined && raw.hooks === undefined && raw.authoring === undefined && raw.contributes === undefined, `${source}: an artifact descriptor carries no extension contract`);
  else assert(isRecord(raw.schema), `${source}: an extension descriptor needs its configuration schema`);
  return raw as unknown as AddonDescriptor;
}

/**
 * The release-wide add-on agent catalog (#721): `addon-catalog.json`, shipped next to `addons.json` in core's `dist/`.
 * Every add-on of this core's release, from its signed `urlcode.json` descriptor: name, package, version, kind,
 * description, requirements and, when the descriptor declares it, its agent tooling (reference `path`s are relative
 * to that add-on's package). Discovery metadata only: listing an add-on here is not evidence that a project installed
 * or activated it; installed components are the local MCP's concern (`get_extensions`, `get_extension_artifacts`,
 * `get_addon_agent_tooling`). Reading it imports no add-on, fetches nothing and activates nothing.
 */
export interface AddonCatalogEntry { name: string; kind: AddonKind; package: string; version: string; description: string; requires: string[]; agent?: AddonAgentTooling }
export interface AddonCatalog { format: 1; scope: 'release'; version: string; addons: AddonCatalogEntry[] }
/** One add-on's signed descriptor and the package that carries it. */
export interface AddonCatalogSource { descriptor: unknown; package: string; version: string; source: string }

const entryOf = (descriptor: AddonDescriptor, pkg: string, version: string): AddonCatalogEntry => ({
  name: descriptor.name, kind: descriptor.kind, package: pkg, version, description: descriptor.description, requires: [...descriptor.requires],
  ...(descriptor.agent ? { agent: { description: descriptor.agent.description, references: descriptor.agent.references.map(({ name, description, path }) => ({ name, description, path })) } } : {}),
});
function checkCatalog(catalog: AddonCatalog, source: string): AddonCatalog {
  const names = catalog.addons.map(entry => entry.name);
  assert(new Set(names).size === names.length, `${source}: an add-on is listed twice`);
  for (const entry of catalog.addons) {
    assert(entry.version === catalog.version, `${source}: ${entry.name} is ${entry.version}; every add-on shares core's version ${catalog.version}`);
    for (const requirement of entry.requires) assert(names.includes(requirement), `${source}: ${entry.name} requires ${requirement}, which the catalog does not list`);
  }
  return catalog;
}

/** Builds the catalog from every add-on's descriptor, sorted by name. Pure: the build and the release both call it. */
export function buildAddonCatalog(version: string, sources: readonly AddonCatalogSource[]): AddonCatalog {
  const addons = sources.map(({ descriptor, package: pkg, version: addonVersion, source }) => {
    const parsed = parseDescriptor(descriptor, source);
    assert(pkg === addonPackage(parsed.name), `${source}: ${parsed.name} must be packaged as ${addonPackage(parsed.name)}`);
    return entryOf(parsed, pkg, addonVersion);
  }).sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
  return checkCatalog({ format: 1, scope: 'release', version, addons }, 'add-on catalog');
}

export function parseAddonCatalog(raw: unknown, source: string): AddonCatalog {
  assert(isRecord(raw) && raw.format === 1 && raw.scope === 'release' && typeof raw.version === 'string' && Array.isArray(raw.addons), `${source} is not an add-on catalog`);
  const addons = raw.addons.map((value: unknown) => {
    assert(isRecord(value) && typeof value.name === 'string' && addonNamePattern.test(value.name), `${source}: invalid add-on entry`);
    const { name, kind, package: pkg, version, description, requires, agent } = value;
    assert((kind === 'extension' || kind === 'artifact') && pkg === addonPackage(name) && typeof version === 'string' && typeof description === 'string'
      && Array.isArray(requires) && requires.every(item => typeof item === 'string' && addonNamePattern.test(item)), `${source}: ${name} is malformed`);
    if (agent !== undefined) assertAgentTooling(agent, `${source}: ${name}`);
    return entryOf({ kind, name, description, requires: requires as string[], ...(agent ? { agent } : {}) }, pkg, version);
  });
  return checkCatalog({ format: 1, scope: 'release', version: raw.version, addons }, source);
}

/**
 * The release-wide add-on catalog of the running core: `dist/addon-catalog.json` beside `dist/addons.json`, or `file`
 * when given. Reads one JSON file; never imports, installs, fetches or activates an add-on.
 */
export async function readAddonCatalog(file?: string | URL): Promise<AddonCatalog> {
  const candidates = file !== undefined ? [file] : [new URL('./addon-catalog.json', import.meta.url), new URL('../../../dist/addon-catalog.json', import.meta.url)];
  for (const candidate of candidates) {
    let text: string;
    try { text = await readFile(candidate, 'utf8'); } catch (error) { if (isCode(error, 'ENOENT')) continue; throw error; }
    return parseAddonCatalog(JSON.parse(text), String(candidate));
  }
  throw new ConfigError('This core has no add-on catalog (dist/addon-catalog.json). A released core always has one; in a source checkout run `npm run build` first');
}
