import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { existsSync, realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { publishedManifest } from '../scripts/published-manifest.mjs';

// Every package.json subpath must resolve and carry the named exports its entry
// file declares. The repository test process enables --conditions=development,
// so here that is the TypeScript source; a packed manifest has no `development`
// condition, and package-audit verifies every target exists in the tarball.
const expected: Record<string, string[]> = {
  '.': ['createRuntime','startServer','createEmbeddedHandler','loadDocument','validateDocument','parseYaml','observabilityEvents','createMetrics','renderPrometheus','getCapabilities','listRecipes','searchRecipes','listExamples','searchExamples','addExample','buildTypeScriptProject','importBulkProject','inspectProject','explainRoute','explainProject','buildManifest','serveMcp','verifyProviderDeployment','matchesRoute','buildCloudflare','buildStatic','runProjectTests','scaffoldProject','initProject','addRedirect','initSite','initSiteWith','addAddons','removeAddon','listAddons','validateDeclaredExtensions','readAddonManifest','readAddonCatalog','composeHost','defineExtension'],
  './agent-context': ['listSkills','getSkill','listAgentCatalog','readAddonCatalog','searchDocs','getExample','validateYaml','explainError','suggestFixtures','summarizeYamlChange'],
  './aws': ['createLambdaHandler'],
  './cloudflare': ['rehydrate','createFetchHandler'],
  './prerender': ['assertLiteralRoutePath','pageFileName','assertNativeProject','prerenderPages'],
  './vercel': ['createVercelHandler'],
  './plugins': ['validatePlugins','activatePlugins','pluginsRequest','pluginsResponse','pluginsError','closePlugins'],
  './policies': ['registry','targets','builtinProfiles','effectivePolicies','compilePolicies','compileErrorPolicy','errorHeaders','closePolicies','policyRequest'],
  './compliance': ['severities','builtinProfiles','profileNames','validateRules','resolveRules','loadComplianceRules','runCompliance'],
  './observability': ['events','validateObservers','createMetrics','createObserverSink','renderPrometheus','SNAPSHOT_VERSION'],
  './extensions': ['inspectExtensionRevision','effectiveExtensionPolicies','hasExtensionPolicy','prepareExtensions','extensionResponse','defineExtension','clientKey','clientKeyIpv6Prefix','ExtensionHttpError','readBody','jsonResponse','isSameOriginRequest','AuditError','auditLimits','validateAuditEvent','validateAuditQuery'],
  './sqlite': ['holdServerLock','hostProbe','NETWORK_FILESYSTEMS','refuseNetworkFilesystem','serverLockHeld','serverLockPath'],
  './host': ['composeHost'],
  './sandbox': ['SandboxPool','functionFile'],
  './body-schema': ['assertBodySchema','compileBodySchema','bodyIssues','bodySchemaIssues','checkBodySchema','bodySchemaLine','bodySchemaJson','bodySchemaEnvelope','bodySchemaProfile','bodySchemaDialect','declaredBodyNames','holdsIllFormedString','illFormedMember','maxRequestBodyBytes','uuidFormat'],
  './skills': ['listShippedSkills'],
};

test('every package.json subpath resolves to shipped code and exposes its named exports', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as { name: string; exports: Record<string, unknown> };
  const subpaths = Object.keys(pkg.exports).filter(key => typeof pkg.exports[key] === 'object');
  assert.deepEqual(subpaths.sort(), Object.keys(expected).sort(), 'test table must list exactly the JavaScript subpaths');
  for (const [subpath, names] of Object.entries(expected)) {
    const module = await import(subpath === '.' ? pkg.name : `${pkg.name}/${subpath.slice(2)}`) as Record<string, unknown>;
    for (const name of names) assert.ok(name in module, `${subpath} exports ${name}`);
  }
  assert.equal(pkg.exports['./package.json'], './package.json');
  assert.equal(pkg.exports['./schema'], './schemas/urlcode.schema.json');
});

