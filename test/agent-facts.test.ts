import test from 'node:test';import assert from 'node:assert/strict';
import {spawnAsync} from './helpers.ts';import {fileURLToPath} from 'node:url';
import {buildContext} from '../packages/core/src/context.ts';
import {getCapability} from '../packages/core/src/capability-query.ts';
import {getSchemaFragment} from '../packages/core/src/schema-query.ts';
import {mcpToolInventory} from '../packages/core/src/mcp.ts';
import {storeAuthoring} from '../packages/store/src/authoring.ts';
import {streamingTargets} from '../packages/core/src/extensions.ts';
import {mkdir,mkdtemp,rm,writeFile} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
const script=fileURLToPath(new URL('../scripts/check-agent-facts.ts',import.meta.url));
const starter=fileURLToPath(new URL('../starters/default/app/',import.meta.url));
const checkFacts=(...args:string[])=>spawnAsync(process.execPath,[script,...args],{encoding:'utf8',timeout:30000});
// The inventory is derived from the checkout and nothing here changes it, so every test reads one run of it.
let inventoryRun:ReturnType<typeof checkFacts>|undefined;
const inventoryOnce=()=>inventoryRun??=checkFacts('--inventory');
/** Scans `text` saved as `name` in its own directory, so the cases of one test run concurrently. */
async function scanner(t:import('node:test').TestContext,name:string):Promise<(text:string)=>ReturnType<typeof checkFacts>>{
 const dir=await mkdtemp(join(tmpdir(),'urlcode-agent-facts-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 let next=0;
 return async text=>{const own=join(dir,String(next++));await mkdir(own);const file=join(own,name);await writeFile(file,text);return checkFacts('--files',file);};
}

test('the agent-facts inventory is derived from the implementation and the prose agrees with it (#541)',async()=>{
 const inventory=await inventoryOnce();
 assert.equal(inventory.status,0,inventory.stderr);
 const facts=JSON.parse(inventory.stdout) as {extensionBundles:string[];kitAdopters:string[];scaffoldWithUnordered:boolean;mcpTools:{read:number;hostFile:number;authoring:number};storeShortLinks:boolean};
 assert.deepEqual(facts.mcpTools,{read:mcpToolInventory.read.length,hostFile:1,authoring:mcpToolInventory.authoring.length});
 assert.ok(facts.extensionBundles.includes('store'));
 assert.equal(facts.storeShortLinks,storeAuthoring.surfaces.some(surface=>surface.name==='shortLinks'));
 const check=await checkFacts();
 assert.equal(check.status,0,check.stderr);
});

test('the retired hosted AI token and hosted LLM-tool claims cannot reappear in agent-visible prose (#756)',async t=>{
 const inventory=await inventoryOnce();
 assert.equal(inventory.status,0,inventory.stderr);
 assert.deepEqual(JSON.parse(inventory.stdout).hostedAi,{endpoint:'https://urlcode.ai/mcp',authentication:'none',hostedModelTools:false,retiredCredentials:['URLCODE_AI_TOKEN']});
 const scan=await scanner(t,'SKILL.md');
 await Promise.all(([
  ['Send `Authorization: Bearer <URLCODE_AI_TOKEN>` to the server.\n','hostedAi.retiredCredentials'],
  ['[URLCode AI](https://urlcode.ai/) is a hosted service for shared skills and LLM tooling.\n','hostedAi.hostedModelTools'],
  ['Keep the URLCode AI bearer token in the client secret facility.\n','hostedAi.authentication'],
 ] as const).map(async([text,fact])=>{
  const result=await scan(text);
  assert.equal(result.status,1,`${fact} should reject: ${text}`);
  assert.ok(result.stderr.includes(`[${fact}`),result.stderr);
 }));
 // The shipped wording, and bearer tokens that belong to the auth extension, stay clean.
 const clean=await scan('[URLCode AI](https://urlcode.ai/) is an optional hosted service for version-pinned reference and shared skills; its anonymous remote MCP runs no model of its own.\n\nThe auth extension checks a bearer token on `/api/*`.\n');
 assert.equal(clean.status,0,clean.stderr);
});

test('prose cannot say that test or audit fixtures deliver a route signal (#793, #917)',async t=>{
 const inventory=await inventoryOnce();
 assert.equal(inventory.status,0,inventory.stderr);
 assert.equal(JSON.parse(inventory.stdout).signalsSkipOnlyHeadAndProbes,true);
 assert.equal(JSON.parse(inventory.stdout).signalsRecordedInTests,true);
 const scan=await scanner(t,'README.md');
 await Promise.all([
  'A signal carries a fixed payload. A fixture that reaches this route calls the granted destination exactly as a visitor would.\n',
  '`urlcode test` fixtures deliver the signal to the webhook.\n',
  'Egress is granted per origin; audit requests reach the destination, so run them against a receiver you control.\n',
 ].map(async text=>{
  const result=await scan(text);
  assert.equal(result.status,1,`should reject: ${text}`);
  assert.ok(result.stderr.includes('[signalsRecordedInTests]'),result.stderr);
 }));
 const clean=await scan('HEAD requests and the runtime\'s own health and readiness probes do not emit signals. `urlcode test` and `urlcode audit` record signals instead of delivering them, so the tests never call the hook.\n\nNo test or authoring inspection needs network access.\n');
 assert.equal(clean.status,0,clean.stderr);
});

test('MCP tool counts in prose follow run_tests into the --allow-authoring set (#590)',async t=>{
 // run_tests executes project code, so it left the read tools for the authoring-gated set.
 assert.equal(mcpToolInventory.read.includes('run_tests'),false);assert.equal(mcpToolInventory.authoring.includes('run_tests'),true);
 const scan=await scanner(t,'TOOLS.md');
 const stale=await scan('`urlcode mcp --allow-authoring --project DIR` adds six tools to the thirty-six read tools above.\n');
 assert.equal(stale.status,1,stale.stderr);assert.match(stale.stderr,/counts (?:36 read|6 authoring) tools/);
 const current=await scan(`\`urlcode mcp --allow-authoring --project DIR\` adds ${mcpToolInventory.authoring.length} tools to the ${mcpToolInventory.read.length} read tools above.\n`);
 assert.equal(current.status,0,current.stderr);
});
test('get_context, capabilities and the schema state the real wildcard rule (#585)',async()=>{
 const {constraints}=await buildContext(starter,{});
 const pathShape=constraints.pathShape as {note:string},mounts=constraints.wildcardMounts as {note:string};
 for(const note of [pathShape.note,mounts.note]){assert.match(note,/`\/\*\*`/);assert.match(note,/static/);assert.match(note,/`\/\*`/);}
 assert.match(pathShape.note,/No greedy captures or general-purpose wildcards anywhere else/);
 assert.ok(getCapability('static').constraints.some(line=>/must end in a terminal `\/\*`/.test(line)));
 assert.ok(getCapability('redirect').constraints.some(line=>/may end in `\/\*\*`/.test(line)));
 assert.match(JSON.stringify(getSchemaFragment('static')),/must end in a terminal \/\*/);
});

test('the removed link handler and "stored links have no replacement" cannot reappear in agent-visible prose (#540)',async t=>{
 const inventory=await inventoryOnce();
 assert.equal(inventory.status,0,inventory.stderr);
 const facts=JSON.parse(inventory.stdout) as {linkHandler:boolean;storeShortLinks:boolean};
 assert.equal(facts.linkHandler,false);assert.equal(facts.storeShortLinks,true);
 const scan=await scanner(t,'AI-AUTHORING.md');
 // The exact sentences docs/AI-AUTHORING.md shipped before this guard.
 await Promise.all(([
  ['instance — say explicitly why a generated route does or does not declare\n`sandbox: true`. Most native handlers (`redirect`, `respond`, `page`,\n`static`, `download`, `link`, `proxy`) need no `function`/`middleware` at all\nand this decision does not apply to them.\n','linkHandler = false'],
  ['There is no native `link` handler or `dynamicLinks` project flag; both were\nremoved. The `urlcode-dynamic-link` extension package that briefly owned them\nhas been retired and unpublished, so there is no supported replacement. Report a\nrequest for live stored links as a gap rather than inventing a `link` field.\n','storeShortLinks (no-replacement)'],
  ['Report a request for live stored links as a gap rather than inventing a `link` field.\n','storeShortLinks (reported-as-gap)'],
  ['Declare stored short links with the native `link` handler.\n','linkHandler = false'],
 ] as const).map(async([text,fact])=>{
  const result=await scan(text);
  assert.equal(result.status,1,`${fact} should reject: ${text}`);
  assert.ok(result.stderr.includes(`[${fact}`),result.stderr);
 }));
 // Accurate wording stays clean: the removal itself, and a gap limited to needs beyond shortLinks.
 const clean=await scan('There is no native `link` handler or `dynamicLinks` project flag; both were removed. Never invent a `link` field.\n\nCore has no native handler for this: the `link` handler that implemented it was removed, and the `urlcode-dynamic-link` package that replaced it is retired. There is no in-core replacement or deprecation shim for `link`/`dynamicLinks`.\n\nReport a gap only for stored-link needs beyond `shortLinks`: a custom redirect status or non-HTTP(S) destinations.\n');
 assert.equal(clean.status,0,clean.stderr);
});

test('prose cannot claim Codex reads or discovers a project .mcp.json (#103)',async t=>{
 const inventory=await inventoryOnce();
 assert.equal(inventory.status,0,inventory.stderr);
 assert.deepEqual(JSON.parse(inventory.stdout).mcpRegistration,{projectFile:'.mcp.json',readBy:['Claude Code'],codexReadsProjectFile:false});
 const scan=await scanner(t,'TOOLING.md');
 // The exact wording docs/TOOLING.md, docs/STARTERS.md, docs/AI-AUTHORING.md and llms.txt shipped before this guard.
 await Promise.all([
  '`urlcode init` writes `.mcp.json` at the site root, beside `host.mjs`, the\nshape Claude Code and Codex read:\n',
  '- **Codex** reads the same `mcpServers` shape; alternatively register it in\n  `~/.codex/config.toml`:\n',
  'A project-scoped MCP client (Claude Code, Codex) reads `.mcp.json` once, at the\nstart of its session, before the agent\'s first turn.\n',
  '`AGENTS.md`, and a read-only local `.mcp.json` for Claude Code and Codex. It\n',
  'Both paths also write `.mcp.json`, which registers the read-only `urlcode mcp`\nserver for Claude Code and Codex with `--project app`; it is\n',
  '`urlcode init` writes `.mcp.json` so Claude Code and Codex register the read-only\nserver for the project.\n',
  '`.mcp.json` only exists once `init` writes it, so a project-scoped MCP client (Claude Code, Codex) that loads it at session start sees no `urlcode` tools.\n',
  'Codex discovers a project `.mcp.json` at session startup.\n',
 ].map(async text=>{
  const result=await scan(text);
  assert.equal(result.status,1,`should reject: ${text}`);
  assert.ok(result.stderr.includes('[mcpRegistration.codexReadsProjectFile'),result.stderr);
 }));
 const clean=await scan('`urlcode init` writes `.mcp.json`, the project-scoped file Claude Code reads.\n\nCodex does not read `.mcp.json`: register the same command under `[mcp_servers.urlcode]` in `~/.codex/config.toml`, or with `codex mcp add`.\n\nA plugin-bundled `.mcp.json` is a separate Codex plugin integration, not a project registration.\n');
 assert.equal(clean.status,0,clean.stderr);
});

test('prose cannot limit documentation search to core-pinned add-ons once it reads verified independent ones (#1090)',async t=>{
 const inventory=await spawnAsync(process.execPath,[script,'--inventory'],{timeout:30000});
 assert.equal(inventory.status,0,inventory.stderr);
 assert.equal(JSON.parse(inventory.stdout).docsSearch.independentAddonGuides,true);
 const dir=await mkdtemp(join(tmpdir(),'urlcode-agent-facts-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const scan=async(text:string)=>{const file=join(dir,'README.md');await writeFile(file,text);return spawnAsync(process.execPath,[script,'--files',file],{timeout:30000});};
 for(const text of ['`search_docs` reads only the guides of core-pinned add-ons.\n','`urlcode docs search` skips independent packages, which are never read.\n']){
  const result=await scan(text);
  assert.equal(result.status,1,`should reject: ${text}`);
  assert.ok(result.stderr.includes('[docsSearch.independentAddonGuides'),result.stderr);
 }
 const clean=await scan('`search_docs` reads verified installed add-ons, core-pinned or independent, and lists an unverified one as not searched.\n');
 assert.equal(clean.status,0,clean.stderr);
});

test('package contributor guidance follows workspace packages, streaming targets and the MCP SDK boundary (#1121)',async t=>{
 const inventory=await inventoryOnce();
 assert.equal(inventory.status,0,inventory.stderr);
 const facts=JSON.parse(inventory.stdout) as {workspacePackages:string[];streaming:{targets:string[]};mcpExtension:{protocolFromSdk:boolean;pagination:boolean}};
 assert.deepEqual(facts.streaming.targets,[...streamingTargets]);
 assert.ok(facts.workspacePackages.includes('core')&&facts.workspacePackages.includes('mcp')&&!facts.workspacePackages.includes('ui'));
 assert.deepEqual(facts.mcpExtension,{protocolFromSdk:true,pagination:false});
 // A contributor file lives under packages/<name>/, which is how a claim knows its subject without the name.
 const dir=await mkdtemp(join(tmpdir(),'urlcode-agent-facts-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 let next=0;
 const scan=async(name:string,text:string)=>{const own=join(dir,String(next++),'packages',name);await mkdir(own,{recursive:true});const file=join(own,'AGENTS.md');await writeFile(file,text);return checkFacts('--files',file);};
 // The exact sentences packages/mcp/AGENTS.md, packages/mcp/llms.txt, packages/mcp/README.md and packages/store/AGENTS.md shipped before this guard.
 await Promise.all(([
  ['mcp','Core owns the generic extension contract (`@jimhoyd/urlcode/extensions`); this package owns JSON-RPC 2.0 framing, protocol version negotiation, request-id handling, cursor pagination and dispatch.\n','mcpExtension.protocolFromSdk'],
  ['mcp','The extension owns JSON-RPC 2.0 framing, protocol version negotiation, request-id handling, cursor pagination and initialize/ping dispatch.\n','mcpExtension.pagination = false'],
  ['mcp','This extension\'s known remaining gaps (streaming on AWS/Vercel, persisted sessions, resumable POST streams, resource templates/subscriptions) are documented in README.md, not silently implied.\n','streaming.targets includes vercel'],
  ['mcp','- The streaming transport is operator opt-in only: `mcp({ streaming: true })` in `host.mjs`; never YAML. Off by default (GET answers 405). On, it needs the self-hosted server (aws and vercel are refused), and sessions live in memory: a restart answers 404 and the client re-initializes.\n','streaming.targets includes vercel'],
  ['mcp','The MCP extension\'s opt-in streaming transport is self-hosted only.\n','streaming.targets = '],
  ['store','Runtime, CLI and schema, accounts and protected routes, users and audit, extension page styling and copy, and this extension\'s own data contract all live in this one repository now.\n','workspacePackages excludes ui'],
  ['store','Extension page styling and copy live in `packages/ui`.\n','workspacePackages = '],
 ] as const).map(async([name,text,fact])=>{
  const result=await scan(name,text);
  assert.equal(result.status,1,`${fact} should reject: ${text}`);
  assert.ok(result.stderr.includes(`[${fact}`),result.stderr);
 }));
 // The current wording stays clean: the SDK owns the protocol, Vercel is delegated, AWS refused, function streaming self-hosted.
 const clean=await scan('mcp','The official MCP TypeScript SDK owns the protocol: JSON-RPC 2.0 framing and version negotiation are the SDK\'s. This package owns the declarative mapping; lists return every declared entry, with no pagination.\n\nStreamed progress replies are served natively on the self-hosted server, delegated to the provider on Vercel, and refused on AWS before activation. Known gaps: sessions and resumable streams, streaming on AWS.\n\n`stream: true` on a trusted `function` route (self-hosted only) sends the body as it is produced.\n\nCompression settings are refused on Vercel, AWS and Cloudflare. The former ui, auth and admin repositories are retired.\n');
 assert.equal(clean.status,0,clean.stderr);
});
