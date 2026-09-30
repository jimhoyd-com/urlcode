import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ConfigError, assert } from './errors.ts';
import { isCode, isRecord } from './object-guards.ts';
import type { ExtensionAuthoringContract, ExtensionHookContract, RuntimeExtension } from './extensions.ts';
import { openApiSecurityProblem } from './openapi-security.ts';
import type { ExtensionOpenApiSecurity } from './openapi-security.ts';

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
  /** Add-ons this one uses when installed (an optional edge, never installed with it), sorted; absent when none. */
  uses?: string[];
  /** A release asset URL, or a `file:` path in a development manifest. */
  url: string;
  /** npm-style sha512 SRI of the tarball; null only for a development manifest's `file:` directories. */
  integrity: string | null;
}
export interface AddonManifest { format: 1; version: string; addons: Record<string, AddonPin> }
/**
 * The standard document media types an artifact descriptor may list (#844), each with the file extensions it may
 * carry. A closed set: OpenAPI (YAML or JSON), JSON Schema, Markdown and plain JSON or YAML data.
 */
export const artifactMediaTypes = {
  'application/vnd.oai.openapi': ['.yaml', '.yml'],
  'application/vnd.oai.openapi+json': ['.json'],
  'application/schema+json': ['.json'],
  'text/markdown': ['.md'],
  'application/json': ['.json'],
  'application/yaml': ['.yaml', '.yml'],
} as const satisfies Record<string, readonly string[]>;
export type ArtifactMediaType = keyof typeof artifactMediaTypes;
/** One standard document an artifact ships, by its path inside the package. */
export interface ArtifactDocument { path: string; mediaType: ArtifactMediaType }
export const MAX_ARTIFACT_DOCUMENTS = 32;
/** A relative path inside a package: at most eight segments, none of them empty, `.`, `..` or hidden. */
export const packageDataPath = /^(?:[A-Za-z0-9][A-Za-z0-9._-]*\/){0,7}[A-Za-z0-9][A-Za-z0-9._-]*$/;
/** The static descriptor every add-on package carries as `urlcode.json`. */
export interface AddonDescriptor {
  kind: AddonKind;
  name: string;
  /**
   * The URLCode extension contract (`extensionContract`) the package is built for. Required; any value other than
   * the running core's is refused (`contractProblem`). The build writes it for first-party packages.
   */
  contract: number;
  description: string;
  requires: string[];
  /**
   * Extensions this one reads through `ctx.get` when they are installed (`ExtensionDefinition.uses`), sorted. An
   * optional edge: never added to the `requires` closure, so installing this add-on never installs them.
   */
  uses?: string[];
  /**
   * An extension's declared deployment targets (`ExtensionDefinition.targets`), in `extensionTargetNames` order. Its
   * registration refuses every other target at activation, so the capability preflight reads them to refuse a
   * project that uses the extension on such a target before any host file is loaded. Absent for an artifact.
   */
  targets?: ExtensionTarget[];
  /**
   * The extension's `authorize()` sets the request principal (`ExtensionDefinition.providesPrincipal`,
   * RIM-EXT-PRINCIPAL-001). Written only when true. The route `auth:` short form expands to the one declared extension
   * whose descriptor says so, and OpenAPI and review treat a route it gates as signed-in. Absent for an artifact.
   */
  providesPrincipal?: true;
  /**
   * The standard OpenAPI security scheme of the credential a principal provider verifies
   * (`ExtensionDefinition.openapiSecurity`), which the OpenAPI export reads without running the extension. Only with
   * `providesPrincipal`; absent when the extension does not declare one.
   */
  openapiSecurity?: ExtensionOpenApiSecurity;
  schema?: object;
  policySchema?: object;
  hooks?: ExtensionHookContract[];
  authoring?: ExtensionAuthoringContract;
  agent?: AddonAgentTooling;
  /** An artifact's standard documents (#844), read only as data by `urlcode artifacts inspect`. */
  documents?: ArtifactDocument[];
}

