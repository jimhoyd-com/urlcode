import { readFile } from 'node:fs/promises';
import { ConfigError, assert } from './errors.ts';
import { isCode, isRecord } from './object-guards.ts';
import type { ExtensionAuthoringContract, ExtensionHookContract } from './extensions.ts';

/**
 * Add-ons are the extensions and artifacts released with core. Both have one shape: a package named
 * `@jimhoyd/urlcode-<name>` carrying a static `urlcode.json` descriptor, released as a tarball on the same GitHub
 * Release as core and at the same version. Core pins every one of them: the release build writes `addons.json`
 * (name, kind, requirements, download URL and sha512 integrity) into core's own `dist/` before core is packed, so
 * the trust in core's npm provenance extends to every add-on it installs. There is no other catalog.
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
  schema?: object;
  policySchema?: object;
  hooks?: ExtensionHookContract[];
  authoring?: ExtensionAuthoringContract;
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

export function parseDescriptor(raw: unknown, source: string): AddonDescriptor {
  assert(isRecord(raw) && (raw.kind === 'extension' || raw.kind === 'artifact') && typeof raw.name === 'string' && addonNamePattern.test(raw.name) && typeof raw.description === 'string', `${source} is not an add-on descriptor`);
  assert(Array.isArray(raw.requires) && raw.requires.every(item => typeof item === 'string'), `${source}: requires must be a list of names`);
  if (raw.kind === 'artifact') assert(raw.schema === undefined && raw.policySchema === undefined && raw.hooks === undefined && raw.authoring === undefined, `${source}: an artifact descriptor carries no extension contract`);
  else assert(isRecord(raw.schema), `${source}: an extension descriptor needs its configuration schema`);
  return raw as unknown as AddonDescriptor;
}
