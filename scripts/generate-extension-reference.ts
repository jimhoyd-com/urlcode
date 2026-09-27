// Generates each first-party extension's field reference from its descriptor (#822), and holds the descriptors to the
// rules that make that reference and agent discovery complete (#822, #823).
//
//   node scripts/generate-extension-reference.ts           rewrite the generated block of every packages/<name>/README.md
//                                                          and of docs/EXTENSION-REFERENCE.md
//   node scripts/generate-extension-reference.ts --check   fail when a block is stale, a declared property has no
//                                                          description, or an extension lacks shipped agent references
//
// Source of truth: packages/<name>/urlcode.json, which `npm run build:addons` writes from the extension's own code
// (scripts/build-addon-manifest.ts). Nothing here is hand-maintained schema: the tables are rendered from the
// configuration schema, the route-policy schema and the hook contracts that ship in the package, so a field cannot be
// accepted without appearing here, and the description gate below fails a field that says nothing.
//
// The reference is a block inside the package README rather than a separate file: the README already ships in every
// package, is what the descriptor's agent metadata names, and is what `urlcode docs search` reads for an installed
// add-on, so the field reference reaches an agent through the same bounded path as the guide around it.
//
// Scope: first-party extensions in this repository only. A third-party extension owns its own schema and syntax;
// nothing here copies it into core's schema or implies it is installed.
import { readFile, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseDescriptor } from '../packages/core/src/addon-manifest.ts';
import type { AddonDescriptor } from '../packages/core/src/addon-manifest.ts';
import { propertyPointers, undescribed } from './schema-descriptions.ts';
import { addons, repositoryRoot } from './workspaces.ts';

export const START = '<!-- extension-reference:start -->';
export const END = '<!-- extension-reference:end -->';
const GENERATED_NOTE = '<!-- Generated from urlcode.json by scripts/generate-extension-reference.ts (npm run docs:extensions). Do not edit between these markers; change the extension\'s schema descriptions instead. -->';
export const INDEX = 'docs/EXTENSION-REFERENCE.md';

interface Schema { [keyword: string]: unknown }
export interface ExtensionSource {
  name: string; directory: string; packageName: string;
  descriptor: AddonDescriptor; readme: string; files: readonly string[];
}
export interface Row { path: string; pointer: string; type: string; required: boolean; rules: string; description: string }

/** Every first-party extension in the repository, with its committed descriptor, README and packaged file list. */
export async function firstPartyExtensions(root = repositoryRoot): Promise<ExtensionSource[]> {
  const found: ExtensionSource[] = [];
  for (const addon of await addons(root)) {
    if (addon.kind !== 'extension') continue;
    const descriptor = parseDescriptor(JSON.parse(await readFile(join(addon.directory, 'urlcode.json'), 'utf8')), `${addon.packageName}/urlcode.json`);
    const pkg = JSON.parse(await readFile(join(addon.directory, 'package.json'), 'utf8')) as { files?: string[] };
    const readme = await readFile(join(addon.directory, 'README.md'), 'utf8').catch(() => '');
    found.push({ name: addon.name, directory: addon.directory, packageName: addon.packageName, descriptor, readme, files: pkg.files ?? [] });
  }
  return found;
}

/** The schemas an extension's descriptor declares, keyed by the JSON pointer prefix used in every report. */
export function declaredSchemas(descriptor: AddonDescriptor): [string, unknown][] {
  return [
    ['/schema', descriptor.schema],
    ...(descriptor.policySchema ? [['/policySchema', descriptor.policySchema] as [string, unknown]] : []),
    ...(descriptor.hooks ?? []).flatMap((hook, index): [string, unknown][] => [[`/hooks/${index}/inputSchema`, hook.inputSchema], ...(hook.outputSchema ? [[`/hooks/${index}/outputSchema`, hook.outputSchema] as [string, unknown]] : [])]),
  ];
}
/** Pointers of declared properties without a description, across configuration, route policy and hook schemas. */
export function missingDescriptions(descriptor: AddonDescriptor): string[] {
  return declaredSchemas(descriptor).flatMap(([prefix, schema]) => undescribed(schema, prefix));
}
/** Pointers of every declared property, for the coverage test that each one is rendered. */
export function declaredProperties(descriptor: AddonDescriptor): string[] {
  // A property under `not` states an exclusion (auth: csrf and bearer never together), not a key an author writes;
  // the reference renders it as a whole-policy rule, and the description gate still covers it.
  return declaredSchemas(descriptor).flatMap(([prefix, schema]) => propertyPointers(schema, prefix)).filter(pointer => !pointer.includes('/not/'));
}