export const addonNamePattern = /^[a-z][a-z0-9-]{0,63}$/;
/**
 * The URLCode extension contract this core implements (#844): one integer for everything a package relies on from
 * core — the `urlcode.json` descriptor format, `defineExtension`/`composeHost`, the registration and activation
 * interfaces, and the `@jimhoyd/urlcode/extensions` exports. It moves only on a breaking change to that contract,
 * never with core's own semver: a release that only adds to the contract keeps it. Every descriptor and every
 * `defineExtension` definition declares the contract it was built for as `contract`, and core refuses any other
 * value by name at `extensions add`/`artifacts add`, `list --strict`, static `validate` and activation.
 *
 * Contract 2 (#976) added the hermetic obligation (RIM-EXT-HERMETIC-001): a `host()` given `hermetic: true` keeps
 * every file under `context.data`. An extension built for contract 1 predates it, so it is refused rather than
 * trusted to honour it, and only a contract-2 `composeHost` confirms the data directory a hermetic load checks.
 */
export const extensionContract = 2;
/** Why a package's declared `contract` is missing or not this core's, naming both; undefined when they agree. */
export function contractProblem(declared: unknown, who: string): string | undefined {
  if (!isContractVersion(declared)) return `${who} must declare contract, the URLCode extension contract it is built for (this core implements ${extensionContract})`;
  return declared === extensionContract ? undefined : `${who} is built for URLCode extension contract ${declared}, but this core implements extension contract ${extensionContract}; install a version of it built for contract ${extensionContract}, or a core that implements contract ${declared}`;
}
/** A positive integer: the only shape a declared `contract` takes. */
export const isContractVersion = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
/**
 * The deployment targets an extension can declare (`ExtensionDefinition.targets`, `RuntimeExtension.targets`). A
 * Worker (cloudflare) and static hosting run no extension, so neither can be declared.
 */
export const extensionTargetNames = ['node', 'aws', 'vercel'] as const;
export type ExtensionTarget = typeof extensionTargetNames[number];
/** A non-empty list of distinct extension targets, in `extensionTargetNames` order. */
export function isExtensionTargets(value: unknown): value is ExtensionTarget[] {
  return Array.isArray(value) && value.length > 0 && new Set(value).size === value.length
    && value.every(item => (extensionTargetNames as readonly unknown[]).includes(item))
    && value.every((item, index) => index === 0 || extensionTargetNames.indexOf(value[index - 1] as ExtensionTarget) < extensionTargetNames.indexOf(item as ExtensionTarget));
}
export const addonPackage = (name: string): string => `@jimhoyd/urlcode-${name}`;
const integrityPattern = /^sha512-[A-Za-z0-9+/]{86}==$/;
const releaseUrl = /^https:\/\/github\.com\/jimhoyd-com\/urlcode\/releases\/download\/v[0-9A-Za-z.-]+\/[A-Za-z0-9._-]+\.tgz$/;