// The SQLite helpers the bundled extensions share live on `./sqlite` (#1052): an extension on another database imports
// the generic contract without loading `node:sqlite`. A fresh process, so nothing else in this run loaded it first.
test('the generic extensions entry does not load node:sqlite; the sqlite entry does', () => {
  const loads = (subpath: string): boolean => {
    const code = `import { registerHooks } from 'node:module';
let sqlite = false;
registerHooks({ resolve(specifier, context, next) { if (specifier === 'node:sqlite' || specifier === 'sqlite') sqlite = true; return next(specifier, context); } });
await import('@jimhoyd/urlcode/${subpath}');
process.stdout.write(JSON.stringify(sqlite || process.moduleLoadList.includes('NativeModule sqlite')));`;
    const run = spawnSync(process.execPath, ['--input-type=module', '-e', code], { cwd: fileURLToPath(new URL('..', import.meta.url)), encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    return JSON.parse(run.stdout) as boolean;
  };
  assert.equal(loads('extensions'), false, '@jimhoyd/urlcode/extensions must not load node:sqlite');
  assert.equal(loads('sqlite'), true, 'the probe sees node:sqlite when an entry loads it');
});

// A workspace package resolves core (and a sibling add-on, should one ever peer on another) to source under `development` (#1056), so a change to a core
// export reaches every add-on's typecheck and tests with no `npm run build`. Without it they read dist/, which goes
// stale after every merge until someone rebuilds.
const repository = realpathSync(fileURLToPath(new URL('..', import.meta.url)));
const manifests = ['package.json', 'packages/auth/package.json', 'packages/mcp/package.json', 'packages/store/package.json'];

test('every JavaScript export of core and each add-on names its source first under development, and packing drops it', async () => {
  for (const file of manifests) {
    const text = await readFile(join(repository, file), 'utf8');
    const pkg = JSON.parse(text) as { exports: Record<string, unknown> };
    const source = file === 'package.json' ? 'packages/core/src' : 'src';
    for (const [subpath, entry] of Object.entries(pkg.exports)) {
      if (typeof entry !== 'object' || entry === null) continue;
      const conditions = entry as Record<string, string>;
      // First, or TypeScript takes `types` (the built declarations) before it ever reaches `development`.
      assert.equal(Object.keys(conditions)[0], 'development', `${file} ${subpath}: development must be the first condition`);
      const target = conditions.development!;
      assert.match(target, new RegExp(`^\\./${source}/[\\w-]+\\.ts$`), `${file} ${subpath}: development names ${source}/*.ts`);
      assert.ok(existsSync(join(repository, dirname(file), target)), `${file} ${subpath}: ${target} exists`);
      assert.equal(target.replace(`./${source}/`, '').replace(/\.ts$/, ''), conditions.default!.replace(/^\.\/dist\//, '').replace(/\.js$/, ''), `${file} ${subpath}: source and build name the same module`);
    }
    assert.doesNotMatch(JSON.stringify((JSON.parse(publishedManifest(text)) as { exports: unknown }).exports), /"development"|\/src\/|(?<!\.d)\.ts"/, `${file}: the packed manifest's exports name no development condition or source`);
  }
});

test('a workspace package resolves core to source under development, in Node and in tsc', () => {
  const store = join(repository, 'packages', 'store');
  const code = "process.stdout.write(JSON.stringify(['@jimhoyd/urlcode/sqlite','@jimhoyd/urlcode/extensions'].map(s => import.meta.resolve(s))))";
  const run = spawnSync(process.execPath, ['--conditions=development', '--input-type=module', '-e', code], { cwd: store, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  const [sqlite, extensions] = (JSON.parse(run.stdout) as string[]).map(url => relative(repository, realpathSync(fileURLToPath(url))).split(sep).join('/'));
  assert.equal(sqlite, 'packages/core/src/sqlite.ts');
  assert.equal(extensions, 'packages/core/src/extensions.ts');

  const resolveFrom = (config: string, specifier: string): string => {
    const parsed = ts.getParsedCommandLineOfConfigFile(join(store, config), {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: diagnostic => assert.fail(ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')) });
    assert.ok(parsed);
    const resolved = ts.resolveModuleName(specifier, join(store, 'src', 'index.ts'), parsed.options, ts.sys).resolvedModule?.resolvedFileName;
    assert.ok(resolved, `${config} resolves ${specifier}`);
    return relative(repository, realpathSync(resolved)).split(sep).join('/');
  };
  // The typecheck (and every test run) reads source; the emitting build reads core's built declarations, since its
  // rootDir is the add-on's own src/.
  assert.equal(resolveFrom('tsconfig.json', '@jimhoyd/urlcode/sqlite'), 'packages/core/src/sqlite.ts');
  assert.equal(resolveFrom('tsconfig.json', '@jimhoyd/urlcode/extensions'), 'packages/core/src/extensions.ts');
  const parsedBuild = ts.getParsedCommandLineOfConfigFile(join(store, 'tsconfig.build.json'), {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => {} });
  assert.deepEqual(parsedBuild?.options.customConditions, [], 'the add-on build resolves built declarations, not source outside its rootDir');
});
