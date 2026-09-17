#!/usr/bin/env node
import { auditProject, benchmarkProject } from './readiness.js';
import { parseArgs } from 'node:util';
import { createRuntime } from './runtime.js';
import { startServer } from './server.js';
import {scaffoldProject} from './scaffold.js';
import { initProject, addRedirect } from './authoring.js';
import { runProjectTests } from './project-tests.js';
import { loadOperatorPolicy, prepareFunctionSnapshot, requestedPermissions } from './policy.js';
import { loadDocument } from './config.js';
import {parseLinkBinding,runLinkCommand,linkPoolOptions} from './link-cli.js';
import { ConfigError, HttpError } from './errors.js';
import {supportsConcurrentWal} from './sqlite-version.js';
import { registry as policyRegistry } from './policies.js';

const usage = `URLCode 0.1.0 — local/self-hosted runtime
  urlcode init <directory>
  urlcode scaffold [--project directory] [--dry-run]
  urlcode validate [--project directory] [--local]
  urlcode dev [--project directory] [--port 3000] [--host 127.0.0.1]
  urlcode serve [--project directory] [--port 3000] [--host 127.0.0.1] [--origin https://links.example]
    capacity: [--workers 2] [--function-timeout-ms 5000] [--max-response-bytes 1048576]
              [--max-body-bytes 1048576] [--max-in-flight 64] [--max-in-flight-health 16]
    logging:  [--request-log minimal|detailed] [--trust-request-id]
    policies: [--trusted-proxies 10.0.0.0/8,fd00::/8]  # peers allowed to set X-Forwarded-For for client policies
  urlcode add <destination-url> [--alias short-code] [--project directory]
  urlcode test [--project directory]
  urlcode build --target cloudflare [--project directory] [--out dist/cloudflare]
  urlcode routes [--project directory]
  urlcode audit [--project directory] [--expect-routes 2]
  urlcode benchmark [--project directory] [--requests 1000] [--concurrency 2] [--seconds 30] [--max-p95-ms 50]
    [--warmup 50] [--target https://links.example]  # target measures a running deployment, not a local snapshot
  urlcode permissions [--project directory]  # inspect requested bindings; grants nothing
  urlcode links init|create|get|list|update|delete|export|import|api --store /absolute/links.sqlite [--collection links]
    create/update: --destination https://example.com [--code abc] [--status 302] [--enabled true] [--expires UTC]
    update/delete: --code abc --if-version N (update replaces all mutable fields)
    export: consistent NDJSON snapshot to stdout [--collection links] [--page-size 100]
    import: --input /absolute/export.ndjson restores into empty collections (versions are reassigned)
    api: --auth-file /operator/management.json (or legacy --token-file /operator/token) --port 3001 (separate authenticated server)
  urlcode doctor
  serve/dev/validate/test/routes/audit/benchmark: --link-store links=/absolute/links.sqlite
  Store pool controls: --link-readers 2 (1–8), --link-read-limit 32, --link-write-limit 32 (1–32 each)
Dev loads .env.local and watches; serve does neither. Functions run in WASM isolation; external bindings require --policy outside the project.
`;
const print = value => process.stdout.write(typeof value === 'string' ? value : JSON.stringify(value) + '\n');
// Deployment controls the container/CLI must be able to set; the embedding JS
// API is not reachable from `urlcode serve`.
const capacityFlags = [['workers','workers'],['function-timeout-ms','timeoutMs'],['max-response-bytes','maxBytes'],
  ['max-body-bytes','maxBodyBytes'],['max-in-flight','maxInFlightRequests'],['max-in-flight-health','maxInFlightHealthRequests']];