export function parseAddonManifest(raw: unknown, source: string): AddonManifest {
  assert(isRecord(raw) && raw.format === 1 && typeof raw.version === 'string' && isRecord(raw.addons), `${source} is not an add-on manifest`);
  const addons: Record<string, AddonPin> = Object.create(null) as Record<string, AddonPin>;
  for (const [name, value] of Object.entries(raw.addons)) {
    assert(addonNamePattern.test(name) && isRecord(value), `${source}: invalid add-on ${name}`);
    const { kind, package: pkg, description, requires, uses, url, integrity } = value;
    assert(kind === 'extension' || kind === 'artifact', `${source}: ${name} has an unknown kind`);
    assert(pkg === addonPackage(name) && typeof description === 'string' && Array.isArray(requires) && requires.every(item => typeof item === 'string' && addonNamePattern.test(item)), `${source}: ${name} is malformed`);
    assert(uses === undefined || Array.isArray(uses) && uses.every(item => typeof item === 'string' && addonNamePattern.test(item) && item !== name && !requires.includes(item)), `${source}: ${name} has malformed uses`);
    assert(typeof url === 'string' && (releaseUrl.test(url) || url.startsWith('file:')), `${source}: ${name} has an invalid URL`);
    assert(integrity === null ? url.startsWith('file:') : typeof integrity === 'string' && integrityPattern.test(integrity), `${source}: ${name} must pin a sha512 integrity`);
    addons[name] = { kind, package: pkg, description, requires: [...requires] as string[], ...(uses?.length ? { uses: [...uses as string[]].sort() } : {}), url, integrity: integrity as string | null };
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

/** `names` plus everything they require, transitively, each once. `uses` is an optional edge and is never followed. */
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

function assertDocuments(documents: unknown, source: string): asserts documents is ArtifactDocument[] {
  assert(Array.isArray(documents) && documents.length <= MAX_ARTIFACT_DOCUMENTS, `${source}: documents must be a list of at most ${MAX_ARTIFACT_DOCUMENTS} entries`);
  const paths = new Set<string>();
  for (const document of documents) {
    assert(isRecord(document) && Object.keys(document).every(key => key === 'path' || key === 'mediaType') && typeof document.path === 'string' && packageDataPath.test(document.path), `${source}: each document needs a relative package path (no \`..\`, no leading \`/\`) and a mediaType`);
    const extensions: readonly string[] | undefined = typeof document.mediaType === 'string' && Object.hasOwn(artifactMediaTypes, document.mediaType) ? artifactMediaTypes[document.mediaType as ArtifactMediaType] : undefined;
    assert(extensions, `${source}: document ${document.path} has mediaType ${String(document.mediaType)}; use one of ${Object.keys(artifactMediaTypes).join(', ')}`);
    const path = document.path;
    assert(extensions.some(extension => path.endsWith(extension)), `${source}: document ${path} must end in ${extensions.join(' or ')} for ${String(document.mediaType)}`);
    assert(!paths.has(document.path), `${source}: document ${document.path} is listed twice`);
    paths.add(document.path);
  }
}

function assertOpenApiSecurity(value: unknown, provides: boolean, source: string): asserts value is ExtensionOpenApiSecurity {
  const problem = openApiSecurityProblem(value);
  assert(problem === undefined, `${source}: ${problem}`);
  assert(provides, `${source}: openapiSecurity is declared only by an extension that provides the request principal`);
}

export function parseDescriptor(raw: unknown, source: string): AddonDescriptor {
  assert(isRecord(raw) && (raw.kind === 'extension' || raw.kind === 'artifact') && typeof raw.name === 'string' && addonNamePattern.test(raw.name) && typeof raw.description === 'string', `${source} is not an add-on descriptor`);
  assert(isContractVersion(raw.contract), `${source}: contract must be the URLCode extension contract the package is built for, a positive integer (this core implements ${extensionContract})`);
  assert(Array.isArray(raw.requires) && raw.requires.every(item => typeof item === 'string'), `${source}: requires must be a list of names`);
  assert(raw.uses === undefined || Array.isArray(raw.uses) && raw.uses.every(item => typeof item === 'string' && addonNamePattern.test(item) && item !== raw.name && !(raw.requires as unknown[]).includes(item)) && new Set(raw.uses).size === raw.uses.length, `${source}: uses must be a list of other extension names, disjoint from requires`);
  if (raw.agent !== undefined) assertAgentTooling(raw.agent, source);
  if (raw.kind === 'artifact') {
    assert(raw.schema === undefined && raw.policySchema === undefined && raw.hooks === undefined && raw.authoring === undefined && raw.uses === undefined, `${source}: an artifact descriptor carries no extension schema, policySchema, hooks, authoring or uses`);
    assert(raw.targets === undefined && raw.providesPrincipal === undefined && raw.openapiSecurity === undefined, `${source}: an artifact descriptor declares no targets and provides no principal`);
    if (raw.documents !== undefined) assertDocuments(raw.documents, source);
  } else {
    assert(isRecord(raw.schema) && raw.documents === undefined, `${source}: an extension descriptor needs its configuration schema and lists no documents`);
    assert(isExtensionTargets(raw.targets), `${source}: an extension descriptor needs targets, a non-empty list of ${extensionTargetNames.join(', ')} in that order`);
    assert(raw.providesPrincipal === undefined || raw.providesPrincipal === true, `${source}: providesPrincipal is written only as true`);
    if (raw.openapiSecurity !== undefined) assertOpenApiSecurity(raw.openapiSecurity, raw.providesPrincipal === true, source);
  }
  return (Array.isArray(raw.uses) ? { ...raw, uses: [...raw.uses as string[]].sort() } : raw) as unknown as AddonDescriptor;
}

/**
 * The release-wide add-on agent catalog (#721): `addon-catalog.json`, shipped next to `addons.json` in core's `dist/`.
 * Every add-on of this core's release, from its signed `urlcode.json` descriptor: name, package, version, kind,
 * description, requirements, an extension's `targets`, an artifact's `documents` (path and media type, never contents) and, when the descriptor
 * declares it, its agent tooling (reference and document `path`s are relative to that add-on's package). Discovery metadata only: listing an add-on here is not evidence that a project installed
 * or activated it; installed components are the local MCP's concern (`get_extensions`, `get_extension_artifacts`,
 * `get_addon_agent_tooling`). Reading it imports no add-on, fetches nothing and activates nothing.
 */
export interface AddonCatalogEntry {
  name: string; kind: AddonKind; package: string; version: string; description: string; requires: string[]; uses?: string[];
  /** An extension's declared deployment targets (#859), in `extensionTargetNames` order; absent for an artifact. */
  targets?: ExtensionTarget[];
  /** The extension sets the request principal (its descriptor's `providesPrincipal`); absent otherwise. */
  providesPrincipal?: true;
  /** The principal provider's declared OpenAPI security scheme (its descriptor's `openapiSecurity`); absent otherwise. */
  openapiSecurity?: ExtensionOpenApiSecurity;
  /** An artifact's standard documents (#857): path and media type only, never contents, at most `MAX_ARTIFACT_DOCUMENTS`. */
  documents?: ArtifactDocument[];
  agent?: AddonAgentTooling;
  /** An extension's authoring contract from its descriptor (#913): what `plan-feature` matches a goal against before anything is installed. */
  authoring?: ExtensionAuthoringContract;
}
export interface AddonCatalog { format: 1; scope: 'release'; version: string; addons: AddonCatalogEntry[] }
/** One add-on's signed descriptor and the package that carries it. */
export interface AddonCatalogSource { descriptor: unknown; package: string; version: string; source: string }

const entryOf = (descriptor: Omit<AddonDescriptor, 'contract'>, pkg: string, version: string): AddonCatalogEntry => ({
  name: descriptor.name, kind: descriptor.kind, package: pkg, version, description: descriptor.description, requires: [...descriptor.requires],
  ...(descriptor.uses?.length ? { uses: [...descriptor.uses] } : {}),
  ...(descriptor.targets ? { targets: [...descriptor.targets] } : {}),
  ...(descriptor.providesPrincipal ? { providesPrincipal: true as const } : {}),
  ...(descriptor.openapiSecurity ? { openapiSecurity: structuredClone(descriptor.openapiSecurity) } : {}),
  ...(descriptor.documents?.length ? { documents: descriptor.documents.map(({ path, mediaType }) => ({ path, mediaType })) } : {}),
  ...(descriptor.agent ? { agent: { description: descriptor.agent.description, references: descriptor.agent.references.map(({ name, description, path }) => ({ name, description, path })) } } : {}),
  ...(descriptor.kind === 'extension' && descriptor.authoring ? { authoring: structuredClone(descriptor.authoring) as ExtensionAuthoringContract } : {}),
});
/** An authoring surface's planner goal words: at most 32 distinct lowercase words, each at most 32 characters. */
export function isAuthoringGoals(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.length <= 32 && new Set(value).size === value.length && value.every(goal => typeof goal === 'string' && /^[a-z0-9][a-z0-9-]{0,31}$/.test(goal));
}
/** The planner-facing shape of an authoring contract read from a descriptor or catalog; anything else is left out. */
function assertAuthoring(authoring: unknown, source: string): asserts authoring is ExtensionAuthoringContract {
  assert(isRecord(authoring) && typeof authoring.description === 'string' && Array.isArray(authoring.surfaces) && authoring.surfaces.length <= 64
    && authoring.surfaces.every(surface => isRecord(surface) && typeof surface.name === 'string' && typeof surface.kind === 'string' && typeof surface.description === 'string' && (surface.goals === undefined || isAuthoringGoals(surface.goals))), `${source}: authoring contract is malformed`);
}
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
    const { name, kind, package: pkg, version, description, requires, uses, targets, providesPrincipal, openapiSecurity, documents, agent, authoring } = value;
    assert((kind === 'extension' || kind === 'artifact') && pkg === addonPackage(name) && typeof version === 'string' && typeof description === 'string'
      && Array.isArray(requires) && requires.every(item => typeof item === 'string' && addonNamePattern.test(item)), `${source}: ${name} is malformed`);
    assert(uses === undefined || Array.isArray(uses) && uses.every(item => typeof item === 'string' && addonNamePattern.test(item) && item !== name && !requires.includes(item)), `${source}: ${name} has malformed uses`);
    if (agent !== undefined) assertAgentTooling(agent, `${source}: ${name}`);
    if (documents !== undefined) { assert(kind === 'artifact', `${source}: ${name} is an extension, which lists no documents`); assertDocuments(documents, `${source}: ${name}`); }
    assert(kind === 'extension' ? isExtensionTargets(targets) : targets === undefined, `${source}: ${name} has malformed targets`);
    assert(providesPrincipal === undefined || providesPrincipal === true && kind === 'extension', `${source}: ${name} has a malformed providesPrincipal`);
    if (openapiSecurity !== undefined) assertOpenApiSecurity(openapiSecurity, providesPrincipal === true, `${source}: ${name}`);
    if (authoring !== undefined) { assert(kind === 'extension', `${source}: ${name} is an artifact, which has no authoring contract`); assertAuthoring(authoring, `${source}: ${name}`); }
    return entryOf({ kind, name, description, requires: requires as string[], ...(Array.isArray(uses) && uses.length ? { uses: [...uses as string[]].sort() } : {}), ...(kind === 'extension' ? { targets: targets as ExtensionTarget[] } : {}), ...(providesPrincipal === true ? { providesPrincipal: true as const } : {}), ...(openapiSecurity ? { openapiSecurity } : {}), ...(documents ? { documents } : {}), ...(agent ? { agent } : {}), ...(authoring ? { authoring } : {}) }, pkg, version);
  });
  return checkCatalog({ format: 1, scope: 'release', version: raw.version, addons }, source);
}

