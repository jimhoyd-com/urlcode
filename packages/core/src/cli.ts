#!/usr/bin/env node
import { getCapabilities, formatCapabilities } from './capabilities.ts';
import { getCapability, formatCapability } from './capability-query.ts';
import { getSchemaFragment } from './schema-query.ts';
import { stringify as stringifyYaml } from 'yaml';
import { parseArgs } from 'node:util';
import { auditProject, benchmarkProject } from './readiness.ts';
import type { ComplianceOptions } from './readiness.ts';
import { createRuntime } from './runtime.ts';
import { loadOperatorHost } from './operator-host.ts';
import type { OperatorHost } from './operator-host.ts';
import { startServer } from './server.ts';
import type { ServerOptions } from './server.ts';
import {scaffoldProject} from './scaffold.ts';
import { initProject, addRedirect } from './authoring.ts';
import { initSiteWith, parseWithNames } from './init-with.ts';
import { validateDeclaredExtensions } from './addon-install.ts';
import { planUpgrade, upgradeSite } from './upgrade.ts';
import { runProjectTests, startRestartable } from './project-tests.ts';
import { verifyDeployment, failLevels } from './verify-deployment.ts';
import type { FailOn } from './verify-deployment.ts';
import { loadOperatorPolicy, prepareFunctionSnapshot, requestedPermissions, type OperatorPolicy } from './policy.ts';
import { loadDocument, safeFile } from './config.ts';
import { describeExtensions, planFeature, reviewProject } from './tooling.ts';
import type { ExtensionInspection } from './tooling.ts';
import { ConfigError, HttpError, errorFields, revisionPinHint } from './errors.ts';
import { registry as policyRegistry } from './policies.ts';
import { loadComplianceRules, profileNames as complianceProfiles } from './compliance.ts';
import { parseRouteSnapshot, diffRoutes, renderRouteDiff } from './route-diff.ts';
import { access, readFile, realpath } from 'node:fs/promises';
import { runAddonCommand } from './extensions-cli.ts';
import { createJsonLogger, createDevEventFormatter } from './logging.ts';
import { commandOptions as options, aliasOriginCommands, hostFileCommands, policyCommands } from './cli-command-metadata.ts';
import type { CliValues as Values } from './cli-command-metadata.ts';
import { addressInUseMessage, argumentError, systemErrorMessages } from './cli-errors.ts';

