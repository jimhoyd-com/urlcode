// Scaffolds a new operator-installed extension package skeleton under
// packages/<name>, in the shape every extension package follows: package.json
// (released with core at core's version, exports "." and "./extension"),
// README/SECURITY/CHANGELOG/AGENTS/llms.txt, a tsconfig pair, a RuntimeExtension
// source module, `src/extension.ts` (the `defineExtension` definition: scaffold
// and host), its `urlcode.json` descriptor, and a real integration test.
//
// Usage:
//   node scripts/create-extension.ts <name> [--from <existing-package>] [--description "..."]
//
// <name> is the package slug (packages/<name>, @jimhoyd/urlcode-<name>) and the
// extension name. --from <existing-package> forks the file *shape* of an
// already-existing packages/<existing-package> (which optional docs it carries,
// which workspace siblings it peers on and so requires) rather than its
// business logic: the generated source is still the same minimal example
// handler, never a copy of the source package's implementation (#614, #615).
//
// --packages-dir <dir> writes the package somewhere other than packages/ (the
// directory must sit directly under the repository root, so the package's
// `../..` links still reach it); tests use it so a half-built package never
// appears in the add-on list other scripts read.
//
// This only creates files; it does not run `npm install` or regenerate
// urlcode.json -- see the printed "Next steps".
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const packagesDir = join(root, 'packages');

interface Args { name: string; from?: string; description?: string; packagesDir?: string; help: boolean }

function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  let from: string | undefined, description: string | undefined, packagesDirArg: string | undefined, help = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--help' || arg === '-h') help = true;
    else if (arg === '--from') { from = argv[++i]; if (!from) throw new Error('--from requires a value'); }
    else if (arg === '--description') { description = argv[++i]; if (description === undefined) throw new Error('--description requires a value'); }
    else if (arg === '--packages-dir') { packagesDirArg = argv[++i]; if (!packagesDirArg) throw new Error('--packages-dir requires a value'); }
    else if (arg.startsWith('-')) throw new Error(`Unknown option: ${arg}`);
    else positional.push(arg);
  }
  if (help) return { name: '', help: true };
  if (positional.length !== 1) throw new Error('Expected exactly one positional argument: the new extension package name');
  return { name: positional[0]!, help: false, ...(from !== undefined ? { from } : {}), ...(description !== undefined ? { description } : {}), ...(packagesDirArg !== undefined ? { packagesDir: packagesDirArg } : {}) };
}

const NAME = /^[a-z][a-z0-9-]{1,63}$/;
const RESERVED = new Set(['core', 'urlcode', 'dist', 'node_modules']);

function pascalCase(slug: string): string {
  return slug.split('-').map(part => part.charAt(0).toUpperCase() + part.slice(1)).join('');
}

/** Identifier-safe camelCase form of the slug, for JS identifiers (export names); the slug itself
 * (with hyphens) is only ever used as a string -- an extension's logical name, a mount path, a
 * YAML/JSON key -- never as a bare identifier, which cannot contain a hyphen. */
function camelCase(slug: string): string {
  const Name = pascalCase(slug);
  return Name.charAt(0).toLowerCase() + Name.slice(1);
}

interface CoreManifest { version: string; engines: { node: string }; devDependencies: Record<string, string> }
interface SourceManifest {
  name?: string; version?: string; peerDependencies?: Record<string, string>;
}

async function loadCoreManifest(): Promise<CoreManifest> {
  return JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as CoreManifest;
}

/** Files an existing package may carry beyond the minimal shape; forking one reproduces which of these are present, as placeholders -- never their content. */
const OPTIONAL_DOC_FILES = ['ACCEPTANCE.md', 'CONTRACT.md', 'IMPLEMENTATION-STATUS.md', 'THREAT-MODEL.md', 'THIRD_PARTY_NOTICES.md'] as const;

/** `peers` are the workspace sibling extensions the source package peers on (directory name = extension name), with their versions. */
interface ForkShape { peers: { name: string; version: string }[]; optionalDocs: string[]; hasGitignore: boolean; sourceDir: string }

