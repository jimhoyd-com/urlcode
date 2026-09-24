#!/usr/bin/env node
import { getCapabilities, formatCapabilities } from './capabilities.ts';
import { getCapability, formatCapability } from './capability-query.ts';
import { getSchemaFragment } from './schema-query.ts';
import { stringify as stringifyYaml } from 'yaml';
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
import { collectDependencySet, installSteps, parsePin } from './project-dependencies.ts';
import { runProjectTests, startRestartable } from './project-tests.ts';
import { verifyDeployment, failLevels } from './verify-deployment.ts';
import type { FailOn } from './verify-deployment.ts';
import { loadOperatorPolicy, prepareFunctionSnapshot, requestedPermissions } from './policy.ts';
import { closestKey, loadDocument } from './config.ts';
import { describeExtensions, planFeature, reviewProject } from './tooling.ts';
import type { ExtensionInspection } from './tooling.ts';
import { ConfigError, HttpError, errorFields } from './errors.ts';
import type { ErrorDetails } from './errors.ts';
import { registry as policyRegistry } from './policies.ts';
import { loadComplianceRules, profileNames as complianceProfiles } from './compliance.ts';
import { parseRouteSnapshot, diffRoutes, renderRouteDiff } from './route-diff.ts';
import { readFile } from 'node:fs/promises';
import { installArtifact, inspectArtifacts } from './extension-artifacts.ts';
import { installBundle, readBundleLock, BUNDLE_CATALOG_NAMES } from './extension-bundles.ts';
import { createJsonLogger, createDevEventFormatter } from './logging.ts';

