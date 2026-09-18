import { mkdir, open, readFile, rm, unlink, lstat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseDocument, stringify } from 'yaml';
import { initProject } from './authoring.ts';
import { mcpConfigFile, renderMcpConfig } from './agents-guide.ts';
import { loadDocument, parseYaml, validateDocument } from './config.ts';
import { inspectExtensionRevision } from './extensions.ts';
import type { ScaffoldRequest, ScaffoldResult } from './extensions.ts';
import { ConfigError, assert } from './errors.ts';

/** Directory names inside the generated site. The route project lives under `app/`; everything else is operator-owned. */
export const PROJECT_DIRECTORY = 'app', HOST_FILE = 'host.mjs', ROUTES_FILE = 'routes/extensions.yaml';
const namePattern = /^[a-z][a-z0-9-]{0,63}$/;
export interface InitWithOptions { cwd?: string | undefined }
export interface InitWithResult { directory: string; project: string; hostFile: string; extensions: string[]; projectSha256: string; nextSteps: string[] }

export function parseWithNames(value: string): string[] {
  const names = value.split(',').map(name => name.trim());
  assert(names.length > 0 && names.every(name => namePattern.test(name)), 'Use --with name[,name] where each name is a lowercase extension package suffix such as auth');
  assert(new Set(names).size === names.length, 'Duplicate --with names');
  return names;
}
export const packageName = (name: string): string => `@jimhoyd/urlcode-${name}`;
const isCode = (error: unknown, code: string): boolean => error instanceof Error && 'code' in error && error.code === code;
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === 'string');
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * Resolves the extension package from the invoking directory (Node's package resolution with the default
 * conditions), imports it, and calls its `scaffold` export. Nothing is bundled; core never imports these packages
 * at build time. Refuses a missing package or a package without `scaffold` before anything is written.
 */
export async function loadScaffold(name: string, request: ScaffoldRequest, cwd: string): Promise<ScaffoldResult> {
  const pkg = packageName(name);
  let entry: string;
  try { entry = createRequire(join(cwd, 'package.json')).resolve(pkg); }
  catch (error) {
    if (isCode(error, 'MODULE_NOT_FOUND')) throw new ConfigError(`Extension package ${pkg} is not installed in ${cwd}; run: npm install ${pkg}`);
    throw error;
  }
  const module = await import(pathToFileURL(entry).href) as Record<string, unknown>;
  const scaffold = module.scaffold;
  if (typeof scaffold !== 'function') throw new ConfigError(`${pkg} does not export scaffold; upgrade it to a release that supports urlcode init --with, or add ${name} by hand following its README`);
  let result: unknown;
  try { result = await (scaffold as (request: ScaffoldRequest) => unknown)(request); }
  catch (error) { throw new ConfigError(`${pkg} scaffold refused: ${error instanceof Error ? error.message : String(error)}`); }
  assert(record(result) && result.name === name, `${pkg} scaffold must return a result named ${name}`);
  assert(record(result.extensions) && record(result.routes), `${pkg} scaffold must return extensions and routes objects`);
  assert(strings(result.hostImports) && strings(result.hostSetup) && strings(result.hostEntries) && (result.hostClose === undefined || strings(result.hostClose)), `${pkg} scaffold must return host fragments as string arrays`);
  assert(strings(result.nextSteps) && typeof result.readme === 'string', `${pkg} scaffold must return readme text and nextSteps strings`);
  assert(result.env === undefined || (record(result.env) && Object.values(result.env).every(item => typeof item === 'string')), `${pkg} scaffold env must map names to descriptions`);
  assert(Array.isArray(result.files) && result.files.every((file: unknown) => record(file) && typeof file.path === 'string' && (typeof file.content === 'string' || file.content instanceof Uint8Array) && (file.mode === undefined || (Number.isInteger(file.mode) && (file.mode as number) >= 0 && (file.mode as number) <= 0o777))), `${pkg} scaffold files must carry a path, content and an optional mode`);
  return result as unknown as ScaffoldResult;
}