/**
 * The release-wide add-on catalog of the running core: `dist/addon-catalog.json` beside `dist/addons.json`, or `file`
 * when given. Reads one JSON file; never imports, installs, fetches or activates an add-on.
 */
const catalogCandidates = (): URL[] => [new URL('./addon-catalog.json', import.meta.url), new URL('../../../dist/addon-catalog.json', import.meta.url)];
const noCatalog = (): ConfigError => new ConfigError('This core has no add-on catalog (dist/addon-catalog.json). A released core always has one; in a source checkout run `npm run build` first');
export async function readAddonCatalog(file?: string | URL): Promise<AddonCatalog> {
  const candidates = file !== undefined ? [file] : catalogCandidates();
  for (const candidate of candidates) {
    let text: string;
    try { text = await readFile(candidate, 'utf8'); } catch (error) { if (isCode(error, 'ENOENT')) continue; throw error; }
    return parseAddonCatalog(JSON.parse(text), String(candidate));
  }
  throw noCatalog();
}

/** Each extension's declared targets from a catalog, keyed by name: what the capability preflight reads without a host file. */
export function declaredExtensionTargets(catalog: AddonCatalog): Map<string, ExtensionTarget[]> {
  return new Map(catalog.addons.filter(entry => entry.targets).map(entry => [entry.name, [...entry.targets!]]));
}