/** A packaged path: named by package.json `files` (itself or a directory above it), or always packed by npm. */
function shipped(files: readonly string[], path: string): boolean {
  if (['package.json', 'README.md', 'LICENSE', 'NOTICE'].includes(path)) return true;
  return files.some(entry => !entry.startsWith('!') && (entry === path || path.startsWith(`${entry.replace(/\/$/, '')}/`)));
}
/** Why an extension's agent metadata would leave an agent without its reference (#823); empty when complete. */
export async function agentProblems(source: ExtensionSource): Promise<string[]> {
  const agent = source.descriptor.agent, problems: string[] = [];
  if (!agent || !agent.references.length) return [`${source.packageName}: urlcode.json has no agent references; declare agent in src/extension.ts and run npm run build:addons`];
  for (const reference of agent.references) {
    const exists = await readFile(join(source.directory, reference.path)).then(() => true, () => false);
    if (!exists) problems.push(`${source.packageName}: agent reference ${reference.path} does not exist in the package`);
    else if (!shipped(source.files, reference.path)) problems.push(`${source.packageName}: agent reference ${reference.path} is not in package.json files, so it is not shipped`);
  }
  if (!agent.references.some(reference => reference.path === 'README.md')) problems.push(`${source.packageName}: no agent reference names README.md, which carries the generated field reference`);
  return problems;
}

// ---- rendering ----------------------------------------------------------------------------------------------------

const isSchema = (value: unknown): value is Schema => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const hasFields = (node: unknown): node is Schema => isSchema(node) && isSchema(node.properties) && Object.keys(node.properties).length > 0;
const CONSTRAINTS = ['const', 'enum', 'default', 'minimum', 'maximum', 'minLength', 'maxLength', 'minItems', 'maxItems', 'minProperties', 'maxProperties', 'pattern', 'uniqueItems', 'dependentRequired'];

function typeOf(node: Schema): string {
  if (typeof node.type === 'string') return node.type;
  if (Array.isArray(node.type)) return node.type.join(' / ');
  if (node.const !== undefined) return 'constant';
  if (Array.isArray(node.enum)) return [...new Set(node.enum.map(value => typeof value === 'string' ? 'string' : typeof value === 'number' ? 'number' : typeof value))].join(' / ');
  const branches = (node.oneOf ?? node.anyOf) as unknown[] | undefined;
  if (Array.isArray(branches)) return [...new Set(branches.filter(isSchema).map(typeOf))].join(' / ');
  return 'any JSON value';
}
/** One schema's own constraints as text; `items`, map values and union branches are summarized inline. */
function rulesOf(node: Schema): string {
  const rules = CONSTRAINTS.filter(key => node[key] !== undefined).map(key => `${key}: ${JSON.stringify(node[key])}`);
  if (node.additionalProperties === false && isSchema(node.properties)) rules.push('unknown keys rejected');
  if (isSchema(node.propertyNames) && typeof node.propertyNames.pattern === 'string') rules.push(`keys: ${JSON.stringify(node.propertyNames.pattern)}`);
  if (isSchema(node.additionalProperties) && !hasFields(node.additionalProperties)) rules.push(`values: ${summary(node.additionalProperties)}`);
  if (isSchema(node.items) && !hasFields(node.items) && !branchesWithFields(node.items).length) rules.push(`items: ${summary(node.items)}`);
  const branches = (node.oneOf ?? node.anyOf) as unknown[] | undefined;
  if (Array.isArray(branches)) rules.push(`one of: ${branches.filter(isSchema).map(summary).join('; ')}`);
  if (isSchema(node.not) && Array.isArray(node.not.required)) rules.push(`never together: ${(node.not.required as string[]).join(', ')}`);
  return rules.join('; ');
}
function summary(node: Schema): string {
  if (hasFields(node)) return `${typeOf(node)} (fields below)`;
  const rules = rulesOf(node);
  return rules ? `${typeOf(node)} (${rules})` : typeOf(node);
}
function branchesWithFields(node: Schema): [number, Schema, string][] {
  const list = Array.isArray(node.oneOf) ? ['oneOf', node.oneOf] as const : Array.isArray(node.anyOf) ? ['anyOf', node.anyOf] as const : undefined;
  if (!list) return [];
  return (list[1] as unknown[]).flatMap((branch, index): [number, Schema, string][] => hasFields(branch) ? [[index, branch, list[0]]] : []);
}