function filePath(root: string, path: string): string {
  assert(typeof path === 'string' && path.length > 0 && path.length <= 1024 && !path.includes('\0'), 'Invalid scaffold file path');
  const target = resolve(root, path), rel = relative(root, target);
  assert(!path.startsWith('/') && rel === path.split('/').join(sep) && rel.length > 0 && !rel.startsWith('..'), `Scaffold file path must stay inside the site directory: ${path}`);
  assert(rel !== PROJECT_DIRECTORY && !rel.startsWith(PROJECT_DIRECTORY + sep), `Scaffold files must stay outside the route project: ${path}`);
  return target;
}
/** Creates the file exclusively: nothing generated is ever overwritten. */
async function write(target: string, content: string | Uint8Array, mode = 0o644): Promise<void> {
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  const file = await open(target, 'wx', mode);
  try { await file.writeFile(content); await file.sync(); } finally { await file.close(); }
}
export function renderHost(names: readonly string[], results: readonly ScaffoldResult[]): string {
  const lines = [`// Generated by urlcode init --with ${names.join(',')}. Trusted operator code: keep it outside ${PROJECT_DIRECTORY}/ and review before serving.`];
  for (const result of results) lines.push(...result.hostImports);
  lines.push('');
  for (const result of results) if (result.hostSetup.length) lines.push(...result.hostSetup);
  lines.push('export default {', '  extensions: [');
  for (const result of results) for (const entry of result.hostEntries) lines.push(`    ${entry},`);
  lines.push('  ],', '  async close() {');
  // Later extensions may depend on earlier setup, so release in reverse order.
  for (const result of [...results].reverse()) for (const statement of result.hostClose ?? []) lines.push(`    ${statement}`);
  lines.push('  },', '};');
  return lines.join('\n') + '\n';
}
function demote(markdown: string): string {
  let fence = false;
  return markdown.split('\n').map(line => { if (/^\s*(?:```|~~~)/.test(line)) fence = !fence; return !fence && /^#{1,5} /.test(line) ? `#${line}` : line; }).join('\n');
}
export function renderReadme(directory: string, names: readonly string[], results: readonly ScaffoldResult[], starter: string, env: Record<string, string>, projectSha256: string): string {
  const steps = results.flatMap(result => result.nextSteps);
  const parts = [`# ${basename(directory)}`, '',
    `Created with \`urlcode init ${basename(directory)} --with ${names.join(',')}\`. \`${PROJECT_DIRECTORY}/\` is the route project (\`urlcode.yaml\`, functions, tests); \`${HOST_FILE}\` is the trusted operator host that wires the installed extension packages; operator modules and private data stay outside the project. Run every command with \`--project ${PROJECT_DIRECTORY} --host-file "$PWD/${HOST_FILE}"\`.`, '',
    '## Starter', '', `The starter files live in \`${PROJECT_DIRECTORY}/\`; add \`--project ${PROJECT_DIRECTORY}\` and the host file to the commands below.`, '', demote(starter).trim(), ''];
  for (const result of results) parts.push(`## Extension: ${result.name}`, '', result.readme.trim(), '');
  parts.push('## Next steps', '', ...steps.map((step, index) => `${index + 1}. ${step}`), '');
  if (Object.keys(env).length) parts.push('## Environment', '', ...Object.entries(env).map(([key, text]) => `- \`${key}\`: ${text}`), '');
  parts.push('## Project revision', '', `\`${PROJECT_DIRECTORY}/urlcode.yaml\` currently has revision \`${projectSha256}\` (\`inspectExtensionRevision\`). Review the project, then pin exactly that value where the host expects it; any change to extension YAML, policies or mounts changes it and needs a new explicit review.`, '');
  return parts.join('\n');
}

/**
 * `urlcode init <directory> --with a,b`: the starter under `app/`, every extension's fragments merged into one
 * `urlcode.yaml`, one `host.mjs`, one `README.md` and the extensions' own files. All packages are resolved and
 * their scaffolds computed before anything is written, so a refusal leaves no directory behind.
 */
export async function initProjectWith(destination: string, names: readonly string[], { cwd = process.cwd() }: InitWithOptions = {}): Promise<InitWithResult> {
  assert(names.length > 0, 'Provide at least one --with name');
  const directory = resolve(destination), project = join(directory, PROJECT_DIRECTORY), hostFile = join(directory, HOST_FILE);
  const request: ScaffoldRequest = { directory, project, hostFile, names };
  const results: ScaffoldResult[] = [];
  const wipe = (): void => { for (const result of results) for (const file of result.files) if (file.content instanceof Uint8Array) file.content.fill(0); };
  try {
    for (const name of names) results.push(await loadScaffold(name, request, cwd));
    // Cross-result conflicts are refused before the destination exists.
    const extensions: Record<string, unknown> = Object.create(null) as Record<string, unknown>, routes: Record<string, unknown> = Object.create(null) as Record<string, unknown>, env: Record<string, string> = {};
    const owners = new Map<string, string>();
    for (const result of results) {
      for (const [key, value] of Object.entries(result.extensions)) { assert(!Object.hasOwn(extensions, key), `Extension ${key} is declared by both ${owners.get('e:' + key)} and ${result.name}`); owners.set('e:' + key, result.name); extensions[key] = value; }
      for (const [key, value] of Object.entries(result.routes)) { assert(!Object.hasOwn(routes, key), `Route ${key} is added by both ${owners.get('r:' + key)} and ${result.name}`); owners.set('r:' + key, result.name); routes[key] = value; }
      for (const [key, value] of Object.entries(result.env ?? {})) { assert(!Object.hasOwn(env, key) || env[key] === value, `Environment variable ${key} is described differently by ${result.name}`); env[key] = value; }
      const seen = new Set<string>();
      for (const file of result.files) { const path = filePath(directory, file.path); assert(!seen.has(path), `${result.name} scaffolds ${file.path} twice`); seen.add(path); }
    }
    await mkdir(dirname(directory), { recursive: true });
    await mkdir(directory, { mode: 0o700 }); // refuses an existing destination
    try {
      await initProject(project);
      const starter = await readFile(join(project, 'README.md'), 'utf8');
      await unlink(join(project, 'README.md')); // its content moves into the site README
      await unlink(join(project, mcpConfigFile)); // re-registered at the site root, pointing at app/
      // Refuse routes or extensions the starter already declares, including in its included files.
      const loaded = await loadDocument(project);
      for (const key of Object.keys(routes)) assert(!Object.hasOwn(loaded.routes, key), `Route ${key} from ${owners.get('r:' + key)} already exists in the starter`);
      for (const key of Object.keys(extensions)) assert(!Object.hasOwn(loaded.document.extensions ?? {}, key), `Extension ${key} from ${owners.get('e:' + key)} already exists in the starter`);
      const yamlFile = join(project, 'urlcode.yaml'), original = await readFile(yamlFile, 'utf8');
      const doc = parseDocument(original);
      // Extensions are declared in the entry file; their routes go into a last include so the starter's own routes
      // stay first in the loaded order and the entry file stays small.
      doc.set('extensions', { ...loaded.document.extensions, ...extensions });
      doc.addIn(['includes'], ROUTES_FILE);
      const fragment = stringify({ version: '1', routes });
      validateDocument(doc.toJS()); validateDocument(parseYaml(fragment));
      await write(join(project, ROUTES_FILE), `# Routes added by urlcode init --with ${names.join(',')}. Mounts are exclusive to the named extension.\n${fragment}`);
      await rm(yamlFile); await write(yamlFile, String(doc));
      await loadDocument(project);
      const projectSha256 = await inspectExtensionRevision(project);
      const written = new Set<string>();
      for (const result of results) for (const file of result.files) {
        const target = filePath(directory, file.path);
        assert(!written.has(target), `Scaffold file ${file.path} is written by more than one extension`);
        // Parent directories are created; existing files or symlinks anywhere on the path are refused.
        let probe = dirname(target);
        while (probe !== directory && probe.startsWith(directory)) { try { assert(!(await lstat(probe)).isSymbolicLink(), `Scaffold path passes through a symlink: ${file.path}`); } catch (error) { if (!isCode(error, 'ENOENT')) throw error; } probe = dirname(probe); }
        await write(target, file.content, file.mode ?? 0o644); written.add(target);
      }
      await write(hostFile, renderHost(names, results), 0o600);
      await write(join(directory, 'README.md'), renderReadme(directory, names, results, starter, env, projectSha256));
      await write(join(directory, '.gitignore'), 'node_modules/\ndata/\n.env\n.env.*\n');
      // The read-only MCP server for agents opened at the site root; --host-file and --allow-authoring stay operator choices.
      await write(join(directory, mcpConfigFile), renderMcpConfig(PROJECT_DIRECTORY));
      // AGENTS.md: initProject writes the application-level file into app/ once it produces one (NEXT-STEPS 1.1);
      // nothing here overrides it. A site-level agent note would be assembled beside README.md at this point.
      return { directory, project, hostFile, extensions: [...names], projectSha256, nextSteps: results.flatMap(result => result.nextSteps) };
    } catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
  } finally { wipe(); }
}
