import { analyzeProjectCapabilities, analyzeCompiledCapabilities, assertTargetCompatibility } from './capabilities.ts';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import Ajv from 'ajv/dist/2020.js';
import standaloneCode from 'ajv/dist/standalone/index.js';
import { loadDocument } from './config.ts';
import { compileRoutes } from './router.ts';
import { assert } from './errors.ts';
import { effectivePolicies, registry } from './policies.ts';
import { resolveLists } from './agent-lists.ts';
import { applySite } from './site.ts';
import type { Artifact, ArtifactParameter, ArtifactRoute } from './cloudflare.ts';
import type { EffectivePolicies, LogFn, PolicyModule, PolicyName } from './types.ts';

export interface BuildOptions { out?: string | undefined; origin?: string | undefined; log?: LogFn | undefined }
export interface BuildReport { out: string; format: number; version: string; routes: number; validators: number }

// The artifact is this runtime's build output, not a published contract: the
// format may change with any release, and the runtime refuses a version it does
// not recognise rather than guessing.
const FORMAT = 1;

// Policies this target can carry in the artifact. Anything else is refused at
// build time with the route named, like an unsupported handler: the Worker has
// no shared counters, no origin cache and the platform compresses itself.
const compilablePolicies = new Set(['agents','security']);
const isPolicyName = (name: string): name is PolicyName => Object.hasOwn(registry, name);
// The registry pairs each module with its own config type; the build works on
// the erased contract, the same one the compiled chain holds.
const policyModule = (name: PolicyName): PolicyModule => registry[name];