/** Rows for every property under `node`, depth first, each with the JSON pointer of the property it renders. */
export function rows(node: unknown, path = '', pointer = '', out: Row[] = []): Row[] {
  if (!isSchema(node)) return out;
  if (isSchema(node.properties)) {
    const required = Array.isArray(node.required) ? node.required as string[] : [];
    for (const [key, child] of Object.entries(node.properties)) {
      if (!isSchema(child)) continue;
      const at = path ? `${path}.${key}` : key, childPointer = `${pointer}/properties/${key.replaceAll('~', '~0').replaceAll('/', '~1')}`;
      out.push({ path: at, pointer: childPointer, type: typeOf(child), required: required.includes(key), rules: rulesOf(child), description: typeof child.description === 'string' ? child.description : '' });
      rows(child, at, childPointer, out);
    }
  }
  if (isSchema(node.additionalProperties)) rows(node.additionalProperties, `${path}.*`, `${pointer}/additionalProperties`, out);
  if (isSchema(node.items)) {
    rows(node.items, `${path}[]`, `${pointer}/items`, out);
  }
  for (const [index, branch, keyword] of branchesWithFields(node)) rows(branch, path, `${pointer}/${keyword}/${index}`, out);
  return out;
}

/** Table cell text: one line, pipes escaped, and `<placeholder>` tokens kept visible as code. */
function cell(text: string): string {
  const flat = text.replaceAll('\n', ' ').replaceAll('|', '\\|');
  return flat.split('`').map((part, index) => index % 2 ? part : part.replace(/[\w./*-]*(?:<[\w.-]+>[\w./*-]*)+/g, token => {
    const trailing = /\.+$/.exec(token)?.[0] ?? '';
    return `\`${token.slice(0, token.length - trailing.length)}\`${trailing}`;
  })).join('`');
}
function table(prefix: string, list: readonly Row[]): string {
  const body = list.map(row => `| \`${prefix}${row.path}\` | ${cell(row.type)} | ${row.required ? 'yes' : 'no'} | ${row.rules ? cell(row.rules) : '—'} | ${cell(row.description) || '—'} |`).join('\n');
  return `| Field | Type | Required | Schema constraints | Description |\n|---|---|---|---|---|\n${body}`;
}

/** The generated block for one extension (between START and END). */
export function renderReference(source: ExtensionSource): string {
  const { name, descriptor } = source, config = `extensions.${name}.config.`;
  const out: string[] = [GENERATED_NOTE, '', '## Field reference', ''];
  out.push(`Every key \`${name}\` accepts, rendered from this package's \`urlcode.json\` (the schema the runtime validates against). Required means required within its containing object; \`*\` is a key you choose and \`[]\` an array item.`);
  out.push('', `**Schema-valid is not activatable.** JSON Schema checks shape only. Activation also checks what a schema cannot express: the route for each declared mount exists, referenced fields and collections are declared, peers are installed and active, and the cross-field rules the descriptions state. A project that validates can still refuse to start; run \`urlcode validate --project . --host-file <host.mjs> --origin <origin>\`, which activates it.`);
  const peers: string[] = [];
  if (descriptor.requires.length) peers.push(`requires ${descriptor.requires.map(peer => `\`${peer}\``).join(', ')} (\`urlcode extensions add ${name}\` installs them too)`);
  if (descriptor.uses?.length) peers.push(`uses ${descriptor.uses.map(peer => `\`${peer}\``).join(', ')} when installed (optional: the features that need one refuse to activate without it)`);
  if (descriptor.contributes?.length) peers.push(`contributes to ${descriptor.contributes.map(peer => `\`${peer}\``).join(', ')} (read only when that extension is installed)`);
  out.push('', `**Peers.** ${peers.length ? `${peers.join('; ')}.` : 'none.'}`);
  const configRows = rows(descriptor.schema).filter(row => !(descriptor.hooks?.length && (row.path === 'hooks' || row.path.startsWith('hooks.'))));
  out.push('', `### Configuration: \`extensions.${name}.config\``, '');
  out.push(configRows.length ? table(config, configRows) : `No configuration keys: declare \`extensions.${name}: {version: "1", config: {}}\`.`);
  if (descriptor.policySchema) {
    const policy = rows(descriptor.policySchema), rules = rulesOf(descriptor.policySchema as Schema);
    out.push('', `### Route policy: \`policies.extensions.${name}\``, '');
    if (name === 'auth') out.push('A route may write this as the `auth:` short form: `auth: true` is `{}`, and an object is the same keys.', '');
    out.push(table(`policies.extensions.${name}.`, policy));
    if (rules) out.push('', `Whole-policy rules: ${cell(rules)}.`);
  }
  if (descriptor.hooks?.length) {
    const hooksRow = rows(descriptor.schema).find(row => row.path === 'hooks');
    out.push('', `### Project hooks: \`extensions.${name}.config.hooks\``, '');
    if (hooksRow) out.push(`${cell(hooksRow.description)}`, '');
    const reference = rows(descriptor.schema).filter(row => row.path.startsWith('hooks.'));
    out.push(table(config, reference), '');
    for (const hook of descriptor.hooks) {
      out.push(`#### \`${hook.name}\` (${hook.kind})`, '', cell(hook.description), '', `Called as \`${hook.name}(input, context)\`; \`context\` carries \`requestId\` and the mount route's granted \`env\`, frozen.`, '');
      out.push(table('input.', rows(hook.inputSchema)));
      if (hook.outputSchema) {
        const output = rows(hook.outputSchema);
        out.push('', output.length ? table('output.', output) : 'Returns an object, validated before use.');
      } else out.push('', 'Its return value is ignored.');
      out.push('');
    }
    out.pop();
  }
  const authoring = descriptor.authoring;
  if (authoring) {
    out.push('', '### Authoring surfaces and limits', '', cell(authoring.description), '');
    for (const surface of authoring.surfaces) out.push(`- **${surface.name}** (${surface.kind}${surface.path ? `, \`${surface.path}\`` : ''}): ${cell(surface.description)}`);
    if (authoring.fastChecks?.length) out.push('', `Fast checks: ${authoring.fastChecks.map(check => `\`${check}\``).join(', ')}.`);
  }
  return out.join('\n');
}

/** Replaces the generated block of `document`, or appends one at the end when it has none. */
export function splice(document: string, block: string): string {
  const start = document.indexOf(START), end = document.indexOf(END);
  if (start === -1 || end === -1 || end < start) return `${document.replace(/\s*$/, '')}\n\n${START}\n${block}\n${END}\n`;
  return `${document.slice(0, start)}${START}\n${block}\n${END}${document.slice(end + END.length)}`;
}

/** The generated block of docs/EXTENSION-REFERENCE.md: one row per first-party extension. */
export function renderIndex(sources: readonly ExtensionSource[]): string {
  const lines = [GENERATED_NOTE, '', '| Extension | What it declares | Peers | Described fields | Field reference |', '|---|---|---|---|---|'];
  for (const source of [...sources].sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)) {
    const { descriptor } = source, counts: string[] = [];
    const config = rows(descriptor.schema).length, policy = descriptor.policySchema ? rows(descriptor.policySchema).length : 0;
    const hooks = (descriptor.hooks ?? []).reduce((sum, hook) => sum + rows(hook.inputSchema).length + (hook.outputSchema ? rows(hook.outputSchema).length : 0), 0);
    counts.push(`config ${config}`);
    if (policy) counts.push(`route policy ${policy}`);
    if (hooks) counts.push(`hook input/output ${hooks}`);
    const peers = [descriptor.requires.length ? `requires ${descriptor.requires.join(', ')}` : '', descriptor.uses?.length ? `uses ${descriptor.uses.join(', ')}` : ''].filter(Boolean).join('; ') || '—';
    const readme = relative(join(repositoryRoot, 'docs'), join(source.directory, 'README.md')).split('\\').join('/');
    lines.push(`| \`${source.name}\` | ${cell(descriptor.description)} | ${peers} | ${counts.join(', ')} | [${source.packageName}](${readme}#field-reference) |`);
  }
  return lines.join('\n');
}