function serverCapacity(values) {
  const options = {};
  for (const [flag,key] of capacityFlags) {
    if (values[flag] === undefined) continue;
    if (!/^\d{1,9}$/.test(values[flag])) throw new ConfigError(`Invalid --${flag}`);
    options[key] = Number(values[flag]);
  }
  if (values['request-log'] !== undefined) {
    if (!['minimal','detailed'].includes(values['request-log'])) throw new ConfigError('Use --request-log minimal or detailed');
    options.requestLog = values['request-log'];
  }
  if (values['trust-request-id']) options.trustRequestId = true;
  if (values['trusted-proxies'] !== undefined) options.trustedProxies = values['trusted-proxies'];
  return options;
}
try {
  const { values, positionals } = parseArgs({ allowPositionals:true, options: {
    project:{ type:'string', default:'.' },
    port:{ type:'string' }, host:{ type:'string', default:'127.0.0.1' },
    'expect-routes':{type:'string'}, requests:{type:'string'}, concurrency:{type:'string'}, seconds:{type:'string'}, 'max-p95-ms':{type:'string'}, warmup:{type:'string'}, target:{type:'string'},
    'link-readers':{type:'string'}, 'link-read-limit':{type:'string'}, 'link-write-limit':{type:'string'},
    workers:{type:'string'}, 'function-timeout-ms':{type:'string'}, 'max-response-bytes':{type:'string'}, 'max-body-bytes':{type:'string'},
    'max-in-flight':{type:'string'}, 'max-in-flight-health':{type:'string'}, 'request-log':{type:'string'}, 'trust-request-id':{type:'boolean'}, 'trusted-proxies':{type:'string'},
    'link-store':{type:'string'}, store:{type:'string'}, collection:{type:'string'}, code:{type:'string'}, destination:{type:'string'}, status:{type:'string'}, enabled:{type:'string'}, expires:{type:'string'}, 'if-version':{type:'string'}, limit:{type:'string'}, after:{type:'string'}, 'token-file':{type:'string'}, 'auth-file':{type:'string'}, input:{type:'string'}, 'page-size':{type:'string'},
    out:{type:'string'}, 'dry-run':{type:'boolean'}, policy:{ type:'string' }, origin:{ type:'string' }, alias:{ type:'string' }, local:{ type:'boolean' }, help:{ type:'boolean', short:'h' },
  } });
  const [command, arg, ...extra] = positionals;
  values.port ??= command==='links' && arg==='api' ? '3001' : '3000';
  if (values.help || !command) print(usage);
  else {
    if (extra.length || (!['init','add','links'].includes(command) && arg)) throw new ConfigError('Unexpected positional arguments');
    if(command==='links'){await runLinkCommand(arg,values,print);}else{
      const permissions = await loadOperatorPolicy(values.policy,values.project);
      const linkStore=parseLinkBinding(values['link-store'],linkPoolOptions(values));
      switch (command) {
        case 'routes': case 'audit': case 'benchmark': {
          const number = (key,fallback) => {
            if(values[key]===undefined)return fallback;
            if(!/^\d+(?:\.\d+)?$/.test(values[key]) || !Number.isFinite(Number(values[key])))throw new ConfigError('Invalid numeric option');
            return Number(values[key]);
          };
          const expected=number('expect-routes');
          if(expected!==undefined && !Number.isSafeInteger(expected))throw new ConfigError('Expected route count must be an integer');
          const started=performance.now();
          const app=await startServer({project:values.project,port:0,local:true,permissions,linkStore,log:()=>{}});
          const startupMs=performance.now()-started;
          try {
            if(command==='routes') {
              const plan=app.testPlan(); print({routes:plan.inventory.length,dynamicLinks:plan.dynamicLinks,inventory:plan.inventory,policies:plan.policies});
            } else if(command==='audit') {
              const report=await auditProject(app,{expectRoutes:expected,log:print});print(report);if(!report.ready)process.exitCode=1;
            } else {
              const report=await benchmarkProject(app,{requests:number('requests',1000),concurrency:number('concurrency',2),seconds:number('seconds',30),maxP95Ms:number('max-p95-ms'),warmup:number('warmup',0),target:values.target});
              // Local startup time is meaningless when the load went elsewhere.
              print(values.target?report:{...report,startupMs});if(!report.pass)process.exitCode=1;
            }
          } finally {await app.close();}
          break;
        }
        case 'build': {
          if (values.target !== 'cloudflare') throw new ConfigError('Use --target cloudflare');
          const { buildCloudflare } = await import('./build-cloudflare.js');
          print({ event:'built', ...await buildCloudflare(values.project,{ out:values.out }) }); break;
        }
        case 'scaffold':
          print(await scaffoldProject(values.project,{dryRun:values['dry-run']}));break;
        case 'permissions': {
          const loaded = await loadDocument(values.project);
          print(requestedPermissions(loaded,await prepareFunctionSnapshot(loaded))); break;
        }
        case 'init':
          if (!arg) throw new ConfigError('Provide a new project directory');
          await initProject(arg); print({ event:'created' }); break;
        case 'validate': {
          const runtime = await createRuntime(values.project, { local:values.local, permissions, linkStore });
          print({ event:'valid', dynamicLinks:runtime.testPlan().dynamicLinks, routes:runtime.count, version:runtime.version }); await runtime.close(); break;
        }
        case 'add':
          if (!arg) throw new ConfigError('Provide an HTTP(S) destination URL');
          print({ event:'added', path:await addRedirect(values.project,arg,values.alias) }); break;
        case 'test': {
          const result = await runProjectTests(values.project, { log:print, permissions, linkStore });
          print(result); if (result.failed) process.exitCode = 1; break;
        }
        case 'doctor':
          print({ node:process.version, sqlite:process.versions.sqlite, liveLinks:supportsConcurrentWal(process.versions.sqlite), platform:process.platform, architecture:process.arch, runtime:'node-process', functionSandbox:'quickjs-wasm', network:false, filesystem:false, providers:[], policies:Object.keys(policyRegistry), license:'Apache-2.0' }); break;
        case 'dev': case 'serve': {
          const port = Number(values.port);
          if (!/^\d+$/.test(values.port) || !Number.isInteger(port) || port < 0 || port > 65535) throw new ConfigError('Invalid port');
          if (command === 'serve' && values.local) throw new ConfigError('serve never reads local dotenv files');
          const app = await startServer({ project:values.project, host:values.host, port,
            local:command === 'dev', watch:command === 'dev', origin:values.origin, permissions, linkStore,
            ...serverCapacity(values) });
          print({ event:'listening', address:app.address.address, port:app.address.port, mode:command, origin:app.origin });
          let stopping = false;
          const stop = async () => { if (stopping) return; stopping = true; await app.close(); };
          process.once('SIGINT',stop); process.once('SIGTERM',stop);
          break;
        }
        default: throw new ConfigError('Unknown command; use --help');
      }
    }
  }
} catch (error) {
  const message = (error instanceof ConfigError || error instanceof HttpError) ? error.message : ({ ERR_PARSE_ARGS_UNKNOWN_OPTION:'Unknown option; use --help', EEXIST:'Destination or edit lock already exists', ENOENT:'Required file or directory not found', EADDRINUSE:'Port is already in use', EACCES:'Permission denied' }[error.code] || 'Operation failed; check project files, module dependencies and command options');
  process.stderr.write(JSON.stringify({ event:'error', message }) + '\n'); process.exitCode = 1;
}