// Stamped by scripts/release-prepare.ts alongside every other runtime version declaration (mcp.ts's serverInfo,
// the starter's schema pin and CI action); release:check asserts this literal, not a read of package.json, still
// equals the core version, so keep it a plain string literal here.
const VERSION = '0.5.9';
// Commands that load trusted host code outside the project (registers extensions/plugins), and commands that read an
// operator binding policy outside the project (`permissions` below); both footnotes and `--help` group text share
// these lists so they cannot drift from the validation at the top of the parse below.
const hostFileCommands = ['serve','dev','validate','test','routes','audit','benchmark','explain','context','plan-feature','review','extensions','mcp'] as const;
const policyCommands = ['dev','serve','validate','test','routes','audit','benchmark','verify-deployment'] as const;
interface HelpEntry { name: string; group: string; text: string }
const helpGroups = ['Start','Author','Check','Deploy','Extensions','Agent tooling'] as const;
const helpEntries: HelpEntry[] = [
  { name:'init', group:'Start', text:
`  urlcode init <directory> [--with ui,auth,admin] [--bundle-release extension-bundles@vX.Y.Z] [--ack extension:id] [--manifest|--no-manifest] [--pin @scope/pkg=specifier]
    # Writes one bare project scaffold (urlcode.yaml, AGENTS.md, .mcp.json and project CI). Add routes and request fixtures deliberately after asking the local MCP for task-scoped context.
    # init works in place in a directory holding only package.json, package-lock.json, node_modules or .git; an existing package.json is preserved (one that depends on @jimhoyd/urlcode only gains missing npm scripts), any other existing file is refused
    # --with: layered site from signed first-party extension bundles, verified and cached under .urlcode/extension-bundles, with a core-only package.json and a bundle lockfile; no npm extension dependency is written. --bundle-release is optional: it defaults to extension-bundles@v<this core version>; pass an older immutable tag to pin one. --with is an unordered set, core orders the host from each extension's declared requirements and refuses a missing requirement, conflict or cycle before writing
    # --ack: repeatable, qualified acknowledgement of a risk an extension names when it refuses (for example store:public-write); do not pass it pre-emptively, the refusal prints the exact command. Rejected when no scaffold consumes it
    # --manifest: also write a package.json pinning the runtime, with npm scripts, for a route-only project; --no-manifest: --with without a package.json
    # --pin: record a local path or tarball instead of the registry version; repeatable. No install is ever run for you.
` },
  { name:'dev', group:'Start', text:
`  urlcode dev [--project directory] [--port 3000] [--host 127.0.0.1] [--policy /absolute/policy.mjs] [--host-file /absolute/operator/host.mjs]
    capacity/logging/policies/health/shutdown/timeouts: same flags as \`serve\`, see \`urlcode serve --help\`
    # stderr names the route, source file and stack of a failing function (the response stays a generic 502) and why a reload was rejected
    # loads .env.local and watches the project; on a TTY, prints readable startup and request lines instead of JSON (--json forces JSON; piped stdout always uses JSON)
` },
  { name:'validate', group:'Start', text:
`  urlcode validate [--project directory] [--local] [--origin https://links.example] [--policy /absolute/policy.mjs] [--host-file /absolute/operator/host.mjs]  # origin: absolute URLs in site.* files
` },
  { name:'test', group:'Start', text:
`  urlcode test [--project directory] [--origin https://links.example] [--verbose] [--policy /absolute/policy.mjs] [--host-file /absolute/operator/host.mjs]
    # quiet by default: prints failing cases and the summary; --verbose adds every request log
` },
  { name:'scaffold', group:'Author', text:
`  urlcode scaffold [--project directory] [--dry-run]
` },
  { name:'add', group:'Author', text:
`  urlcode add <destination-url> [--alias short-code] [--project directory]
` },
  { name:'routes', group:'Author', text:
`  urlcode routes [--project directory] [--origin https://links.example] [--policy /absolute/policy.mjs] [--host-file /absolute/operator/host.mjs]
    diff: [--compare previous-routes.json] [--format json|markdown]  # added/removed/changed routes against an earlier report; always exits 0
` },
  { name:'import', group:'Author', text:
`  urlcode import [netlify|cloudflare|vercel|netlify-toml] <file> [--format csv|json|yaml] [--out new-file] [--dry-run] [--report json]
` },
  { name:'export', group:'Author', text:
`  urlcode export --target netlify|cloudflare|vercel|netlify-toml|csv|json|yaml [--project directory] [--out new-file] [--report json]
    conversion: [--accept-provider-differences]  # explicit non-lossless migration candidate; exact behavior requires runtime
` },
  { name:'recipes', group:'Author', text:
`  urlcode recipes [list|search <text>|show <name>|add <name> --out new-directory] [--dry-run] [--json]
` },
  { name:'examples', group:'Author', text:
`  urlcode examples [list|search <text>] [--json]  # bundled runnable examples and the cookbook route index
` },
  { name:'bulk-import', group:'Author', text:
`  urlcode bulk-import csv|json|yaml <file> --out new-directory [--dry-run]
` },
  { name:'build-typescript', group:'Author', text:
`  urlcode build-typescript [--project directory] --out new-directory [--dry-run]
` },
  { name:'audit', group:'Check', text:
`  urlcode audit [--project directory] [--expect-routes 2] [--policy /absolute/policy.mjs] [--host-file /absolute/operator/host.mjs]
    compliance: [--compliance baseline|strict|privacy|none] [--compliance-rules /absolute/rules.mjs] [--compliance-ignore id,id]
                [--compliance-warn] [--origin https://links.example] [--request-log minimal|detailed]  # declare the deployment under review
    deployment: [--trusted-proxies 10.0.0.0/8] [--metrics]  # as passed to serve; drives deploymentAdvisories, never fails the audit
` },
  { name:'benchmark', group:'Check', text:
`  urlcode benchmark [--project directory] [--requests 1000] [--concurrency 2] [--seconds 30] [--max-p95-ms 50] [--policy /absolute/policy.mjs] [--host-file /absolute/operator/host.mjs]
    [--warmup 50] [--target https://links.example]  # target measures a running deployment, not a local snapshot
` },
  { name:'verify-deployment', group:'Check', text:
`  urlcode verify-deployment --target https://links.example [--project directory] [--origin https://links.example] [--policy /absolute/policy.mjs]
    [--expect-routes 2] [--expect-metrics] [--timeout-ms 10000] [--fail-on high|medium|low|info|none]
    [--compliance baseline|strict|privacy|none] [--compliance-rules ...] [--compliance-ignore id,id] [--compliance-warn]
    # compares the running deployment's responses with what this project declares; never follows redirects, no --insecure
` },
  { name:'verify-provider', group:'Check', text:
`  urlcode verify-provider --target self-hosted|aws|vercel|cloudflare --origin https://owned-fixture.example
    [--timeout-ms 3000] [--release label] [--git-commit sha]  # explicitly invokes synthetic deployment probes
` },
  { name:'permissions', group:'Check', text:
`  urlcode permissions [--project directory]  # inspect requested bindings and egress origins; grants nothing
` },
  { name:'doctor', group:'Check', text:
`  urlcode doctor  # node/platform facts, this runtime's version and its capability targets
` },
  { name:'serve', group:'Deploy', text:
`  urlcode serve [--project directory] [--port 3000] [--host 127.0.0.1] [--origin https://links.example] [--policy /absolute/policy.mjs] [--host-file /absolute/operator/host.mjs]
    # --port defaults to the PORT environment variable, then 3000, so a container/PaaS can set the listen port without changing the command
    capacity: [--workers 2] [--function-timeout-ms 5000] [--max-response-bytes 1048576]
              [--max-body-bytes 1048576] [--max-in-flight 64] [--max-in-flight-health 16]
    logging:  [--request-log minimal|detailed] [--trust-request-id] [--metrics]  # metrics: GET /_urlcode/metrics, Prometheus text; keep internal
              [--debug-errors]  # serve only: write dev's function-error and reload diagnostics (stacks, source paths) to stderr; responses stay generic
    policies: [--trusted-proxies 10.0.0.0/8,fd00::/8]  # peers allowed to set X-Forwarded-For for client policies
    health:   [--health-details]  # include version/route count on GET /_urlcode/health (default: only with --metrics); keep internal
    shutdown: [--drain-delay-ms 0] [--close-timeout-ms 10000]
              # drain-delay-ms: /_urlcode/ready reports unhealthy this long before the listener stops accepting connections, for a load balancer to notice
              # close-timeout-ms: in-flight connections get this long to finish once accepting stops, then are forced closed; keep below the process supervisor's stop grace period (Docker --stop-timeout, Kubernetes terminationGracePeriodSeconds)
    timeouts: [--headers-timeout-ms 10000] [--request-timeout-ms 15000] [--keep-alive-timeout-ms 5000]
    # serve never reads local dotenv files; on a TTY, prints a readable startup line instead of JSON (--json forces JSON; piped stdout always uses JSON)
` },
  { name:'build', group:'Deploy', text:
`  urlcode build --target cloudflare|static [--project directory] [--out dist/cloudflare|dist/static] [--origin https://links.example]
    # static: redirect/respond/page/static/download only, compiled for S3 + CloudFront; no server, see docs/STATIC.md
` },
  { name:'extensions', group:'Extensions', text:
`  urlcode extensions [--project directory] [--host-file /absolute/operator/host.mjs] [--json]  # registered contracts and schemas; executes trusted host code, activates nothing
` },
  { name:'extension-artifacts', group:'Extensions', text:
`  urlcode extension-artifacts install <name> --artifact-release extensions@vX.Y.Z [--project directory]
  urlcode extension-artifacts update <name> --artifact-release extensions@vX.Y.Z [--project directory]
  urlcode extension-artifacts inspect [--project directory] [--json]
    # signed, data-only extension bundles cached under .urlcode/extensions; they never execute or replace --host-file
` },
  { name:'extension-bundles', group:'Extensions', text:
`  urlcode extension-bundles install <name> --bundle-release extension-bundles@vX.Y.Z [--project directory]
  urlcode extension-bundles inspect [--project directory] [--json]
  urlcode extension-bundles list [--json]
    # signed executable first-party bundles cached under .urlcode/extension-bundles; installation is explicit and host code loads them
    # list: the first-party bundle names this core version's release builds, from a static list baked in at release (no network call); the live signed catalog for a specific --bundle-release is still authoritative for install/init --with
` },
  { name:'explain', group:'Agent tooling', text:
`  urlcode explain [/route] [--project directory] [--target self-hosted|cloudflare|aws|vercel|static] [--host-file ...] [--json]
    # effective methods, handler, middleware, inputs, policies, cache outcome, bindings and target support from the compiled configuration
` },
  { name:'manifest', group:'Agent tooling', text:
`  urlcode manifest [--project directory] [--json]  # generated semantic manifest; build writes the same file as manifest.json
` },
  { name:'docs', group:'Agent tooling', text:
`  urlcode docs search <text> [--json]  # same as MCP search_docs: at most three bounded excerpts from the packaged agent docs, instead of grepping llms-full.txt
` },
  { name:'mcp', group:'Agent tooling', text:
`  urlcode mcp [--project directory] [--allow-authoring] [--host-file ...]  # bounded stdio tooling; --allow-authoring adds project-confined authoring tools, host file adds get_extensions
` },
  { name:'capabilities', group:'Agent tooling', text:
`  urlcode capabilities [--target self-hosted|cloudflare|aws|vercel|static] [--json]
  urlcode capabilities <name> [--json]  # one catalog entry: schema fragment, constraints, grants, targets, bundled uses
` },
  { name:'schema', group:'Agent tooling', text:
`  urlcode schema <path> [--json|--yaml]  # schema fragment for route, redirect, policies.cache, site.sitemap, ...
` },
  { name:'context', group:'Agent tooling', text:
`  urlcode context [--project directory] [--target self-hosted|cloudflare|aws|vercel|static | --task redirects] [--budget 500] [--json] [--stats]
    # compact facts for an authoring agent from the compiled project; --task redirects: supported redirect shapes, gaps and this project's redirects in one bounded call; --stats compares estimated tokens with the docs
` },
  { name:'plan-feature', group:'Agent tooling', text:
`  urlcode plan-feature <goal> [--project directory] [--target self-hosted|cloudflare|aws|vercel|static] [--host-file ...] [--json]
    # bounded read-only feature plan from compiled facts, local catalogs, locked inert artifacts and registrations already loaded from the operator host
` },
  { name:'review', group:'Agent tooling', text:
`  urlcode review [--project directory] [--target self-hosted|cloudflare|aws|vercel|static] [--host-file ...] [--json]
    # opt-in read-only static review for avoidable plumbing; host file registrations sharpen extension-alternative findings (registered/revision-pinned), never required
` },
];
const helpFooter = `${hostFileCommands.join('/')}: --host-file /absolute/operator/host.mjs (trusted code outside project)
${policyCommands.join('/')}: --policy /absolute/policy.mjs (external bindings; outside the project)
Dev loads .env.local and watches; serve does neither. Functions run trusted and in-process by default; a route declaring sandbox: true runs in WASM isolation.
Run \`urlcode <command> --help\` for one command's usage, or \`urlcode --version\`/\`-v\` for the runtime version.
`;
/** Full grouped `--help`, or one command's usage plus the footer lines that apply to it, for `urlcode <cmd> --help`. */
function renderHelp(command?: string): string {
  if (command !== undefined) {
    const entries = helpEntries.filter(entry => entry.name === command);
    if (!entries.length) return `Unknown command ${command}; use --help for the full command list\n`;
    const footer = [
      hostFileCommands.includes(command as typeof hostFileCommands[number]) ? `--host-file /absolute/operator/host.mjs (trusted code outside project)` : undefined,
      policyCommands.includes(command as typeof policyCommands[number]) ? `--policy /absolute/policy.mjs (external bindings; outside the project)` : undefined,
    ].filter((line): line is string => line !== undefined);
    return entries.map(entry => entry.text).join('') + (footer.length ? footer.join('\n') + '\n' : '');
  }
  const body = helpGroups.map(group => {
    const entries = helpEntries.filter(entry => entry.group === group);
    return entries.length ? `\n${group}:\n${entries.map(entry => entry.text).join('')}` : '';
  }).join('');
  return `URLCode ${VERSION} — local/self-hosted runtime\n${body}\n${helpFooter}`;
}
const print = (value: unknown): boolean => process.stdout.write(typeof value === 'string' ? value : JSON.stringify(value) + '\n');
const options = {
  json:{ type:'boolean' }, yaml:{ type:'boolean' }, report:{type:'string'}, 'accept-provider-differences':{type:'boolean'},
  project:{ type:'string', default:'.' }, 'host-file':{type:'string'}, with:{type:'string'},
  manifest:{type:'boolean'}, 'no-manifest':{type:'boolean'}, pin:{type:'string', multiple:true}, ack:{type:'string', multiple:true},
  port:{ type:'string' }, host:{ type:'string', default:'127.0.0.1' },
  'expect-routes':{type:'string'}, requests:{type:'string'}, concurrency:{type:'string'}, seconds:{type:'string'}, 'max-p95-ms':{type:'string'}, warmup:{type:'string'}, target:{type:'string'},
  workers:{type:'string'}, 'function-timeout-ms':{type:'string'}, 'max-response-bytes':{type:'string'}, 'max-body-bytes':{type:'string'},
  'max-in-flight':{type:'string'}, 'max-in-flight-health':{type:'string'}, 'request-log':{type:'string'}, 'trust-request-id':{type:'boolean'}, 'trusted-proxies':{type:'string'}, metrics:{type:'boolean'},
  'health-details':{type:'boolean'}, 'close-timeout-ms':{type:'string'}, 'drain-delay-ms':{type:'string'},
  'headers-timeout-ms':{type:'string'}, 'request-timeout-ms':{type:'string'}, 'keep-alive-timeout-ms':{type:'string'},
  release:{type:'string'}, 'git-commit':{type:'string'}, 'timeout-ms':{type:'string'}, 'fail-on':{type:'string'}, 'expect-metrics':{type:'boolean'},
  budget:{type:'string'}, task:{type:'string'}, stats:{type:'boolean'}, out:{type:'string'}, 'dry-run':{type:'boolean'}, compare:{type:'string'}, format:{type:'string'}, compliance:{type:'string'}, 'compliance-rules':{type:'string'}, 'compliance-ignore':{type:'string'}, 'compliance-warn':{type:'boolean'}, policy:{ type:'string' }, origin:{ type:'string' }, alias:{ type:'string' }, local:{ type:'boolean' }, verbose:{ type:'boolean' }, 'allow-authoring':{ type:'boolean' }, 'debug-errors':{ type:'boolean' }, help:{ type:'boolean', short:'h' }, version:{ type:'boolean', short:'v' },
  'artifact-release':{type:'string'}, 'bundle-release':{type:'string'},
} as const;
type Values = ReturnType<typeof parseArgs<{ options: typeof options; allowPositionals: true }>>['values'];
type ServerCapacity = Pick<ServerOptions, 'workers' | 'timeoutMs' | 'maxBytes' | 'maxBodyBytes' | 'maxInFlightRequests' | 'maxInFlightHealthRequests' | 'requestLog' | 'trustRequestId' | 'metrics' | 'trustedProxies' | 'healthDetails' | 'closeTimeoutMs' | 'readinessDrainMs' | 'headersTimeoutMs' | 'requestTimeoutMs' | 'keepAliveTimeoutMs'>;
// Deployment controls the container/CLI must be able to set; the embedding JS
// API is not reachable from `urlcode serve`.
const capacityFlags = [['workers','workers'],['function-timeout-ms','timeoutMs'],['max-response-bytes','maxBytes'],
  ['max-body-bytes','maxBodyBytes'],['max-in-flight','maxInFlightRequests'],['max-in-flight-health','maxInFlightHealthRequests'],
  ['close-timeout-ms','closeTimeoutMs'],['drain-delay-ms','readinessDrainMs'],
  ['headers-timeout-ms','headersTimeoutMs'],['request-timeout-ms','requestTimeoutMs'],['keep-alive-timeout-ms','keepAliveTimeoutMs']] as const;
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
  if (values['health-details']) options.healthDetails = true;
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
  const host={requestLog:values['request-log'] ?? 'minimal'};
  if(!['minimal','detailed'].includes(host.requestLog))throw new ConfigError('Use --request-log minimal or detailed');
  return {profile,ignore,origin:values.origin,host,rules:operator?.rules ?? [],disable:operator?.disable ?? [],override:operator?.override ?? {}};
}
function formatBundleCatalogNames(): string {
  const lines = ['First-party extension bundle names (static, this core release):', ...BUNDLE_CATALOG_NAMES.map(item => `  ${item.name}: ${item.description}`),
    '', 'Install with: urlcode init <directory> --with name[,name] (auto-resolves extension-bundles@v<core>), or', 'urlcode extension-bundles install <name> --bundle-release extension-bundles@vX.Y.Z'];
  return lines.join('\n') + '\n';
}
function formatExtensions(report: ExtensionInspection): string {
  const lines = [`Project revision: ${report.projectSha256}`];
  for (const item of report.declared) lines.push(`Declared: ${item.name} (contract ${item.version}) ${item.registered ? 'registered' : report.hostLoaded ? 'NOT registered by the host file' : 'schemas need --host-file'}`, `  mounts: ${item.mounts.join(', ') || '(none)'}`, `  policy routes: ${item.policyRoutes.join(', ') || '(none)'}`);
  if (!report.declared.length) lines.push('Declared: (none)');
  for (const item of report.extensions) lines.push(`Registered: ${item.name} (contract ${item.version}; targets ${item.targets.join(', ') || '(none)'}; ${item.declared ? 'declared' : 'not declared'}; revision ${item.revisionPinned ? 'pinned' : 'NOT pinned'})`,
    `  mounts: ${item.mounts.join(', ') || '(none)'}`, `  policy routes: ${item.policyRoutes.join(', ') || '(none)'}`, `  credential headers: ${item.credentialHeaders.join(', ') || '(none)'}`,
    `  hooks: ${item.hooks.length ? item.hooks.map(hook => `${String((hook as {name?:unknown}).name)} (${String((hook as {kind?:unknown}).kind)})`).join(', ') : '(none)'}`,
    `  authoring: ${item.authoring ? JSON.stringify(item.authoring) : '(none)'}`,
    `  configuration schema: ${JSON.stringify(item.schema)}`, `  policy schema: ${item.policySchema ? JSON.stringify(item.policySchema) : '(none)'}`);
  lines.push(report.note);
  return lines.join('\n') + '\n';
}
// Name the bound host and port (from the error, never user text) and a next step. Values are validated, not echoed.
function addressInUseMessage(error: unknown): string {
  const { address,port } = error as { address?: unknown; port?: unknown };
  const where = typeof port === 'number' && Number.isInteger(port) && port > 0 && port < 65536 ? `Port ${port}${typeof address === 'string' && /^[0-9A-Fa-f:.]{2,45}$/.test(address) ? ` on ${address}` : ''}` : 'The port';
  return `${where} is already in use; pick another with --port N, or stop the process using it`;
}
/**
 * Names the option parseArgs rejected, taken from its message only when it is a plain option token (never other
 * argument text), with a did-you-mean against the options this CLI accepts.
 */