/** Every generated file and its expected content, plus the problems that fail the check whatever the files say. */
export async function expected(root = repositoryRoot): Promise<{ files: Map<string, string>; problems: string[] }> {
  const sources = await firstPartyExtensions(root), files = new Map<string, string>(), problems: string[] = [];
  for (const source of sources) {
    const missing = missingDescriptions(source.descriptor);
    if (missing.length) problems.push(`${source.packageName}: ${missing.length} declared propert${missing.length === 1 ? 'y has' : 'ies have'} no description; give each one a sentence in the extension's schema (src/), then npm run build:addons:\n${missing.map(pointer => `    urlcode.json${pointer}`).join('\n')}`);
    problems.push(...await agentProblems(source));
    files.set(join(source.directory, 'README.md'), splice(source.readme, renderReference(source)));
  }
  const indexPath = join(root, INDEX), index = await readFile(indexPath, 'utf8').catch(() => undefined);
  if (index === undefined || !index.includes(START)) problems.push(`${INDEX} is missing or has no ${START} marker`);
  else files.set(indexPath, splice(index, renderIndex(sources)));
  return { files, problems };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const check = process.argv.includes('--check'), { files, problems } = await expected();
  const stale: string[] = [];
  for (const [path, content] of files) {
    if (await readFile(path, 'utf8').catch(() => '') === content) continue;
    stale.push(relative(repositoryRoot, path));
    if (!check) await writeFile(path, content);
  }
  if (problems.length) { process.stderr.write(`Extension reference check failed:\n${problems.map(problem => `  ${problem}`).join('\n')}\n`); process.exit(1); }
  if (check && stale.length) { process.stderr.write(`Extension field references are stale (run npm run docs:extensions):\n${stale.map(path => `  ${path}`).join('\n')}\n`); process.exit(1); }
}
