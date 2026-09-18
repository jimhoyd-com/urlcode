#!/usr/bin/env node
import { getCapabilities, formatCapabilities } from './capabilities.ts';
import { auditProject, benchmarkProject } from './readiness.ts';
import type { ComplianceOptions } from './readiness.ts';
import { parseArgs } from 'node:util';
import { createRuntime } from './runtime.ts';
import { loadOperatorHost } from './operator-host.ts';
import type { OperatorHost } from './operator-host.ts';
import { startServer } from './server.ts';
import type { ServerOptions } from './server.ts';
import {scaffoldProject} from './scaffold.ts';
import { initProject, addRedirect } from './authoring.ts';
import { initProjectWith, parseWithNames } from './init-with.ts';
import { runProjectTests } from './project-tests.ts';
import { verifyDeployment, failLevels } from './verify-deployment.ts';
import type { FailOn } from './verify-deployment.ts';
import { loadOperatorPolicy, prepareFunctionSnapshot, requestedPermissions } from './policy.ts';
import { loadDocument } from './config.ts';
import {parseLinkBinding,runLinkCommand,linkPoolOptions} from './link-cli.ts';
import { ConfigError, HttpError } from './errors.ts';
import {supportsConcurrentWal} from './sqlite-version.ts';
import { registry as policyRegistry } from './policies.ts';
import { loadComplianceRules, profileNames as complianceProfiles } from './compliance.ts';
import { parseRouteSnapshot, diffRoutes, renderRouteDiff } from './route-diff.ts';
import { readFile } from 'node:fs/promises';