const readJson = async <T>(path: string): Promise<T> => JSON.parse(await readFile(path, 'utf8')) as T;
/**
 * One installed add-on package, found by the `urlcode.json` descriptor at its package root rather than by its name
 * (#844): `catalog` is true for a package core's own manifest pins; any other package is independent, installed by the
 * operator and checked against npm's own lock integrity.
 */
export interface InstalledProvider { name: string; package: string; descriptor: AddonDescriptor; catalog: boolean }
/**
 * A problem with one installed descriptor, attributed to the kind of add-on list that reports it (#857): a duplicate
 * provider to the kind of the package that was set aside, an unreadable descriptor to the kind it claims (extension
 * when it claims none), so `extensions list` and `artifacts list` never both report the same problem.
 */
export interface ProviderProblem { kind: AddonKind; message: string }
/** Every direct dependency of the site that carries an add-on descriptor, by logical name. Reads data only; imports nothing. */
export async function installedProviders(site: string, manifest?: AddonManifest): Promise<{ providers: Map<string, InstalledProvider>; problems: ProviderProblem[] }> {
  const providers = new Map<string, InstalledProvider>(), problems: ProviderProblem[] = [];
  let pkg: { dependencies?: Record<string, string> };
  try { pkg = await readJson<{ dependencies?: Record<string, string> }>(join(site, 'package.json')); } catch (error) { if (isCode(error, 'ENOENT')) return { providers, problems }; throw error; }
  for (const dependency of Object.keys(pkg.dependencies ?? {}).sort()) {
    const path = join(site, 'node_modules', dependency, 'urlcode.json');
    let raw: unknown, descriptor: AddonDescriptor;
    try { raw = await readJson(path); descriptor = parseDescriptor(raw, path); }
    catch (error) {
      if (isCode(error, 'ENOENT') || isCode(error, 'ENOTDIR')) continue;
      problems.push({ kind: isRecord(raw) && raw.kind === 'artifact' ? 'artifact' : 'extension', message: error instanceof Error ? error.message : String(error) });
      continue;
    }
    const other = providers.get(descriptor.name);
    if (other) { problems.push({ kind: descriptor.kind, message: `${dependency} and ${other.package} both provide ${other.descriptor.kind === descriptor.kind ? `the ${descriptor.kind}` : `an ${other.descriptor.kind} and an ${descriptor.kind} named`} ${descriptor.name}; keep one` }); continue; }
    providers.set(descriptor.name, { name: descriptor.name, package: dependency, descriptor, catalog: manifest?.addons[descriptor.name]?.package === dependency });
  }
  return { providers, problems };
}
/** The descriptor of the package providing `name`: a site dependency that carries it, else the first-party install location. */
export async function readInstalledDescriptor(site: string, name: string): Promise<AddonDescriptor | undefined> {
  const provided = (await installedProviders(site)).providers.get(name);
  if (provided) return provided.descriptor;
  const path = join(site, 'node_modules', addonPackage(name), 'urlcode.json');
  try { return parseDescriptor(await readJson(path), path); } catch (error) { if (isCode(error, 'ENOENT')) return undefined; throw error; }
}