async function readForkShape(fromSlug: string): Promise<ForkShape> {
  const sourceDir = join(packagesDir, fromSlug);
  if (!existsSync(sourceDir)) throw new Error(`--from ${fromSlug}: packages/${fromSlug} does not exist`);
  const manifestPath = join(sourceDir, 'package.json');
  if (!existsSync(manifestPath)) throw new Error(`--from ${fromSlug}: packages/${fromSlug}/package.json does not exist`);
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as SourceManifest;
  const peerNames = Object.keys(manifest.peerDependencies ?? {}).filter(peer => peer !== '@jimhoyd/urlcode');
  const dirByName = new Map<string, { name: string; version: string }>();
  for (const entry of await readdir(packagesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const raw = await readFile(join(packagesDir, entry.name, 'package.json'), 'utf8').catch(() => null);
    if (raw) { const parsed = JSON.parse(raw) as SourceManifest; if (parsed.name && parsed.version) dirByName.set(parsed.name, { name: entry.name, version: parsed.version }); }
  }
  const peers = peerNames.map(peer => dirByName.get(peer)).filter((value): value is { name: string; version: string } => value !== undefined);
  const optionalDocs: string[] = [];
  for (const file of OPTIONAL_DOC_FILES) if (existsSync(join(sourceDir, file))) optionalDocs.push(file);
  const hasGitignore = existsSync(join(sourceDir, '.gitignore'));
  return { peers, optionalDocs, hasGitignore, sourceDir };
}

/** Exact pins throughout: every extension is released with core at core's version, and so is every sibling it peers on. */
function packageJson(name: string, description: string, core: CoreManifest, fork: ForkShape | undefined): string {
  const devDependencies: Record<string, string> = { '@jimhoyd/urlcode': 'file:../..' };
  const peerDependencies: Record<string, string> = { '@jimhoyd/urlcode': core.version };
  for (const peer of fork?.peers ?? []) {
    devDependencies[`@jimhoyd/urlcode-${peer.name}`] = `file:../${peer.name}`;
    peerDependencies[`@jimhoyd/urlcode-${peer.name}`] = peer.version;
  }
  devDependencies['@types/node'] = core.devDependencies['@types/node']!;
  devDependencies.typescript = core.devDependencies.typescript!;
  const manifest = {
    name: `@jimhoyd/urlcode-${name}`,
    version: core.version,
    description,
    private: true,
    type: 'module',
    license: 'Apache-2.0',
    repository: { type: 'git', url: 'git+https://github.com/jimhoyd-com/urlcode.git', directory: `packages/${name}` },
    homepage: `https://github.com/jimhoyd-com/urlcode/tree/main/packages/${name}#readme`,
    bugs: { url: 'https://github.com/jimhoyd-com/urlcode/issues' },
    engines: { node: core.engines.node },
    exports: {
      '.': { types: './dist/index.d.ts', default: './dist/index.js' },
      './extension': { types: './dist/extension.d.ts', default: './dist/extension.js' },
    },
    files: ['dist', 'urlcode.json', 'README.md', 'LICENSE', 'NOTICE', 'SECURITY.md'],
    scripts: {
      typecheck: 'tsc --noEmit',
      build: `node -e "require('node:fs').rmSync('dist',{recursive:true,force:true})" && tsc -p tsconfig.build.json`,
      test: 'node --conditions=development --test test/*.test.ts',
      verify: 'npm run typecheck && npm run build && npm test',
    },
    devDependencies,
    peerDependencies,
  };
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

/** The generated configuration schema, written into both src/<name>.ts and urlcode.json so the two agree. */
function configSchema(): Record<string, unknown> {
  return {
    type: 'object', additionalProperties: false, required: ['mounts'],
    properties: {
      mounts: {
        type: 'object', minProperties: 1, maxProperties: 32, propertyNames: { pattern: '^[a-z][a-z0-9_-]{0,63}$' },
        additionalProperties: {
          type: 'object', additionalProperties: false, required: ['mount', 'message'],
          properties: {
            mount: { type: 'string', pattern: '^/[A-Za-z0-9._~-]+(?:/[A-Za-z0-9._~-]+)*$', maxLength: 256 },
            message: { type: 'string', minLength: 1, maxLength: 512 },
          },
        },
      },
    },
  };
}
/** The generated authoring contract, written into both src/<name>.ts and urlcode.json. */
function authoringContract(name: string): Record<string, unknown> {
  return {
    description: 'TODO: describe what this extension declares and owns. This is a generated placeholder (create-extension) -- replace the mounts/message example with the real declarative surface.',
    surfaces: [
      { kind: 'configuration', name: 'mounts', description: 'TODO: describe the real declared configuration surface.', path: `urlcode.yaml#extensions.${name}.config.mounts` },
      { kind: 'extension', name: 'mount', description: 'Mount each declared entry with GET and HEAD.', path: 'urlcode.yaml' },
    ],
    fastChecks: ['urlcode validate --project . --host-file <host.mjs> --origin <origin>', 'urlcode test --project . --host-file <host.mjs> --origin <origin>'],
  };
}

/**
 * The descriptor `npm run build:addons` would write from the generated src/extension.ts, so the root install's
 * prepare step (which builds the add-on catalog from every urlcode.json) accepts the package before its first build.
 */
function urlcodeJson(name: string, description: string, fork: ForkShape | undefined): string {
  return `${JSON.stringify({ kind: 'extension', name, description, requires: (fork?.peers ?? []).map(peer => peer.name), schema: configSchema(), authoring: authoringContract(name) }, null, 2)}\n`;
}

function readmeMd(name: string, camel: string, description: string, fork: ForkShape | undefined): string {
  const forkNote = fork ? `\nGenerated with \`--from ${fork.sourceDir.split('/').pop()}\`: this package starts from that package's *file shape and conventions* (workspace peers, doc set), not its source code. Replace the placeholder handler in \`src/${name}.ts\` with this extension's own behavior.\n` : '';
  return `# @jimhoyd/urlcode-${name}

${description}
${forkNote}
> Generated by \`scripts/create-extension.ts\` (see [CONTRIBUTING.md](../../CONTRIBUTING.md) and
> [docs/EXTENSIONS.md](../../docs/EXTENSIONS.md#building-an-extension)). This README is a
> skeleton -- replace every TODO before this package is anything but a scaffold, and
> work through the [author checklist](../../docs/EXTENSIONS.md#author-checklist) of the
> [generic add-on authoring rules](../../docs/EXTENSIONS.md#generic-add-on-authoring-rules).

This extension is trusted operator code (not sandboxed) that runs in the
host process, exactly like every other package under \`packages/\`. It is
released with core and installed into a site with
\`urlcode extensions add ${name}\`.

## TODO: declare the extension

\`urlcode extensions add ${name}\` writes this for you (from \`scaffold\` in
\`src/extension.ts\`): the configuration into \`app/urlcode.yaml\` and the route
into \`app/routes/${name}.yaml\`.

\`\`\`yaml
version: "1"
extensions:
  ${name}:
    version: "1"
    config:
      mounts:
        example:
          mount: /${name}
          message: TODO replace this placeholder configuration surface
routes:
  /${name}/*:
    extension: ${name}
    methods: [GET, HEAD]
\`\`\`

## Host file

\`urlcode extensions add ${name}\` also adds it to the site's \`host.mjs\`, which
pins the reviewed project revision (the \`--policy\` file's \`projectSha256\`, or
\`PROJECT_SHA256\`) and calls \`host()\` in
\`src/extension.ts\`:

\`\`\`js
// host.mjs (trusted operator code, outside the project)
import { composeHost } from '@jimhoyd/urlcode/host';
import ${camel} from '@jimhoyd/urlcode-${name}/extension';
export default await composeHost(import.meta.url, [${camel}()]);
\`\`\`

## TODO

- Describe what this extension actually declares and owns.
- Replace the placeholder \`mounts\`/\`message\` configuration in
  \`src/${name}.ts\` with the extension's real declarative surface, and the
  scaffold in \`src/extension.ts\` with what \`urlcode extensions add ${name}\`
  should write.
- Fill in [SECURITY.md](SECURITY.md) with the extension's actual trust
  boundary once the real behavior is implemented.
- Extend [test/${name}.test.ts](test/${name}.test.ts) to cover it.

Requires the matching \`@jimhoyd/urlcode\` core as a peer. Apache-2.0.
`;
}

function securityMd(name: string): string {
  return `# Security boundary

TODO: replace this with the extension's actual trust boundary once its real
behavior is implemented. The scaffolded defaults below hold until then.

\`${name}\` is trusted operator code that runs in the host process. It is not
a sandbox or a multi-tenant boundary. Project configuration cannot select a
module, a secret, a storage directory, or a provider that this package does
not itself declare and validate.

An operator-reviewed project revision (which \`composeHost\` in the site's
\`host.mjs\` takes from the \`--policy\` file or \`PROJECT_SHA256\` and passes
to \`host()\` as \`context.projectSha256\`) is required; the extension refuses
to register without it, the same as every other package under \`packages/\`.

TODO: document request admission (body size bounds, content-type checks),
any credential/secret handling, CSRF or other cross-origin admission if this
extension accepts unsafe HTTP methods, and how a handler error is reported
to the caller vs. the operator.

Passing tests does not establish independent security assessment, hostile
multi-tenant readiness, production abuse resistance, or delivery guarantees.
Report suspected vulnerabilities through the repository's private reporting
channel described in the root SECURITY.md.
`;
}

function changelogMd(name: string, version: string): string {
  return `# @jimhoyd/urlcode-${name}

## ${version}

Generated package skeleton (\`scripts/create-extension.ts\`); replace this
entry with the extension's actual first behavior once implemented. Released
with core and installed with \`urlcode extensions add ${name}\`.
`;
}

function agentsMd(name: string): string {
  return `# Working on URLCode ${name}

- Read the root [CONTRIBUTING.md](../../CONTRIBUTING.md) and
  [SECURITY.md](../../SECURITY.md) first. Core owns the generic extension
  contract (\`@jimhoyd/urlcode/extensions\`); this package owns TODO: describe
  what this extension is responsible for and what it must never reimplement
  from core.
- Apache-2.0. Do not publish packages by hand. This package is released with
  core at core's version and installed with \`urlcode extensions add ${name}\`;
  \`"private": true\` in \`package.json\` only prevents an accidental
  \`npm publish\`. \`src/extension.ts\` is its definition (scaffold and host);
  \`urlcode.json\` is generated from it (\`npm run build:addons\`).
- TypeScript run through Node type stripping; \`dist/\` is built, never
  committed. Any workspace sibling peer resolves through the \`file:../<name>\`
  link that \`scripts/check-workspace-links.ts\` enforces, never from a
  registry.
- Run \`npm run verify\` for every change. Add a regression test in
  \`test/${name}.test.ts\` for behavior this package owns.
- Never commit credentials or customer data. Synthetic fixtures only.
- Report actual evidence and remaining limitations; CI is not a security
  review.

## File what you find

Do not drop a defect, a gap or an idea you could not act on. File it against
[urlcode](https://github.com/jimhoyd-com/urlcode/issues), using its issue
templates -- this package lives in that same repository.
`;
}

function llmsTxt(name: string, description: string): string {
  return `# URLCode ${name}

> ${description} Generated scaffold (\`scripts/create-extension.ts\`); released
> with core and installed with \`urlcode extensions add ${name}\`. Apache-2.0.

Part of the URLCode framework, in the same repository: docs/FRAMEWORK.md

## What a project declares (YAML only; never packages, code or credentials)
- TODO: describe \`extensions.${name}.config\` once it is real.
- \`urlcode extensions add ${name}\` adds it to the site's host.mjs, which
  \`composeHost\` builds with the reviewed revision pin.

## Read in this order
- [README](README.md): what this extension declares and how to wire it in.
- [SECURITY](SECURITY.md): trust boundary (currently a TODO skeleton).
- docs/EXTENSIONS.md#generic-add-on-authoring-rules: the rules and author
  checklist every add-on must satisfy.

## Do not guess
- This package is a generated skeleton. Do not present any of the TODO
  surfaces above as implemented until they are.
`;
}

function tsconfigJson(): string { return `{\n  "extends": "../../tsconfig.base.json",\n  "include": [\n    "src",\n    "test"\n  ]\n}\n`; }
function tsconfigBuildJson(): string { return `{"extends":"./tsconfig.json","compilerOptions":{"rootDir":"src","outDir":"dist","declaration":true},"include":["src"]}\n`; }
function noticeText(name: string): string { return `URLCode ${name} (@jimhoyd/urlcode-${name})\nCopyright (c) the URLCode contributors\n\nThis product is licensed under the Apache License, Version 2.0 (see LICENSE).\n`; }

function indexTs(name: string, Name: string, camel: string): string {
  return `export { create${Name}Extension, ${camel}Authoring, ${camel}ConfigSchema } from './${name}.ts';
export type { ${Name}ExtensionOptions, ${Name}MountSpec } from './${name}.ts';
`;
}

function definitionTs(name: string, Name: string, camel: string, description: string, requires: readonly string[]): string {
  return `// Generated by scripts/create-extension.ts. The one definition of this
// extension: \`urlcode extensions add ${name}\` runs \`scaffold\`, and the site's
// host.mjs (\`composeHost\`) runs \`host\`. The static fields are what
// \`npm run build:addons\` writes into urlcode.json.
import { defineExtension } from '@jimhoyd/urlcode/extensions';
import type { ScaffoldRequest, ScaffoldResult } from '@jimhoyd/urlcode/extensions';
import { create${Name}Extension, ${camel}Authoring, ${camel}ConfigSchema } from './${name}.ts';

/** Operator choices passed in host.mjs, for example \`${camel}({...})\`. TODO: add real options or leave empty. */
export type ${Name}HostOptions = Record<string, never>;

/**
 * TODO: return what \`urlcode extensions add ${name}\` should write: the capability only, what the extension needs to
 * function, with no sample application endpoints. Put a demo in an optional \`example(request)\` on the definition;
 * core writes it on top only with \`--example\`.
 */
function scaffold(_request: ScaffoldRequest): ScaffoldResult {
  return {
    config: { mounts: { example: { mount: '/${name}', message: 'Hello from ${name}.' } } },
    routes: { '/${name}/*': { extension: '${name}', methods: ['GET', 'HEAD'] } },
    notes: ['${name} serves a placeholder message on /${name}; replace it in app/urlcode.yaml.'],
  };
}

export default defineExtension<${Name}HostOptions>({
  name: '${name}',
  description: ${JSON.stringify(description)},
  requires: ${JSON.stringify(requires)},
  schema: ${camel}ConfigSchema,
  authoring: ${camel}Authoring,
  scaffold,
  host(context) {
    return { registration: create${Name}Extension({ projectSha256: context.projectSha256 }) };
  },
});
`;
}

function extensionSourceTs(name: string, Name: string, camel: string): string {
  return `// Generated by scripts/create-extension.ts. This is a minimal, working
// RuntimeExtension skeleton -- replace the config shape and \`handle\` body
// with this extension's real declarative surface and behavior. Keep the
// activation shape (explicit projectSha256 pin, mount-declaration checks)
// unless there is a concrete reason to diverge from the pattern every other
// extension package under packages/ follows; see docs/EXTENSIONS.md.
import type { ExtensionAuthoringContract, ExtensionInstance, ExtensionRequest, HandlerResult, RuntimeExtension } from '@jimhoyd/urlcode/extensions';

export interface ${Name}MountSpec { mount: string; message: string }
interface ${Name}Config { mounts: Record<string, ${Name}MountSpec> }
export interface ${Name}ExtensionOptions {
  /** Exact project revision the operator reviewed (\`inspectExtensionRevision\`). */
  projectSha256: string;
}

export const ${camel}ConfigSchema = ${JSON.stringify(configSchema(), null, 2)} as const;

export const ${camel}Authoring: ExtensionAuthoringContract = ${JSON.stringify(authoringContract(name), null, 2)};

function textResponse(status: number, body: string): HandlerResult {
  return { status, headers: [['content-type', 'text/plain; charset=utf-8']], body };
}

/** Creates the ${name} registration. TODO: rename and rewrite this once the extension's real behavior is implemented. */
export function create${Name}Extension(options: ${Name}ExtensionOptions): RuntimeExtension {
  if (!/^[a-f0-9]{64}$/.test(options.projectSha256)) throw new Error('${name} extension requires an explicit operator revision pin');
  return {
    name: '${name}', version: '1', projectSha256: options.projectSha256, targets: ['node', 'aws', 'vercel'],
    schema: ${camel}ConfigSchema, authoring: ${camel}Authoring,
    async activate(raw, context): Promise<ExtensionInstance> {
      const config = raw as unknown as ${Name}Config;
      const byMount = new Map<string, ${Name}MountSpec>();
      for (const [entryName, spec] of Object.entries(config.mounts)) {
        if (!context.mounts.includes(spec.mount)) throw new Error(\`${Name} entry \${entryName}: route \${spec.mount} with extension: ${name} is not declared\`);
        const clash = byMount.get(spec.mount);
        if (clash) throw new Error(\`${Name} entries share mount \${spec.mount}\`);
        byMount.set(spec.mount, spec);
      }
      for (const mount of context.mounts) if (!byMount.has(mount)) throw new Error(\`${Name} mount \${mount} has no declared entry\`);
      return {
        async handle(request: ExtensionRequest): Promise<HandlerResult> {
          const spec = request.mount === null ? undefined : byMount.get(request.mount);
          if (!spec || request.path !== request.mount) return textResponse(404, 'Not found');
          if (request.method === 'HEAD') return { status: 200, headers: [] };
          if (request.method !== 'GET') return { status: 405, headers: [['allow', 'GET, HEAD']], body: 'Method not allowed' };
          return textResponse(200, spec.message);
        },
      };
    },
  };
}
`;
}

function testTs(name: string, Name: string, camel: string): string {
  return `// Generated by scripts/create-extension.ts. Exercises the placeholder
// extension end to end: the project comes from its own scaffold, the
// registration from its host() through composeHost, and requests go over real
// HTTP. Extend this as the real behavior lands.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { startServer } from '@jimhoyd/urlcode';
import { inspectExtensionRevision } from '@jimhoyd/urlcode/extensions';
import { composeHost } from '@jimhoyd/urlcode/host';
import ${camel} from '../src/extension.ts';
import { create${Name}Extension, ${camel}ConfigSchema } from '../src/index.ts';

const origin = 'https://${name}.example.test';

async function boot(t: test.TestContext) {
  const site = await mkdtemp(join(tmpdir(), '${name}-test-'));
  t.after(() => rm(site, { recursive: true, force: true }));
  const project = join(site, 'app');
  await mkdir(project);
  const scaffolded = await ${camel}.definition.scaffold!({ site, project, installed: ['${name}'], acknowledgements: [] });
  await writeFile(join(project, 'urlcode.yaml'), JSON.stringify({ version: '1', extensions: { '${name}': { version: '1', config: scaffolded.config } }, routes: scaffolded.routes }));
  const previous = process.env.PROJECT_SHA256;
  process.env.PROJECT_SHA256 = await inspectExtensionRevision(project);
  t.after(() => { if (previous === undefined) delete process.env.PROJECT_SHA256; else process.env.PROJECT_SHA256 = previous; });
  const host = await composeHost(pathToFileURL(join(site, 'host.mjs')), [${camel}()]);
  const app = await startServer({ project, origin, port: 0, log: () => {}, extensions: host.extensions ?? [] });
  t.after(async () => { await app.close(); await host.close?.(); });
  return { app };
}

test('the definition shares the runtime schema and scaffolds a route for its own mount', async () => {
  assert.equal(${camel}.definition.name, '${name}');
  assert.equal(${camel}.definition.schema, ${camel}ConfigSchema);
  const scaffolded = await ${camel}.definition.scaffold!({ site: '/tmp/site', project: '/tmp/site/app', installed: ['${name}'], acknowledgements: [] });
  assert.deepEqual(Object.keys(scaffolded.routes), ['/${name}/*']);
});

test('the generated skeleton serves its scaffolded mount with the configured message', async t => {
  const { app } = await boot(t);
  const response = await fetch(\`http://127.0.0.1:\${app.address.port}/${name}\`);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'Hello from ${name}.');
});

test('HEAD on the declared mount returns 200 with no body', async t => {
  const { app } = await boot(t);
  const response = await fetch(\`http://127.0.0.1:\${app.address.port}/${name}\`, { method: 'HEAD' });
  assert.equal(response.status, 200);
  assert.equal(await response.text(), '');
});

test('a method the mount does not declare gets 405 with an Allow header', async t => {
  const { app } = await boot(t);
  const response = await fetch(\`http://127.0.0.1:\${app.address.port}/${name}\`, { method: 'POST' });
  assert.equal(response.status, 405);
  assert.equal(response.headers.get('allow'), 'GET, HEAD');
});

test('an undeclared sub-path 404s', async t => {
  const { app } = await boot(t);
  const response = await fetch(\`http://127.0.0.1:\${app.address.port}/${name}/nope\`);
  assert.equal(response.status, 404);
});

test('registration requires an explicit projectSha256 pin', () => {
  assert.throws(() => create${Name}Extension({ projectSha256: 'not-a-hash' }), /operator revision pin/);
});
`;
}

function optionalDocPlaceholder(file: string, name: string, fromSlug: string): string {
  return `# ${file.replace(/\.md$/, '')}

TODO: this file is a placeholder. \`packages/${fromSlug}\` (the \`--from\`
source for this scaffold) carries a \`${file}\`, so this fork reproduces that
it exists -- not its content, which is specific to ${fromSlug}'s own
behavior. Fill this in for \`${name}\`, or delete it if it does not apply.
`;
}

async function writeIfAbsent(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, { flag: 'wx' });
}

async function main(): Promise<void> {
  let args: Args;
  try { args = parseArgs(process.argv.slice(2)); }
  catch (error) { console.error((error as Error).message); printUsage(); process.exitCode = 1; return; }
  if (args.help) { printUsage(); return; }

  const { name } = args;
  if (!NAME.test(name)) { console.error(`Invalid package name "${name}": expected lowercase letters, digits and hyphens, starting with a letter (e.g. "widgets", "my-tool").`); process.exitCode = 1; return; }
  if (RESERVED.has(name)) { console.error(`"${name}" is a reserved name and cannot be used for a new extension package.`); process.exitCode = 1; return; }

  const outputDir = args.packagesDir === undefined ? packagesDir : resolve(args.packagesDir);
  if (dirname(outputDir) !== resolve(root)) { console.error('--packages-dir must be a directory directly under the repository root, so the package\'s ../.. links reach it.'); process.exitCode = 1; return; }
  const outputLabel = `${outputDir.slice(resolve(root).length + 1)}/${name}`;
  const targetDir = join(outputDir, name);
  if (existsSync(targetDir) || existsSync(join(packagesDir, name))) { console.error(`packages/${name} already exists; choose a different name or remove it first.`); process.exitCode = 1; return; }

  let fork: ForkShape | undefined;
  if (args.from) {
    if (args.from === name) { console.error('--from must name a different, already-existing package.'); process.exitCode = 1; return; }
    try { fork = await readForkShape(args.from); }
    catch (error) { console.error((error as Error).message); process.exitCode = 1; return; }
  }

  const core = await loadCoreManifest();
  const Name = pascalCase(name);
  const camel = camelCase(name);
  const description = args.description ?? `TODO: describe what the ${name} extension does.`;
  if (!description || description.length > 300 || /[\r\n]/.test(description)) { console.error('--description must be one line of at most 300 characters (it becomes the extension definition\'s description).'); process.exitCode = 1; return; }

  const files = new Map<string, string>();
  files.set('package.json', packageJson(name, description, core, fork));
  files.set('urlcode.json', urlcodeJson(name, description, fork));
  files.set('README.md', readmeMd(name, camel, description, fork));
  files.set('SECURITY.md', securityMd(name));
  files.set('CHANGELOG.md', changelogMd(name, core.version));
  files.set('AGENTS.md', agentsMd(name));
  files.set('llms.txt', llmsTxt(name, description));
  files.set('NOTICE', noticeText(name));
  files.set('tsconfig.json', tsconfigJson());
  files.set('tsconfig.build.json', tsconfigBuildJson());
  files.set(join('src', 'index.ts'), indexTs(name, Name, camel));
  files.set(join('src', `${name}.ts`), extensionSourceTs(name, Name, camel));
  files.set(join('src', 'extension.ts'), definitionTs(name, Name, camel, description, (fork?.peers ?? []).map(peer => peer.name)));
  files.set(join('test', `${name}.test.ts`), testTs(name, Name, camel));

  // LICENSE is the same Apache-2.0 boilerplate every package already carries verbatim; reuse an
  // existing copy instead of hand-typing it again.
  const licenseSource = join(packagesDir, 'mcp', 'LICENSE');
  const licenseText = existsSync(licenseSource) ? await readFile(licenseSource, 'utf8') : await readFile(join(root, 'LICENSE'), 'utf8');
  files.set('LICENSE', licenseText);

  if (fork) {
    if (fork.hasGitignore) files.set('.gitignore', 'dist/\n');
    for (const doc of fork.optionalDocs) files.set(doc, optionalDocPlaceholder(doc, name, args.from!));
  }

  for (const [relativePath, content] of files) await writeIfAbsent(join(targetDir, relativePath), content);

  console.log(`Created ${outputLabel} (${files.size} files)${fork ? ` forked from the file shape of packages/${args.from}` : ''}.`);
  console.log('');
  console.log('Next steps (not done automatically):');
  console.log(`  1. npm install                          # link the new workspace member`);
  console.log(`  2. npm run verify --workspace @jimhoyd/urlcode-${name}`);
  console.log(`  3. npm run build:addons                  # regenerate urlcode.json from src/extension.ts`);
  console.log(`  4. Replace every TODO in packages/${name} (README.md, SECURITY.md, src/${name}.ts, src/extension.ts, test/${name}.test.ts).`);
  console.log(`  5. Add packages/${name} to docs/FRAMEWORK.md. It is released with core and installed`);
  console.log(`     with \`urlcode extensions add ${name}\` once it is in the add-on list.`);
  console.log(`  6. Work through the author checklist: docs/EXTENSIONS.md#author-checklist`);
}

function printUsage(): void {
  console.log(`Usage: node scripts/create-extension.ts <name> [--from <existing-package>] [--description "..."]

Scaffolds packages/<name> as a new operator-installed extension package
skeleton (src/extension.ts defines its scaffold and host), matching the
minimal shape of packages/mcp and packages/store.

  <name>                 Package slug, e.g. "widgets" -> packages/widgets,
                          @jimhoyd/urlcode-widgets.
  --from <package>        Fork the file shape (doc set, workspace peers) of
                          an existing packages/<package> -- never its source
                          code, which the scaffold never copies.
  --description "..."     One-line package.json/README/extension description.
  --packages-dir <dir>    Write into <dir>/<name> instead of packages/<name>;
                          <dir> must sit directly under the repository root.
`);
}

await main();