function argumentError(code: string, message: string): { message: string; details: ErrorDetails } | undefined {
  const option = /'(--?[A-Za-z0-9][A-Za-z0-9-]{0,40})(?: <value>)?'/.exec(message)?.[1];
  if (code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION') {
    if (!option) return { message:'Unknown option; use --help', details:{ code:'unknown-option' } };
    const close = closestKey(option.replace(/^-+/, ''), Object.keys(options));
    return { message:`Unknown option ${option}${close ? `; did you mean --${close}?` : ''} (use --help for the options)`, details:{ code:'unknown-option' } };
  }
  if (code === 'ERR_PARSE_ARGS_INVALID_OPTION_VALUE' && option) return { message:`Option ${option} needs a value, as in ${option} <value>; to pass an argument that starts with -, put it after a -- separator`, details:{ code:'missing-option-value' } };
  return undefined;
}
const errorMessages: Record<string, string | undefined> = { EEXIST:'Destination or edit lock already exists', ENOENT:'Required file or directory not found', EADDRINUSE:'Port is already in use', EACCES:'Permission denied' };
// An unhandled rejection anywhere in the process (this CLI's own code, a
// trusted project function, an observer) must not fail silently as a bare
// Node warning: log a structured event and exit non-zero so a supervisor
// notices and restarts.
process.on('unhandledRejection', reason => {
  const message = reason instanceof Error ? reason.message : String(reason);
  process.stderr.write(JSON.stringify({ event:'error', message:'Unhandled rejection: ' + message }) + '\n');
  process.exitCode = 1;
  process.exit(1);
});
let operatorHost: OperatorHost = {};
let serving = false;
try {
  const { values, positionals } = parseArgs({ allowPositionals:true, options });
  const [command, arg, ...extra] = positionals;
  // PORT follows the common container convention (Heroku/Cloud Run/Docker
  // `-e PORT=`) so an operator can change the listen port without editing the
  // image's CMD; --port still wins when given explicitly.
  values.port ??= process.env.PORT ?? '3000';
  // On a TTY, `dev`/`serve`/`init` print short readable lines instead of raw JSON events; `--json` always forces
  // JSON, and so does a piped/redirected stdout (an agent or script reading the output), matching every other
  // command's --json toggle (a no-op on a command that only ever streamed JSON, like `audit` or `test`).
  const human = process.stdout.isTTY === true && values.json !== true;
  if (values.version) print(`urlcode ${VERSION}\n`);
  else if (values.help || !command) print(renderHelp(values.help && command ? command : undefined));
  else {
    if (values['host-file'] !== undefined) {
      if (!(hostFileCommands as readonly string[]).includes(command)) throw new ConfigError(`--host-file is only supported by ${hostFileCommands.join('/')}`);
      // The MCP server and context command load and release the host themselves.
      if (command !== 'mcp' && command !== 'context') operatorHost = await loadOperatorHost(values['host-file'], values.project);
    }
    if (values.with !== undefined && command !== 'init') throw new ConfigError('--with is only supported by init');
    if ((values.manifest || values['no-manifest'] || values.pin !== undefined) && command !== 'init') throw new ConfigError('--manifest/--no-manifest/--pin are only supported by init');
    if (values.manifest && values['no-manifest']) throw new ConfigError('Use either --manifest or --no-manifest');
    if (values.ack !== undefined && (command !== 'init' || values.with === undefined)) throw new ConfigError('--ack is only supported by init with --with');
    if (values['allow-authoring'] && command !== 'mcp') throw new ConfigError('--allow-authoring is only supported by mcp');
    if (values['debug-errors'] && command !== 'serve') throw new ConfigError('--debug-errors is only supported by serve; dev always reports function and reload errors');
    if (values['artifact-release'] !== undefined && command !== 'extension-artifacts') throw new ConfigError('--artifact-release is only supported by extension-artifacts');
    if (values['bundle-release'] !== undefined && command !== 'extension-bundles' && command !== 'init') throw new ConfigError('--bundle-release is only supported by extension-bundles or init --with');
    if (values['bundle-release'] !== undefined && command === 'init' && values.with === undefined) throw new ConfigError('--bundle-release needs init --with');
    const hostOptions = { extensions: operatorHost.extensions, plugins: operatorHost.plugins };
    if ((!['import','recipes','recipe','examples','example','docs','bulk-import','extension-artifacts','extension-bundles'].includes(command) && extra.length) || (!['init','add','import','recipes','recipe','examples','example','docs','bulk-import','explain','capabilities','schema','plan-feature','extension-artifacts','extension-bundles'].includes(command) && arg)) throw new ConfigError('Unexpected positional arguments');

    if(command==='extension-artifacts'){
      const operation=arg;
      if(operation==='install'||operation==='update') { const artifact=extra[0]; if(!artifact || extra.length!==1) throw new ConfigError(`Use urlcode extension-artifacts ${operation} <name> --artifact-release extensions@vX.Y.Z`); if(!values['artifact-release']) throw new ConfigError('Use --artifact-release with an immutable extension release tag'); const lock=await installArtifact(values.project,values['artifact-release'],artifact); print(values.json?lock:{event:operation==='install'?'extension-artifact-installed':'extension-artifact-updated',name:artifact,lockfile:'urlcode.extensions.lock.json'}); }
      else if(operation==='inspect') { if(extra.length) throw new ConfigError('Use urlcode extension-artifacts inspect'); const report=await inspectArtifacts(values.project); print(values.json?report:{artifacts:report.lock.artifacts.map(item=>({...item,status:report.cached.includes(item.name)?'cached':report.invalid.includes(item.name)?'invalid':'missing'}))}); }
      else throw new ConfigError('Use extension-artifacts install, update or inspect');
    }else if(command==='extension-bundles'){
      if(arg==='install') { const bundle=extra[0]; if(!bundle || extra.length!==1) throw new ConfigError('Use urlcode extension-bundles install <name> --bundle-release extension-bundles@vX.Y.Z'); if(!values['bundle-release']) throw new ConfigError('Use --bundle-release with an immutable extension bundle release tag'); const lock=await installBundle(values.project,values['bundle-release'],bundle); print(values.json?lock:{event:'extension-bundle-installed',name:bundle,lockfile:'urlcode.extension-bundles.lock.json'}); }
      else if(arg==='inspect') { if(extra.length) throw new ConfigError('Use urlcode extension-bundles inspect'); const lock=await readBundleLock(values.project); print(values.json?lock:{bundles:lock.bundles.map(item=>({name:item.name,version:item.version,release:item.catalog.tag,coreVersion:item.coreVersion}))}); }
      else if(arg==='list') { if(extra.length) throw new ConfigError('Use urlcode extension-bundles list'); print(values.json?BUNDLE_CATALOG_NAMES:formatBundleCatalogNames()); }
      else throw new ConfigError('Use extension-bundles install, inspect or list');
    }else if(command==='import'||command==='export'){
      const { runInterchange } = await import('./interchange-cli.ts');
      const converted = await runInterchange(command,positionals.slice(1),{project:values.project,target:values.target,format:values.format,out:values.out,report:values.report,dryRun:values['dry-run'],acceptProviderDifferences:values['accept-provider-differences']});
      print(converted.text); if(!converted.report.ok)process.exitCode=1;
    }else if(['recipes','recipe','examples','example','docs','build-typescript','bulk-import','verify-provider','mcp'].includes(command)){
      const {runEcosystemCommand}=await import('./ecosystem-cli.ts');
      await runEcosystemCommand(command,positionals.slice(1),values,print);
    }else if(command==='explain'||command==='manifest'){
      const {runExplainCommand}=await import('./explain-cli.ts');
      const exitCode=await runExplainCommand(command,arg,{project:values.project,target:values.target,origin:values.origin,json:values.json,extensions:operatorHost.extensions},print);
      if(exitCode)process.exitCode=exitCode;
    }else if(command==='capabilities'){
      if(arg!==undefined){ if(values.target!==undefined)throw new ConfigError('--target applies to the full catalog, not one entry'); const entry=getCapability(arg); print(values.json ? entry : formatCapability(entry)); }
      else { const catalog = getCapabilities(values.target); print(values.json ? catalog : formatCapabilities(catalog)); }
    }else if(command==='schema'){
      if(arg===undefined)throw new ConfigError('Use urlcode schema <path>');
      const fragment=getSchemaFragment(arg);
      print(values.yaml ? stringifyYaml(fragment.schema) : JSON.stringify(fragment.schema,null,2)+'\n');
    }else if(command==='plan-feature'){
      if(arg===undefined)throw new ConfigError('Use urlcode plan-feature <goal>');
      const plan=await planFeature(values.project,arg,{...(values.target===undefined?{}:{target:values.target}),...(values['host-file']===undefined?{}:{extensions:operatorHost.extensions??[]})});
      print(values.json?plan:stringifyYaml(plan,{lineWidth:0,aliasDuplicateObjects:false}));
    }else if(command==='review'){
      const review=await reviewProject(values.project,{...(values.target===undefined?{}:{target:values.target}),...(values.origin===undefined?{}:{origin:values.origin}),...(operatorHost.extensions===undefined?{}:{extensions:operatorHost.extensions})});
      print(values.json?review:stringifyYaml(review,{lineWidth:0,aliasDuplicateObjects:false}));
    }else if(command==='context'){
      if (values.budget !== undefined && !/^\d{1,9}$/.test(values.budget)) throw new ConfigError('Invalid --budget');
      const { buildContext, buildTaskContext, renderContext, renderTaskContext, estimateTokens, documentationTokens } = await import('./context.ts');
      const budget = values.budget === undefined ? {} : { budget:Number(values.budget) };
      let text: string;
      if (values.task !== undefined) {
        if (values.target !== undefined) throw new ConfigError('--task cannot be combined with --target');
        const task = await buildTaskContext(values.project, values.task, { hostFile:values['host-file'], ...budget });
        text = values.json ? JSON.stringify(task) + '\n' : renderTaskContext(task);
      } else {
        const context = await buildContext(values.project, { target:values.target, hostFile:values['host-file'], ...budget });
        text = values.json ? JSON.stringify(context) + '\n' : renderContext(context);
      }
      print(text);
      // Estimates only (characters / 4); a tokenizer is not a dependency. Stats go to stderr so stdout stays parseable.
      if (values.stats) process.stderr.write(JSON.stringify({ event:'stats', estimate:'characters/4', documentationTokens:await documentationTokens(), contextTokens:estimateTokens(text) }) + '\n');
    }else{
      const permissions = await loadOperatorPolicy(values.policy,values.project);
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
          const serverOptions={...hostOptions,project:values.project,port:0,local:true,permissions,origin:values.origin,log:()=>{}};
          // Only audit replays fixtures, so only audit needs a server its restart steps can restart.
          const app=command==='audit'?await startRestartable(serverOptions):await startServer(serverOptions);
          const startupMs=performance.now()-started;
          try {
            if(command==='routes') {
              const plan=app.testPlan();
              if(values.compare===undefined) print({routes:plan.inventory.length,inventory:plan.inventory,policies:plan.policies});
              else {
                // The diff reports; it never judges, so the exit code stays 0.
                const before=parseRouteSnapshot(JSON.parse(await readFile(values.compare,'utf8'))); // file boundary: an earlier `routes` report
                const diff=diffRoutes(before,{inventory:plan.inventory,policies:plan.policies});
                print(format==='markdown'?renderRouteDiff(diff):diff);
              }
            } else if(command==='audit') {
              const report=await auditProject(app,{expectRoutes:expected,log:print,compliance,deployment:{trustedProxies:values['trusted-proxies'],metrics:values.metrics}});print(report);if(!report.ready)process.exitCode=1;
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
            expectMetrics: values['expect-metrics'], failOn, compliance: await complianceOptions(values), complianceWarn: values['compliance-warn'], permissions, log: print });
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
          if (values.target === 'static') {
            const { buildStatic } = await import('./build-static.ts');
            print({ event:'built', ...await buildStatic(values.project,{ out:values.out, origin:values.origin }) }); break;
          }
          if (values.target !== 'cloudflare') throw new ConfigError('Use --target cloudflare or static');
          const { buildCloudflare } = await import('./build-cloudflare.ts');
          print({ event:'built', ...await buildCloudflare(values.project,{ out:values.out, origin:values.origin }) }); break;
        }
        case 'scaffold':
          print(await scaffoldProject(values.project,{dryRun:values['dry-run']}));break;
        case 'extensions': {
          const report = await describeExtensions(values.project, values['host-file'] === undefined ? undefined : operatorHost.extensions ?? []);
          print(values.json ? report : formatExtensions(report)); break;
        }
        case 'permissions': {
          const loaded = await loadDocument(values.project);
          print(requestedPermissions(loaded,await prepareFunctionSnapshot(loaded))); break;
        }
        case 'init': {
          if (!arg) throw new ConfigError('Provide a new project directory');
          // Pins are opt-in for a route-only project (its runtime may be managed elsewhere) and the default for
          // --with, which has just resolved the very packages the generated site depends on.
          const wanted = values.with === undefined ? values.manifest === true : !values['no-manifest'];
          const pins = new Map((values.pin ?? []).map(parsePin));
          if (pins.size && !wanted) throw new ConfigError('--pin needs a manifest; drop --no-manifest or add --manifest');
          if (values.with === undefined) {
            const set = wanted ? await collectDependencySet([], [], { overrides: pins }) : undefined;
            const created = await initProject(arg, { manifest: set });
            const nextSteps = set ? installSteps(created, set) : [];
            if (human) print(`Created ${created}\n${nextSteps.length ? ['Next steps:', ...nextSteps.map(step => `  ${step}`)].join('\n') + '\n' : ''}`);
            else print(set ? { event:'created', path:created, dependencies:set.pins, nextSteps } : { event:'created', path:created });
            break;
          }
          const created = await initProjectWith(arg, parseWithNames(values.with), { manifest: wanted, pins, acknowledgements: values.ack ?? [], bundleRelease: values['bundle-release'] });
          const review = `Review ${created.project}/urlcode.yaml and pin its revision explicitly (for example PROJECT_SHA256=${created.projectSha256}); re-review after any project change`;
          if (human) print(`Created ${created.project}\n${review}\n`);
          else print({ event:'created', ...created, review });
          break;
        }
        case 'validate': {
          const runtime = await createRuntime(values.project, { ...hostOptions, local:values.local, permissions, origin:values.origin });
          print({ event:'valid', routes:runtime.count, version:runtime.version }); await runtime.close(); break;
        }
        case 'add':
          if (!arg) throw new ConfigError('Provide an HTTP(S) destination URL');
          print({ event:'added', path:await addRedirect(values.project,arg,values.alias) }); break;
        case 'test': {
          const result = await runProjectTests(values.project, { ...hostOptions, log:values.verbose ? print : (event:object) => { const { event:kind, pass } = event as {event?:string;pass?:boolean}; if ((kind === 'test' && pass === false) || kind === 'warning') print(event); }, permissions, origin:values.origin });
          print(result); if (result.failed) process.exitCode = 1; break;
        }
        case 'doctor':
          print({ version:VERSION, node:process.version, platform:process.platform, architecture:process.arch, runtime:'node-process', functionDefault:'trusted-in-process', sandboxEngine:'quickjs-wasm', trustedFilesystem:true, trustedNetwork:true, sandboxedFilesystem:false, sandboxedNetwork:false, hostEgress:'revision-pinned-origin-grants', tooling:['recipes','examples','docs','bulk-import','build-typescript','mcp','verify-provider'], providers:[], capabilityTargets:getCapabilities().targets, policies:Object.keys(policyRegistry), license:'Apache-2.0' }); break;
        case 'dev': case 'serve': {
          const port = Number(values.port);
          if (!/^\d+$/.test(values.port) || !Number.isInteger(port) || port < 0 || port > 65535) throw new ConfigError('Invalid port');
          if (command === 'serve' && values.local) throw new ConfigError('serve never reads local dotenv files');
          // The request/reload log otherwise defaults to `minimal`: only `detailed` carries the method and route a
          // human line needs, so human mode asks for it unless the operator picked a level explicitly.
          if (human && values['request-log'] === undefined) values['request-log'] = 'detailed';
          const routes = { count: 0 };
          const app = await startServer({ ...hostOptions, project:values.project, host:values.host, port,
            local:command === 'dev', watch:command === 'dev', debugErrors:command === 'dev' || values['debug-errors'] === true, origin:values.origin, permissions,
            ...(human ? { log:createJsonLogger(process.stdout, undefined, createDevEventFormatter(routes)) } : {}),
            ...serverCapacity(values) });
          routes.count = app.testPlan().inventory.length;
          if (human) print(`Listening on ${app.origin} — ${routes.count} route${routes.count === 1 ? '' : 's'} (${command})\n`);
          else print({ event:'listening', address:app.address.address, port:app.address.port, mode:command, origin:app.origin });
          serving = true;
          let stopping = false;
          const stop = async () => {
            if (stopping) return; stopping = true;
            try { await app.close(); }
            catch (error) {
              process.stderr.write(JSON.stringify({ event:'error', message:'Shutdown failed: ' + (error instanceof Error ? error.message : String(error)) }) + '\n');
              process.exitCode = 1;
            }
            finally { await operatorHost.close?.(); }
          };
          process.once('SIGINT',stop); process.once('SIGTERM',stop);
          break;
        }
        default: throw new ConfigError('Unknown command; use --help');
      }
    }
  }
} catch (error) {
  const code = typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string' ? error.code : undefined;
  const parsed = code !== undefined && error instanceof Error ? argumentError(code, error.message) : undefined;
  const message = parsed?.message ?? (code === 'EADDRINUSE' ? addressInUseMessage(error) : (error instanceof ConfigError || error instanceof HttpError) ? error.message : ((code !== undefined ? errorMessages[code] : undefined) || 'Operation failed; check project files, module dependencies and command options'));
  const details = parsed?.details ?? (error instanceof ConfigError ? errorFields(error.details) : {});
  process.stderr.write(JSON.stringify({ event:'error', message, ...details }) + '\n'); process.exitCode = 1;
} finally {
  if (!serving) {
    try { await operatorHost.close?.(); } catch { process.stderr.write('Operator host cleanup failed\n'); process.exitCode = 1; }
  }
}