/**
 * The extensions among `names` (the project's declared ones) that provide the request principal, each with the OpenAPI
 * security scheme it declares (undefined when none), read from static descriptors only (RIM-EXT-PRINCIPAL-001): each
 * name's installed `urlcode.json` in the enclosing `site` (a site dependency carrying it, else the first-party install
 * location), else this core's release catalog. Reads data only; imports and activates nothing.
 */
export async function declaredPrincipalSecurity(site: string, names: readonly string[]): Promise<Map<string, ExtensionOpenApiSecurity | undefined>> {
  const found = new Map<string, ExtensionOpenApiSecurity | undefined>();
  if (!names.length) return found;
  const { providers } = await installedProviders(site);
  let catalog: AddonCatalog | undefined | null;
  for (const name of names) {
    let descriptor: AddonDescriptor | AddonCatalogEntry | undefined = providers.get(name)?.descriptor;
    if (!descriptor) {
      const path = join(site, 'node_modules', addonPackage(name), 'urlcode.json');
      try { descriptor = parseDescriptor(await readJson(path), path); } catch (error) { if (!isCode(error, 'ENOENT') && !isCode(error, 'ENOTDIR')) throw error; }
    }
    if (!descriptor) {
      if (catalog === undefined) catalog = await readAddonCatalog().catch(() => null);
      descriptor = catalog?.addons.find(entry => entry.name === name);
    }
    if (descriptor?.kind === 'extension' && descriptor.providesPrincipal === true) found.set(name, descriptor.openapiSecurity);
  }
  return found;
}
/**
 * The extensions among `names` that provide the request principal, sorted (`declaredPrincipalSecurity`): what the
 * route `auth:` short form expands to, and what OpenAPI and review treat as a sign-in gate without a host file.
 */