// Stamped by scripts/release-bump.ts alongside every other runtime version declaration (mcp.ts's serverInfo,
// the starter's schema pin and CI action); `release-bump.ts --check` asserts this literal, not a read of
// package.json, equals the core version, so keep it a plain string literal here.
const VERSION = '0.6.1';
async function defaultProject(): Promise<string> {
  const has = (path: string): Promise<boolean> => access(path).then(() => true, () => false);
  return !(await has('urlcode.yaml')) && await has('app/urlcode.yaml') ? 'app' : '.';
}
interface HelpEntry { name: string; group: string; text: string }
const helpGroups = ['Start','Author','Check','Deploy','Extensions','Agent tooling'] as const;
const helpEntries: HelpEntry[] = [
  { name:'init', group:'Start', text:
`  urlcode init <directory> [--with ui,auth,admin [--example]] [--ack extension:id]
    # Writes one site: app/ (the route project: urlcode.yaml), host.mjs (the operator host), package.json (exact runtime pin and npm scripts), AGENTS.md, .mcp.json, a Makefile and CI. Add routes and request fixtures deliberately after asking the local MCP for task-scoped context.
    # init works in place in a directory holding only package.json, package-lock.json, node_modules or .git; an existing package.json keeps every key and gains only a missing runtime pin and missing scripts
    # --with: then runs \`urlcode extensions add\` for those extensions (npm install of the add-on tarballs this runtime pins); a refusal undoes the whole init
    # --example: with --with, also writes each extension's example (a Todo collection and screen, a contact form, a signed-in page); without it only the capabilities are installed
    # --ack: repeatable, qualified acknowledgement of a risk an extension names when it refuses (for example store:public-write); do not pass it pre-emptively, the refusal prints the exact command
` },
  { name:'dev', group:'Start', text:
`  urlcode dev [--project directory] [--port 3000] [--host 127.0.0.1] [--origin https://links.example] [--alias-origin https://www.links.example]… [--policy /absolute/policy.mjs] [--host-file /absolute/operator/host.mjs]
    capacity/logging/policies/health/shutdown/timeouts: same flags as \`serve\`, see \`urlcode serve --help\`
    # stderr names the route, source file and stack of a failing function (the response stays a generic 502) and why a reload was rejected
    # loads .env.local and watches the project; on a TTY, prints readable startup and request lines instead of JSON (--json forces JSON; piped stdout always uses JSON)
` },
  { name:'validate', group:'Start', text:
`  urlcode validate [--project directory] [--local] [--origin https://links.example] [--alias-origin https://www.links.example]… [--policy /absolute/policy.mjs] [--host-file /absolute/operator/host.mjs]  # origin: absolute URLs in site.* files
` },
  { name:'test', group:'Start', text:
`  urlcode test [--project directory] [--origin https://links.example] [--alias-origin https://www.links.example]… [--verbose] [--policy /absolute/policy.mjs] [--host-file /absolute/operator/host.mjs]
    # quiet by default: prints failing cases and the summary; --verbose adds every request log
` },
  { name:'scaffold', group:'Author', text:
`  urlcode scaffold [--project directory] [--dry-run]
` },
  { name:'add', group:'Author', text:
`  urlcode add <destination-url> [--alias short-code] [--project directory]
` },
  { name:'routes', group:'Author', text:
`  urlcode routes [--project directory] [--origin https://links.example] [--alias-origin https://www.links.example]… [--policy /absolute/policy.mjs] [--host-file /absolute/operator/host.mjs]
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
    origins:  [--alias-origin https://www.links.example]…  # repeatable, at most 16: other https: origins (or loopback http:) the site is also served from; extensions' same-origin checks admit them, generated links keep --origin
    # --port defaults to the PORT environment variable, then 3000, so a container/PaaS can set the listen port without changing the command
    # on a loopback --host (the default), a request whose Host is not localhost, 127.0.0.1 or [::1] on the bound port, or the --origin or an --alias-origin authority, gets 421 before routing (DNS-rebinding defence; dev too)
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
`  urlcode extensions available [--json]
  urlcode extensions add <name> [<name>…] [--example] [--ack extension:id] [--site directory]
  urlcode extensions remove <name> [--site directory]
  urlcode extensions list [--strict] [--json] [--site directory]
  urlcode extensions [--project directory] [--host-file operator/host.mjs] [--json]  # without a subcommand: registered contracts and schemas; executes trusted host code, activates nothing
    # extensions are executable add-ons released with this runtime and pinned by it (URL and sha512 in its addons.json); add installs each once with npm --ignore-scripts, checks the lock against the pin, writes its app/urlcode.yaml block, app/routes/<name>.yaml, operator files and host.mjs line
    # add installs the capability only (no sample endpoints); --example also writes each added extension's example, for example store's /api/todos collection or forms' /contact flow
    # remove refuses while another extension requires it or the project still uses it; data/ and operator files are never deleted
    # list --strict exits 1 on a pin mismatch, a nested copy or drift between package.json, app/urlcode.yaml and host.mjs; an extension neither declared nor imported is a library install, still pin-checked, not drift
` },
  { name:'upgrade', group:'Extensions', text:
`  urlcode upgrade [--check] [--to X.Y.Z] [--site directory] [--json]
    # moves the runtime and every installed extension and artifact to one version together: the latest stable release (npm's latest dist-tag) unless --to names another, including a prerelease or an older version
    # installs core first, then the add-ons its own addons.json pins; validates the project with the new runtime; moves the site's workflow to the same action release; any failure restores package.json, package-lock.json and the workflows
    # --check: report the current and target versions and change nothing
` },
  { name:'artifacts', group:'Extensions', text:
`  urlcode artifacts available [--json]
  urlcode artifacts add <name> [<name>…] [--site directory]
  urlcode artifacts remove <name> [--site directory]
  urlcode artifacts list [--strict] [--json] [--site directory]
    # artifacts are inert data add-ons (JSON schemas, example configuration) with the same shape, release and pinning as extensions; they never execute and are never wired into host.mjs
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
  urlcode mcp print-config [project] [--global]  # prints the .mcp.json JSON for a client to register BEFORE running init (pre-session bootstrap, #542); write it into an empty directory before starting an agent session there so MCP tools are loaded on that session's first turn. --global emits the bare 'urlcode' command for a global install; default is the portable 'npx --no --package' form. 'urlcode init' keeps a .mcp.json written this way as-is
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
  { name:'fixtures', group:'Agent tooling', text:
`  urlcode fixtures suggest [--project directory] [--json]
    # tests/requests.json candidates only for routes urlcode.yaml alone determines (redirect, respond, page/download, 405, 404, simple input refusals); function, middleware, proxy, extension, include, pattern and binding routes are listed as gaps, never as covered. Reads urlcode.yaml only; writes nothing
` },
  { name:'diff', group:'Agent tooling', text:
`  urlcode diff <before.yaml> [after.yaml] [--project directory] [--json]  # after defaults to the project's urlcode.yaml
    # route, capability, trusted/sandboxed code seam and newly requested operator grant changes between two YAML documents, by name only (no values); always exits 0
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
async function complianceOptions(values: Values & { project: string }): Promise<ComplianceOptions | undefined> {
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
let verifiedPolicy: OperatorPolicy | undefined;
let serving = false;
try {
  const { values: parsed, positionals } = parseArgs({ allowPositionals:true, options });
  // A site keeps its route project in app/: from the site directory, commands default to it.
  const values = { ...parsed, project: parsed.project ?? await defaultProject() };
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
      if (command !== 'mcp' && command !== 'context') {
        // A verified --policy pins the host to its reviewed revision, so no PROJECT_SHA256 bridge is needed (#723).
        // Only the revision reaches the host; the grants stay with core.
        if (values.policy !== undefined && (policyCommands as readonly string[]).includes(command)) verifiedPolicy = await loadOperatorPolicy(values.policy, values.project);
        operatorHost = await loadOperatorHost(values['host-file'], values.project, { revision: verifiedPolicy?.projectSha256 });
        if (verifiedPolicy && operatorHost.extensions?.length) {
          const actual = (await prepareFunctionSnapshot(await loadDocument(values.project))).projectSha256;
          if (verifiedPolicy.projectSha256 !== actual) throw new ConfigError(`The extension host is pinned by --policy${revisionPinHint(verifiedPolicy.projectSha256, actual)}`, { code: 'revision-pin-mismatch' });
        }
      }
    }
    if (values.with !== undefined && command !== 'init') throw new ConfigError('--with is only supported by init');
    if (values.ack !== undefined && !(command === 'init' && values.with !== undefined) && !(command === 'extensions' && arg === 'add')) throw new ConfigError('--ack is only supported by init --with and extensions add');
    if (values.example !== undefined && !(command === 'init' && values.with !== undefined) && !(command === 'extensions' && arg === 'add')) throw new ConfigError('--example is only supported by init --with and extensions add');
    if (values['allow-authoring'] && command !== 'mcp') throw new ConfigError('--allow-authoring is only supported by mcp');
    if (values['debug-errors'] && command !== 'serve') throw new ConfigError('--debug-errors is only supported by serve; dev always reports function and reload errors');
    if (values.strict && !['extensions', 'artifacts'].includes(command)) throw new ConfigError('--strict is only supported by extensions and artifacts list');
    if (values.site !== undefined && !['extensions', 'artifacts', 'upgrade'].includes(command)) throw new ConfigError('--site is only supported by extensions, artifacts and upgrade');
    if ((values.to !== undefined || values.check) && command !== 'upgrade') throw new ConfigError('--to and --check are only supported by upgrade');
    if (values['alias-origin'] !== undefined && !(aliasOriginCommands as readonly string[]).includes(command)) throw new ConfigError(`--alias-origin is only supported by ${aliasOriginCommands.join('/')}`);
    const hostOptions = { extensions: operatorHost.extensions, plugins: operatorHost.plugins };
    if ((!['import','recipes','recipe','examples','example','docs','bulk-import','artifacts','extensions','mcp','diff'].includes(command) && extra.length) || (!['init','add','import','recipes','recipe','examples','example','docs','bulk-import','explain','capabilities','schema','plan-feature','artifacts','extensions','mcp','fixtures','diff'].includes(command) && arg)) throw new ConfigError('Unexpected positional arguments');

    if(command==='artifacts'||(command==='extensions'&&arg!==undefined)){
      if(command==='artifacts'&&arg===undefined)throw new ConfigError('Use urlcode artifacts available|add|remove|list');
      const code=await runAddonCommand(command,arg!,extra,values,print);
      if(code!==undefined)process.exitCode=code;
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
    }else if(command==='fixtures'||command==='diff'){
      // Both read YAML text only: no include, source file, binding or operator policy is read, and nothing executes.
      const projectYaml=async()=>readFile(await safeFile(await realpath(values.project),'urlcode.yaml'),'utf8');
      let result: unknown;
      if(command==='fixtures'){
        if(arg!=='suggest')throw new ConfigError('Use urlcode fixtures suggest [--project directory] [--json]');
        const {suggestFixtures}=await import('./fixture-suggestions.ts');
        result=suggestFixtures(await projectYaml());
      }else{
        if(arg===undefined||extra.length>1)throw new ConfigError('Use urlcode diff <before.yaml> [after.yaml] [--project directory] [--json]');
        const {summarizeYamlChange}=await import('./yaml-change.ts');
        result=summarizeYamlChange(await readFile(arg,'utf8'),extra[0]===undefined?await projectYaml():await readFile(extra[0],'utf8'));
      }
      print(values.json?result:stringifyYaml(result,{lineWidth:0,aliasDuplicateObjects:false}));
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
      const permissions = verifiedPolicy ?? await loadOperatorPolicy(values.policy,values.project);
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
          const serverOptions={...hostOptions,project:values.project,port:0,local:true,permissions,origin:values.origin,aliasOrigins:values['alias-origin'],log:()=>{}};
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
          if (!arg) throw new ConfigError('Provide a new site directory');
          if (values.with === undefined) {
            const created = await initProject(arg);
            const nextSteps = [`cd ${arg}`, 'npm install', 'npm run dev'];
            if (human) print(`Created ${created}\nNext steps:\n${nextSteps.map(step => `  ${step}`).join('\n')}\n`);
            else print({ event:'created', path:created, nextSteps });
            break;
          }
          const created = await initSiteWith(arg, parseWithNames(values.with), { acknowledgements: values.ack ?? [], example: values.example ?? false });
          const review = `Review ${created.site}/app and pin its revision explicitly: projectSha256 ${created.projectSha256} in the reviewed --policy file, or PROJECT_SHA256=${created.projectSha256}; re-review after any project change`;
          if (human) print([`Created ${created.site} with ${created.added.join(', ')}`, ...Object.entries(created.env).map(([key, text]) => `Environment: ${key}: ${text}`), ...created.notes.map(note => `Next: ${note}`), review].join('\n') + '\n');
          else print({ event:'created', ...created, review });
          break;
        }
        case 'upgrade': {
          const site = values.site ?? '.';
          if (values.check) {
            const plan = await planUpgrade(site, { to: values.to });
            print(values.json || !human ? plan : plan.upToDate ? `Up to date: ${plan.current}\n` : `${plan.current} -> ${plan.target} (core${plan.addons.length ? `, ${plan.addons.join(', ')}` : ''})\nRun urlcode upgrade${values.to ? ` --to ${values.to}` : ''} to apply it.\n`);
            break;
          }
          const result = await upgradeSite(site, { to: values.to });
          print(values.json || !human ? { event: 'upgraded', ...result } : result.upgraded
            ? [`Upgraded ${result.current} -> ${result.target} (core${result.addons.length ? `, ${result.addons.join(', ')}` : ''}).`, ...result.workflows.map(file => `Moved ${file} to action v${result.target}.`), `Project revision: ${result.projectSha256}. Update the reviewed policy's projectSha256 (or PROJECT_SHA256) if it changed, and restart.`].join('\n') + '\n'
            : `Up to date: ${result.current}\n`);
          break;
        }
        case 'validate': {
          const declared = Object.keys((await loadDocument(values.project)).document.extensions ?? {});
          if (values['host-file'] === undefined && declared.length) {
            // Without the operator host, declared extensions are checked against their installed schemas; no extension code runs.
            const problems = await validateDeclaredExtensions(values.project);
            if (problems.length) throw new ConfigError(`Extension configuration does not match the installed schemas:\n${problems.map(problem => `  ${problem}`).join('\n')}`);
            print({ event:'valid', static:true, extensions:declared, note:'Checked against installed extension schemas; pass --host-file to activate them and validate the whole runtime' }); break;
          }
          const runtime = await createRuntime(values.project, { ...hostOptions, local:values.local, permissions, origin:values.origin, aliasOrigins:values['alias-origin'] });
          print({ event:'valid', routes:runtime.count, version:runtime.version }); await runtime.close(); break;
        }
        case 'add':
          if (!arg) throw new ConfigError('Provide an HTTP(S) destination URL');
          print({ event:'added', path:await addRedirect(values.project,arg,values.alias) }); break;
        case 'test': {
          const result = await runProjectTests(values.project, { ...hostOptions, log:values.verbose ? print : (event:object) => { const { event:kind, pass } = event as {event?:string;pass?:boolean}; if ((kind === 'test' && pass === false) || kind === 'warning') print(event); }, permissions, origin:values.origin, aliasOrigins:values['alias-origin'] });
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
            local:command === 'dev', watch:command === 'dev', debugErrors:command === 'dev' || values['debug-errors'] === true, origin:values.origin, aliasOrigins:values['alias-origin'], permissions,
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
  const parsed = code !== undefined && error instanceof Error ? argumentError(code, error.message, Object.keys(options)) : undefined;
  const message = parsed?.message ?? (code === 'EADDRINUSE' ? addressInUseMessage(error) : (error instanceof ConfigError || error instanceof HttpError) ? error.message : ((code !== undefined ? systemErrorMessages[code] : undefined) || 'Operation failed; check project files, module dependencies and command options'));
  const details = parsed?.details ?? (error instanceof ConfigError ? errorFields(error.details) : {});
  process.stderr.write(JSON.stringify({ event:'error', message, ...details }) + '\n'); process.exitCode = 1;
} finally {
  if (!serving) {
    try { await operatorHost.close?.(); } catch { process.stderr.write('Operator host cleanup failed\n'); process.exitCode = 1; }
  }
}