const usage = `URLCode 0.3.0 — local/self-hosted runtime
  urlcode init <directory> [--with auth,admin]  # --with: layered site from installed @jimhoyd/urlcode-<name> packages
  urlcode scaffold [--project directory] [--dry-run]
  urlcode validate [--project directory] [--local] [--origin https://links.example]  # origin: absolute URLs in site.* files
  urlcode dev [--project directory] [--port 3000] [--host 127.0.0.1]
  urlcode serve [--project directory] [--port 3000] [--host 127.0.0.1] [--origin https://links.example]
    capacity: [--workers 2] [--function-timeout-ms 5000] [--max-response-bytes 1048576]
              [--max-body-bytes 1048576] [--max-in-flight 64] [--max-in-flight-health 16]
    logging:  [--request-log minimal|detailed] [--trust-request-id] [--metrics]  # metrics: GET /_urlcode/metrics, Prometheus text; keep internal
    policies: [--trusted-proxies 10.0.0.0/8,fd00::/8]  # peers allowed to set X-Forwarded-For for client policies
  urlcode add <destination-url> [--alias short-code] [--project directory]
  urlcode test [--project directory] [--origin https://links.example]
  urlcode build --target cloudflare [--project directory] [--out dist/cloudflare] [--origin https://links.example]
  urlcode routes [--project directory] [--origin https://links.example]
    diff: [--compare previous-routes.json] [--format json|markdown]  # added/removed/changed routes against an earlier report; always exits 0
  urlcode audit [--project directory] [--expect-routes 2]
    compliance: [--compliance baseline|strict|privacy|none] [--compliance-rules /absolute/rules.mjs] [--compliance-ignore id,id]
                [--compliance-warn] [--origin https://links.example] [--request-log minimal|detailed]  # declare the deployment under review
  urlcode benchmark [--project directory] [--requests 1000] [--concurrency 2] [--seconds 30] [--max-p95-ms 50]
    [--warmup 50] [--target https://links.example]  # target measures a running deployment, not a local snapshot
  urlcode verify-deployment --target https://links.example [--project directory] [--origin https://links.example]
    [--expect-routes 2] [--expect-metrics] [--timeout-ms 10000] [--fail-on high|medium|low|info|none]
    [--compliance baseline|strict|privacy|none] [--compliance-rules ...] [--compliance-ignore id,id] [--compliance-warn]
    # compares the running deployment's responses with what this project declares; never follows redirects, no --insecure
  urlcode permissions [--project directory]  # inspect requested bindings and egress origins; grants nothing
  urlcode links init|create|get|list|update|delete|export|import|api --store /absolute/links.sqlite [--collection links]
    create/update: --destination https://example.com [--code abc] [--status 302] [--enabled true] [--expires UTC]
    update/delete: --code abc --if-version N (update replaces all mutable fields)
    export: consistent NDJSON snapshot to stdout [--collection links] [--page-size 100]
    import: --input /absolute/export.ndjson restores into empty collections (versions are reassigned)
    api: --auth-file /operator/management.json (or legacy --token-file /operator/token) --port 3001 (separate authenticated server)
  urlcode import [netlify|cloudflare|vercel|netlify-toml] <file> [--format csv|json|yaml] [--out new-file] [--dry-run] [--report json]
  urlcode export --target netlify|cloudflare|vercel|netlify-toml|csv|json|yaml [--project directory] [--out new-file] [--report json]
    conversion: [--accept-provider-differences]  # explicit non-lossless migration candidate; exact behavior requires runtime
  urlcode recipes [list|show <name>|add <name> --out new-directory] [--dry-run]
  urlcode build-typescript [--project directory] --out new-directory [--dry-run]
  urlcode bulk-import csv|json|yaml <file> --out new-directory [--dry-run]
  urlcode verify-provider --target self-hosted|aws|vercel|cloudflare --origin https://owned-fixture.example
    [--timeout-ms 3000] [--release label] [--git-commit sha]  # explicitly invokes synthetic deployment probes
  urlcode mcp [--project directory] [--allow-authoring]  # bounded stdio tooling; the flag adds project-confined authoring tools
  urlcode capabilities [--target self-hosted|cloudflare|aws|vercel] [--json]
  urlcode doctor
  serve/dev/validate/test/routes/audit/benchmark: --host-file /absolute/operator/host.mjs (trusted code outside project)
  serve/dev/validate/test/routes/audit/benchmark: --link-store links=/absolute/links.sqlite
  Store pool controls: --link-readers 2 (1–8), --link-read-limit 32, --link-write-limit 32 (1–32 each)
Dev loads .env.local and watches; serve does neither. Functions run in WASM isolation; external bindings require --policy outside the project.
`;
const print = (value: unknown): boolean => process.stdout.write(typeof value === 'string' ? value : JSON.stringify(value) + '\n');
const options = {
  json:{ type:'boolean' }, report:{type:'string'}, 'accept-provider-differences':{type:'boolean'},
  project:{ type:'string', default:'.' }, 'host-file':{type:'string'}, with:{type:'string'},
  port:{ type:'string' }, host:{ type:'string', default:'127.0.0.1' },
  'expect-routes':{type:'string'}, requests:{type:'string'}, concurrency:{type:'string'}, seconds:{type:'string'}, 'max-p95-ms':{type:'string'}, warmup:{type:'string'}, target:{type:'string'},
  'link-readers':{type:'string'}, 'link-read-limit':{type:'string'}, 'link-write-limit':{type:'string'},
  workers:{type:'string'}, 'function-timeout-ms':{type:'string'}, 'max-response-bytes':{type:'string'}, 'max-body-bytes':{type:'string'},
  'max-in-flight':{type:'string'}, 'max-in-flight-health':{type:'string'}, 'request-log':{type:'string'}, 'trust-request-id':{type:'boolean'}, 'trusted-proxies':{type:'string'}, metrics:{type:'boolean'},
  'link-store':{type:'string'}, store:{type:'string'}, collection:{type:'string'}, code:{type:'string'}, destination:{type:'string'}, status:{type:'string'}, enabled:{type:'string'}, expires:{type:'string'}, 'if-version':{type:'string'}, limit:{type:'string'}, after:{type:'string'}, 'token-file':{type:'string'}, 'auth-file':{type:'string'}, input:{type:'string'}, 'page-size':{type:'string'},
  release:{type:'string'}, 'git-commit':{type:'string'}, 'timeout-ms':{type:'string'}, 'fail-on':{type:'string'}, 'expect-metrics':{type:'boolean'},
  out:{type:'string'}, 'dry-run':{type:'boolean'}, compare:{type:'string'}, format:{type:'string'}, compliance:{type:'string'}, 'compliance-rules':{type:'string'}, 'compliance-ignore':{type:'string'}, 'compliance-warn':{type:'boolean'}, policy:{ type:'string' }, origin:{ type:'string' }, alias:{ type:'string' }, local:{ type:'boolean' }, 'allow-authoring':{ type:'boolean' }, help:{ type:'boolean', short:'h' },
} as const;
type Values = ReturnType<typeof parseArgs<{ options: typeof options; allowPositionals: true }>>['values'];
type ServerCapacity = Pick<ServerOptions, 'workers' | 'timeoutMs' | 'maxBytes' | 'maxBodyBytes' | 'maxInFlightRequests' | 'maxInFlightHealthRequests' | 'requestLog' | 'trustRequestId' | 'metrics' | 'trustedProxies'>;
// Deployment controls the container/CLI must be able to set; the embedding JS
// API is not reachable from `urlcode serve`.
const capacityFlags = [['workers','workers'],['function-timeout-ms','timeoutMs'],['max-response-bytes','maxBytes'],
  ['max-body-bytes','maxBodyBytes'],['max-in-flight','maxInFlightRequests'],['max-in-flight-health','maxInFlightHealthRequests']] as const;