// Ajv's standalone output hardcodes a CommonJS `require` for its runtime
// helpers even in ESM mode, and an ES module cannot evaluate that. Each helper
// is inlined from the installed Ajv instead of a hand-copied duplicate, so it
// can never drift from the validator that calls it. A helper that is not a
// self-contained function, or a `require` this does not recognise, fails the
// build rather than shipping a Worker that cannot start.
const runtimeModule = /require\("ajv\/dist\/runtime\/([\w-]+)(?:\.js)?"\)\.default/g;
async function linkRuntime(source: string): Promise<string> {
  const prelude: string[] = [], linked: string[] = [];
  let index = 0;
  for (const match of source.matchAll(runtimeModule)) {
    const name = match[1] ?? '', local = `urlcodeRuntime_${name.replace(/\W/g,'_')}`;
    if (!prelude.some(line => line.startsWith(`const ${local} `))) {
      let helper: unknown;
      // CommonJS interop: the namespace default is the module's exports object.
      try {
        const module: unknown = (await import(`ajv/dist/runtime/${name}.js`) as { default: unknown }).default; // trust boundary: a CommonJS module namespace
        helper = typeof module === 'function' ? module : module !== null && typeof module === 'object' && 'default' in module ? module.default : undefined;
      } catch { helper = undefined; }
      assert(typeof helper === 'function' && !/^\s*(?:class|\w+\s*=>)/.test(helper.toString()),
        `Ajv runtime helper "${name}" cannot be inlined; this schema is unsupported on this target`);
      prelude.push(`const ${local} = ${helper.toString()};`);
    }
    linked.push(source.slice(index, match.index), local);
    index = match.index + match[0].length;
  }
  linked.push(source.slice(index));
  let out = linked.join('');
  // Keep any leading directive first so the prelude cannot demote it.
  const directive = out.match(/^\s*(["'])use strict\1;/)?.[0] ?? '';
  out = directive + '\n' + prelude.join('\n') + (prelude.length ? '\n' : '') + out.slice(directive.length);
  assert(!/\brequire\s*\(/.test(out), 'Generated validators still reference CommonJS; this schema is unsupported on this target');
  return out;
}

export async function buildCloudflare(project: string, { out = 'dist/cloudflare', origin, log = () => {} }: BuildOptions = {}): Promise<BuildReport> {
  const loaded = await loadDocument(project);
  // Generated site routes are built like declared ones; the ones that need
  // an origin get it from --origin, exactly as the server does.
  await applySite(loaded, { origin, log });
  assertTargetCompatibility(analyzeProjectCapabilities(loaded, 'cloudflare'));
  // No bindings are resolved: a build artifact must never carry a secret, and
  // this target has no per-request operator policy to pin one to.
  const compiled = await compileRoutes(loaded, {}, {}, undefined);
  const routes = [...compiled.exact.values(), ...[...compiled.byLength.values()].flat(), ...compiled.mounts];

  assertTargetCompatibility(analyzeCompiledCapabilities(loaded.document, compiled, 'cloudflare'));
  for (const route of routes) {
    const policies: EffectivePolicies = effectivePolicies(loaded.document, route);
    for (const name of Object.keys(policies)) {
      assert(isPolicyName(name), `Unknown policy "${name}"`);
      const support = policyModule(name).targets(policies[name]).cloudflare;
      // The platform provides it: accepted and dropped, never carried.
      if (support === 'delegated') { delete policies[name]; continue; }
      assert(compilablePolicies.has(name) && support === 'compiled', `${route.pattern}: policies.${name} cannot be compiled for this target`);
    }
    // Project-relative agent lists are read here, once, so the artifact
    // carries the patterns and the Worker never needs a filesystem.
    if (policies.agents) {
      const resolved = await resolveLists(policies.agents, loaded.root, route.pattern);
      if (resolved) policies.agents = resolved; else delete policies.agents;
    }
    // Compiled policies validate now, at build time, so the Worker never
    // evaluates a configuration the runtime would have rejected.
    for (const name of Object.keys(policies)) if (isPolicyName(name) && compilablePolicies.has(name)) await policyModule(name).compile(policies[name], { route, shared: {}, target: 'cloudflare', document: loaded.document, root: loaded.root });
    if (Object.keys(policies).length) route.compiledPolicies = policies; else delete route.compiledPolicies;
  }
  assert(routes.length, 'No routes to build');

  const ajv = new Ajv.default({ code:{ source:true, esm:true }, strict:false, allErrors:false });
  const validators: Record<string, string> = {}, serialised: ArtifactRoute[] = [];
  for (const route of routes) {
    const parameters: ArtifactParameter[] = [];
    for (const parameter of route.parameters) {
      // One validator per distinct schema, named for the route and input it
      // serves so a build failure points at the YAML that caused it.
      const id = `v${Object.keys(validators).length}`;
      const { default: _default, ...shape } = parameter.schema;
      ajv.addSchema(shape, id);
      validators[id] = id;
      parameters.push({ name:parameter.name, in:parameter.in, required:parameter.required === true,
        schema:parameter.schema, validator:id });
    }
    serialised.push({ pattern:route.pattern, parts:route.parts, names:route.names, methods:route.methods,
      parameters, responseHeaders:route.responseHeaders,
      ...(route.request ? { request:route.request } : {}),
      ...(route.redirect ? { redirect:route.redirect } : {}),
      ...(route.reply ? { reply:{ status:route.reply.status, headers:route.reply.headers, body:Buffer.from(route.reply.body).toString('utf8') } } : {}),
      ...(route.enabled === false ? { enabled:false } : {}),
      ...(route.expiresAt ? { expiresAt:route.expiresAt } : {}),
      ...(route.compiledPolicies ? { policies:route.compiledPolicies } : {}) });
  }

  // Project-level security headers for the Worker's own 404 and error
  // answers, the same headers the self-hosted server gives them.
  const projectPolicies = effectivePolicies(loaded.document, {});
  const errorPolicy = projectPolicies.security && registry.security.targets(projectPolicies.security).cloudflare === 'compiled'
    ? { security: projectPolicies.security } : undefined;
  if (errorPolicy) registry.security.compile(errorPolicy.security, { route: { pattern: '(project)' }, shared: {}, target: 'cloudflare', document: loaded.document });

  const artifact: Artifact = { format:FORMAT, version:loaded.version, routes:serialised, ...(errorPolicy ? { policies: errorPolicy } : {}) };
  await mkdir(out, { recursive:true });
  await writeFile(join(out,'validators.js'), await linkRuntime(standaloneCode.default(ajv, validators)));
  await writeFile(join(out,'artifact.js'),
    `// Generated by urlcode build. Do not edit; rebuild instead.\nexport default ${JSON.stringify(artifact,null,2)};\n`);
  await writeFile(join(out,'index.js'), `// Generated by urlcode build. Do not edit; rebuild instead.
import { createFetchHandler } from '@jimhoyd/urlcode/cloudflare';
import artifact from './artifact.js';
import * as validators from './validators.js';

export default { fetch: createFetchHandler(artifact, validators) };
`);
  return { out, format:FORMAT, version:loaded.version, routes:serialised.length,
    validators:Object.keys(validators).length };
}