export async function declaredPrincipalProviders(site: string, names: readonly string[]): Promise<string[]> {
  return [...(await declaredPrincipalSecurity(site, names)).keys()].sort();
}
let releaseProviders: ReadonlySet<string> | undefined;
/**
 * The extensions this core's release catalog lists as principal providers: what text mode (YAML with no project
 * directory, so no installed descriptors) resolves the `auth:` short form against. Read once, synchronously.
 */
export function releasePrincipalProviders(): ReadonlySet<string> {
  if (releaseProviders) return releaseProviders;
  for (const candidate of catalogCandidates()) {
    let text: string;
    try { text = readFileSync(candidate, 'utf8'); } catch (error) { if (isCode(error, 'ENOENT')) continue; throw error; }
    releaseProviders = new Set(parseAddonCatalog(JSON.parse(text), String(candidate)).addons.filter(entry => entry.providesPrincipal === true).map(entry => entry.name));
    return releaseProviders;
  }
  throw noCatalog();
}
/**
 * The declared extensions that provide the request principal, each with its declared OpenAPI security scheme: for a
 * declared extension the host file registers (`registrations`), its registration's `providesPrincipal` and
 * `openapiSecurity`; for any other, its static descriptor (`declaredPrincipalSecurity`). Sorted by name.
 */
export async function principalSecurityOf(site: string, declared: readonly string[], registrations: readonly Pick<RuntimeExtension, 'name' | 'providesPrincipal' | 'openapiSecurity'>[] = []): Promise<Map<string, ExtensionOpenApiSecurity | undefined>> {
  const registered = new Map(registrations.map(registration => [registration.name, registration]));
  const found = new Map<string, ExtensionOpenApiSecurity | undefined>();
  for (const name of declared) { const registration = registered.get(name); if (registration?.providesPrincipal === true) found.set(name, registration.openapiSecurity); }
  for (const [name, security] of await declaredPrincipalSecurity(site, declared.filter(name => !registered.has(name)))) found.set(name, security);
  return new Map([...found].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0));
}
/** The declared extensions that provide the request principal, sorted (`principalSecurityOf`). */
export async function principalProvidersOf(site: string, declared: readonly string[], registrations: readonly Pick<RuntimeExtension, 'name' | 'providesPrincipal' | 'openapiSecurity'>[] = []): Promise<string[]> {
  return [...(await principalSecurityOf(site, declared, registrations)).keys()];
}