function serverCapacity(values: Values): ServerCapacity {
  const options: ServerCapacity = {};
  for (const [flag,key] of capacityFlags) {
    const value = values[flag];
    if (value === undefined) continue;
    if (!/^\d{1,9}$/.test(value)) throw new ConfigError(`Invalid --${flag}`);
    options[key] = Number(value);
  }
  if (values['request-log'] !== undefined) {
    if (!['minimal','detailed'].includes(values['request-log'])) throw new ConfigError('Use --request-log minimal or detailed');
    options.requestLog = values['request-log'];
  }
  if (values['trust-request-id']) options.trustRequestId = true;
  if (values.metrics) options.metrics = true;
  if (values['trusted-proxies'] !== undefined) options.trustedProxies = values['trusted-proxies'];
  return options;
}
// Compliance flags for `audit`. Operator rules load like the binding policy:
// from an absolute path outside the project, as trusted host code. The origin
// and log level describe the deployment under review, not this audit process.
async function complianceOptions(values: Values): Promise<ComplianceOptions | undefined> {
  const flags=['compliance','compliance-rules','compliance-ignore','compliance-warn'] as const;
  if(flags.every(flag=>values[flag]===undefined))return undefined;
  const profile=values.compliance ?? 'baseline';
  if(!complianceProfiles.includes(profile))throw new ConfigError(`Use --compliance ${complianceProfiles.join('|')}`);
  const ignore=(values['compliance-ignore'] ?? '').split(',').map(id=>id.trim()).filter(Boolean);
  const operator=await loadComplianceRules(values['compliance-rules'],values.project);
  const host={requestLog:values['request-log'] ?? 'minimal',linkEvents:false};
  if(!['minimal','detailed'].includes(host.requestLog))throw new ConfigError('Use --request-log minimal or detailed');
  return {profile,ignore,origin:values.origin,host,rules:operator?.rules ?? [],disable:operator?.disable ?? [],override:operator?.override ?? {}};
}
const errorMessages: Record<string, string | undefined> = { ERR_PARSE_ARGS_UNKNOWN_OPTION:'Unknown option; use --help', EEXIST:'Destination or edit lock already exists', ENOENT:'Required file or directory not found', EADDRINUSE:'Port is already in use', EACCES:'Permission denied' };
let operatorHost: OperatorHost = {};
let serving = false;
try {
  const { values, positionals } = parseArgs({ allowPositionals:true, options });
  const [command, arg, ...extra] = positionals;
  values.port ??= command==='links' && arg==='api' ? '3001' : '3000';
  if (values.help || !command) print(usage);
  else {
    if (values['host-file'] !== undefined) {
      if (!['serve','dev','validate','test','routes','audit','benchmark'].includes(command)) throw new ConfigError('--host-file is only supported by serve/dev/validate/test/routes/audit/benchmark');
      operatorHost = await loadOperatorHost(values['host-file'], values.project);
    }
    if (values.with !== undefined && command !== 'init') throw new ConfigError('--with is only supported by init');
    if (values['allow-authoring'] && command !== 'mcp') throw new ConfigError('--allow-authoring is only supported by mcp');
    const hostOptions = { extensions: operatorHost.extensions, plugins: operatorHost.plugins };
    if ((!['import','recipes','recipe','bulk-import'].includes(command) && extra.length) || (!['init','add','links','import','recipes','recipe','bulk-import'].includes(command) && arg)) throw new ConfigError('Unexpected positional arguments');

    if(command==='import'||command==='export'){
      const { runInterchange } = await import('./interchange-cli.ts');
      const converted = await runInterchange(command,positionals.slice(1),{project:values.project,target:values.target,format:values.format,out:values.out,report:values.report,dryRun:values['dry-run'],acceptProviderDifferences:values['accept-provider-differences']});
      print(converted.text); if(!converted.report.ok)process.exitCode=1;
    }else if(['recipes','recipe','build-typescript','bulk-import','verify-provider','mcp'].includes(command)){
      const {runEcosystemCommand}=await import('./ecosystem-cli.ts');
      await runEcosystemCommand(command,positionals.slice(1),values,print);
    }else if(command==='capabilities'){
      const catalog = getCapabilities(values.target);
      print(values.json ? catalog : formatCapabilities(catalog));
    }else if(command==='links'){await runLinkCommand(arg,values,print);}else{
      const permissions = await loadOperatorPolicy(values.policy,values.project);
      const linkStore=parseLinkBinding(values['link-store'],linkPoolOptions(values));
      switch (command) {
        case 'routes': case 'audit': case 'benchmark': {
          const number = (key: 'expect-routes' | 'requests' | 'concurrency' | 'seconds' | 'max-p95-ms' | 'warmup',fallback?: number): number | undefined => {
            const value = values[key];
            if(value===undefined)return fallback;
            if(!/^\d+(?:\.\d+)?$/.test(value) || !Number.isFinite(Number(value)))throw new ConfigError('Invalid numeric option');
            return Number(value);
          };
          const expected=number('expect-routes');
          if(expected!==undefined && !Number.isSafeInteger(expected))throw new ConfigError('Expected route count must be an integer');
          const compliance=command==='audit'?await complianceOptions(values):undefined;
          const format=values.format ?? 'json';
          if(!['json','markdown'].includes(format))throw new ConfigError('Use --format json or markdown');
          if(values.format!==undefined && values.compare===undefined)throw new ConfigError('--format applies to routes --compare');
          const started=performance.now();
          const app=await startServer({...hostOptions,project:values.project,port:0,local:true,permissions,linkStore,origin:values.origin,log:()=>{}});
          const startupMs=performance.now()-started;
          try {
            if(command==='routes') {
              const plan=app.testPlan();
              if(values.compare===undefined) print({routes:plan.inventory.length,dynamicLinks:plan.dynamicLinks,inventory:plan.inventory,policies:plan.policies});
              else {
                // The diff reports; it never judges, so the exit code stays 0.
                const before=parseRouteSnapshot(JSON.parse(await readFile(values.compare,'utf8'))); // file boundary: an earlier `routes` report
                const diff=diffRoutes(before,{inventory:plan.inventory,policies:plan.policies});
                print(format==='markdown'?renderRouteDiff(diff):diff);
              }
            } else if(command==='audit') {
              const report=await auditProject(app,{expectRoutes:expected,log:print,compliance});print(report);if(!report.ready)process.exitCode=1;
              if(report.compliance && !report.compliance.pass && !values['compliance-warn'])process.exitCode=1;
            } else {
              const report=await benchmarkProject(app,{requests:number('requests',1000),concurrency:number('concurrency',2),seconds:number('seconds',30),maxP95Ms:number('max-p95-ms'),warmup:number('warmup',0),target:values.target});
              // Local startup time is meaningless when the load went elsewhere.
              print(values.target?report:{...report,startupMs});if(!report.pass)process.exitCode=1;
            }
          } finally {await app.close();}
          break;
        }
        case 'verify-deployment': {
          if (!values.target) throw new ConfigError('Provide --target https://host');
          const integer = (key: 'expect-routes' | 'timeout-ms'): number | undefined => {
            const value = values[key];
            if (value === undefined) return undefined;
            if (!/^\d{1,9}$/.test(value)) throw new ConfigError(`Invalid --${key}`);
            return Number(value);
          };
          const failOn = values['fail-on'] ?? 'high';
          const isFailOn = (value: string): value is FailOn => (failLevels as readonly string[]).includes(value);
          if (!isFailOn(failOn)) throw new ConfigError(`Use --fail-on ${failLevels.join('|')}`);
          const report = await verifyDeployment(values.project, { target: values.target, origin: values.origin, expectRoutes: integer('expect-routes'), timeoutMs: integer('timeout-ms'),
            expectMetrics: values['expect-metrics'], failOn, compliance: await complianceOptions(values), complianceWarn: values['compliance-warn'], permissions, linkStore, log: print });
          print(report); if (!report.pass) process.exitCode = 1; break;
        }
        case 'verify-provider': {
          const target=values.target;
          if(target!=='self-hosted'&&target!=='aws'&&target!=='vercel'&&target!=='cloudflare')throw new ConfigError('Provide --target self-hosted|aws|vercel|cloudflare');
          if(!values.origin)throw new ConfigError('Provide --origin https://owned-fixture.example');
          if(values['timeout-ms']!==undefined&&!/^\d{1,5}$/.test(values['timeout-ms']))throw new ConfigError('Invalid --timeout-ms');
          const {verifyProviderDeployment}=await import('./provider-verification.ts');
          const report=await verifyProviderDeployment(target,values.origin,{
            ...(values['timeout-ms']===undefined?{}:{timeoutMs:Number(values['timeout-ms'])}),
            ...(values.release===undefined?{}:{release:values.release}),
            ...(values['git-commit']===undefined?{}:{gitCommit:values['git-commit']}),
          });
          print(report);if(!report.pass)process.exitCode=1;break;
        }
        case 'build': {
          if (values.target !== 'cloudflare') throw new ConfigError('Use --target cloudflare');
          const { buildCloudflare } = await import('./build-cloudflare.ts');
          print({ event:'built', ...await buildCloudflare(values.project,{ out:values.out, origin:values.origin }) }); break;
        }
        case 'scaffold':
          print(await scaffoldProject(values.project,{dryRun:values['dry-run']}));break;
        case 'permissions': {
          const loaded = await loadDocument(values.project);
          print(requestedPermissions(loaded,await prepareFunctionSnapshot(loaded))); break;
        }
        case 'init':
          if (!arg) throw new ConfigError('Provide a new project directory');
          if (values.with === undefined) { await initProject(arg); print({ event:'created' }); break; }
          {
            const created = await initProjectWith(arg, parseWithNames(values.with));
            print({ event:'created', ...created, review:`Review ${created.project}/urlcode.yaml and pin its revision explicitly (for example PROJECT_SHA256=${created.projectSha256}); re-review after any project change` });
          }
          break;
        case 'validate': {
          const runtime = await createRuntime(values.project, { ...hostOptions, local:values.local, permissions, linkStore, origin:values.origin });
          print({ event:'valid', dynamicLinks:runtime.testPlan().dynamicLinks, routes:runtime.count, version:runtime.version }); await runtime.close(); break;
        }
        case 'add':
          if (!arg) throw new ConfigError('Provide an HTTP(S) destination URL');
          print({ event:'added', path:await addRedirect(values.project,arg,values.alias) }); break;
        case 'test': {
          const result = await runProjectTests(values.project, { ...hostOptions, log:print, permissions, linkStore, origin:values.origin });
          print(result); if (result.failed) process.exitCode = 1; break;
        }
        case 'doctor':
          print({ node:process.version, sqlite:process.versions.sqlite, liveLinks:supportsConcurrentWal(process.versions.sqlite), platform:process.platform, architecture:process.arch, runtime:'node-process', functionSandbox:'quickjs-wasm', network:false, filesystem:false, guestNetwork:false, hostEgress:'revision-pinned-origin-grants', tooling:['recipes','bulk-import','build-typescript','mcp','verify-provider'], providers:[], capabilityTargets:getCapabilities().targets, policies:Object.keys(policyRegistry), license:'Apache-2.0' }); break;
        case 'dev': case 'serve': {
          const port = Number(values.port);
          if (!/^\d+$/.test(values.port) || !Number.isInteger(port) || port < 0 || port > 65535) throw new ConfigError('Invalid port');
          if (command === 'serve' && values.local) throw new ConfigError('serve never reads local dotenv files');
          const app = await startServer({ ...hostOptions, project:values.project, host:values.host, port,
            local:command === 'dev', watch:command === 'dev', origin:values.origin, permissions, linkStore,
            ...serverCapacity(values) });
          print({ event:'listening', address:app.address.address, port:app.address.port, mode:command, origin:app.origin });
          serving = true;
          let stopping = false;
          const stop = async () => { if (stopping) return; stopping = true; try { await app.close(); } finally { await operatorHost.close?.(); } };
          process.once('SIGINT',stop); process.once('SIGTERM',stop);
          break;
        }
        default: throw new ConfigError('Unknown command; use --help');
      }
    }
  }
} catch (error) {
  const code = typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string' ? error.code : undefined;
  const message = (error instanceof ConfigError || error instanceof HttpError) ? error.message : ((code !== undefined ? errorMessages[code] : undefined) || 'Operation failed; check project files, module dependencies and command options');
  process.stderr.write(JSON.stringify({ event:'error', message }) + '\n'); process.exitCode = 1;
} finally {
  if (!serving) {
    try { await operatorHost.close?.(); } catch { process.stderr.write('Operator host cleanup failed\n'); process.exitCode = 1; }
  }
}
