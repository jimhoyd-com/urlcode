import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// Every package.json subpath must resolve even when the repository test process
// enables --conditions=development, and carry the named exports its shipped
// entry file declares. Published manifests deliberately have no source-only
// condition: package-audit verifies every target exists in the tarball.
const expected: Record<string, string[]> = {
  '.': ['createRuntime','startServer','loadDocument','validateDocument','parseYaml','observabilityEvents','createMetrics','renderPrometheus','getCapabilities','importRoutes','exportRoutes','listRecipes','searchRecipes','listExamples','searchExamples','buildTypeScriptProject','importBulkProject','inspectProject','explainRoute','explainProject','buildManifest','serveMcp','verifyProviderDeployment','matchesRoute','buildCloudflare','buildStatic','runProjectTests','scaffoldProject','initProject','addRedirect','initProjectWith','collectDependencySet','renderPackageManifest','installSteps'],
  './agent-context': ['listSkills','getSkill','searchDocs','getExample','validateYaml','explainError'],
  './aws': ['createLambdaHandler'],
  './cloudflare': ['rehydrate','createFetchHandler'],
  './prerender': ['assertLiteralRoutePath','pageFileName','assertNativeProject','prerenderPages'],
  './vercel': ['createVercelHandler'],
  './plugins': ['validatePlugins','activatePlugins','pluginsRequest','pluginsResponse','pluginsError','closePlugins'],
  './policies': ['registry','targets','builtinProfiles','effectivePolicies','compilePolicies','compileErrorPolicy','errorHeaders','closePolicies','policyRequest'],
  './compliance': ['severities','builtinProfiles','profileNames','validateRules','resolveRules','loadComplianceRules','runCompliance'],
  './observability': ['events','validateObservers','createMetrics','createObserverSink','renderPrometheus','SNAPSHOT_VERSION'],
  './extensions': ['inspectExtensionRevision','effectiveExtensionPolicies','hasExtensionPolicy','prepareExtensions','extensionResponse'],
  './extension-bundles': ['installBundle','loadExtensionBundle','readBundleLock','parseBundleCatalog'],
  './release-train': ['githubSafeReleaseTrainTransport','parseSafeReleaseTrain','resolveSafeReleaseTrain','safeReleaseTrainTag','TRAIN_ASSET'],
  './sandbox': ['SandboxPool','functionFile'],
  './body-schema': ['assertBodySchema','bodySchemaIssues','checkBodySchema','bodySchemaLine','bodySchemaJson','bodySchemaSubset','uuidFormat'],
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
