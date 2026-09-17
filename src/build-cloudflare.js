import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import Ajv from 'ajv/dist/2020.js';
import standaloneCode from 'ajv/dist/standalone/index.js';
import { loadDocument } from './config.js';
import { compileRoutes } from './router.js';
import { assert } from './errors.js';
import { effectivePolicies, registry } from './policies.js';

// Handlers this target cannot serve, and why. Declarative routes only in this
// slice: assets need a platform binding rather than an inline copy, and the
// sandbox needs facilities the platform does not provide.
const unsupported = {
  function:'isolated functions need worker threads and the WASM engine',
  link:'stored live links need a durable writable store',
  page:'pages need a static-asset binding',
  static:'static directories need a static-asset binding',
  download:'downloads need a static-asset binding',
};

// The artifact is this runtime's build output, not a published contract: the
// format may change with any release, and the runtime refuses a version it does
// not recognise rather than guessing.
const FORMAT = 1;

// Policies this target can carry in the artifact. Anything else is refused at
// build time with the route named, like an unsupported handler: the Worker has
// no shared counters, no origin cache and the platform compresses itself.
const compilablePolicies = new Set(['agents','security']);

// Ajv's standalone output hardcodes a CommonJS `require` for its runtime
// helpers even in ESM mode, and an ES module cannot evaluate that. Each helper
// is inlined from the installed Ajv instead of a hand-copied duplicate, so it
// can never drift from the validator that calls it. A helper that is not a
// self-contained function, or a `require` this does not recognise, fails the
// build rather than shipping a Worker that cannot start.
const runtimeModule = /require\("ajv\/dist\/runtime\/([\w-]+)(?:\.js)?"\)\.default/g;
async function linkRuntime(source) {
  const prelude = [], linked = [];
  let index = 0;
  for (const match of source.matchAll(runtimeModule)) {
    const name = match[1], local = `urlcodeRuntime_${name.replace(/\W/g,'_')}`;
    if (!prelude.some(line => line.startsWith(`const ${local} `))) {
      let helper;
      // CommonJS interop: the namespace default is the module's exports object.
      try {
        const module = (await import(`ajv/dist/runtime/${name}.js`)).default;
        helper = typeof module === 'function' ? module : module?.default;
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

export async function buildCloudflare(project, { out = 'dist/cloudflare' } = {}) {
  const loaded = await loadDocument(project);
  // No bindings are resolved: a build artifact must never carry a secret, and
  // this target has no per-request operator policy to pin one to.
  const compiled = await compileRoutes(loaded, {}, {}, undefined);
  const routes = [...compiled.exact.values(), ...[...compiled.byLength.values()].flat(), ...compiled.mounts];

  const refused = [];
  for (const route of routes) {
    for (const [handler, reason] of Object.entries(unsupported)) {
      if (route[handler]) refused.push(`${route.pattern}: ${reason}`);
    }
    if (route.middleware?.length) refused.push(`${route.pattern}: middleware needs the sandbox`);
    const policies = effectivePolicies(loaded.document, route);
    for (const name of Object.keys(policies)) {
      if (!compilablePolicies.has(name) || registry[name].targets(policies[name]).cloudflare !== 'compiled') refused.push(`${route.pattern}: policies.${name} cannot be compiled for this target`);
    }
    // Compiled policies validate now, at build time, so the Worker never
    // evaluates a configuration the runtime would have rejected.
    for (const name of Object.keys(policies)) if (compilablePolicies.has(name)) await registry[name].compile(policies[name], { route, shared: {}, target: 'cloudflare', document: loaded.document, root: loaded.root });
    route.compiledPolicies = Object.keys(policies).length ? policies : undefined;
    if (Object.keys(route.env).length || Object.keys(route.secrets).length) {
      refused.push(`${route.pattern}: env and secret bindings would have to be baked into the artifact`);
    }
  }
  assert(!refused.length, `This target serves declarative routes only:\n  ${refused.join('\n  ')}`);
  assert(routes.length, 'No routes to build');

  const ajv = new Ajv({ code:{ source:true, esm:true }, strict:false, allErrors:false });
  const validators = {}, serialised = [];
  for (const route of routes) {
    const parameters = [];
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
      ...(route.reply ? { reply:{ status:route.reply.status, headers:route.reply.headers, body:route.reply.body.toString('utf8') } } : {}),
      ...(route.enabled === false ? { enabled:false } : {}),
      ...(route.expiresAt ? { expiresAt:route.expiresAt } : {}),
      ...(route.compiledPolicies ? { policies:route.compiledPolicies } : {}) });
  }

  await mkdir(out, { recursive:true });
  await writeFile(join(out,'validators.js'), await linkRuntime(standaloneCode(ajv, validators)));
  await writeFile(join(out,'artifact.js'),
    `// Generated by urlcode build. Do not edit; rebuild instead.\nexport default ${JSON.stringify({ format:FORMAT, version:loaded.version, routes:serialised },null,2)};\n`);
  await writeFile(join(out,'index.js'), `// Generated by urlcode build. Do not edit; rebuild instead.
import { createFetchHandler } from 'urlcode/cloudflare';
import artifact from './artifact.js';
import * as validators from './validators.js';

export default { fetch: createFetchHandler(artifact, validators) };
`);
  return { out, format:FORMAT, version:loaded.version, routes:serialised.length,
    validators:Object.keys(validators).length };
}
