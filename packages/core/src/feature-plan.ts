import {buildContext,estimateTokens} from './context.ts';
import {getCapabilities,normalizeCapabilityTarget} from './capabilities.ts';
import type {CapabilityName,CapabilityTarget} from './capabilities.ts';
import {listRecipes,runsProjectCode} from './recipes.ts';
import {describeInstalledArtifacts} from './addon-install.ts';
import {dirname,resolve} from 'node:path';
import {declaredExtensionTargets,installedProviders,readAddonCatalog} from './addon-manifest.ts';
import type {AddonCatalog} from './addon-manifest.ts';
import type {ExtensionAuthoringContract,RuntimeExtension} from './extensions.ts';

/** The planner is deliberately a small, local projection. It never treats goal
 * text as instructions, opens a host, or reads extension/project source. */
export const featurePlanMaxBytes=32768;
export const featurePlanMaxGoalLength=512;
/**
 * `extensions`: registrations from a loaded operator host file (an empty array when it registers none); leave it undefined when no host file is loaded, and `next` omits `get_extensions`.
 * `origin`: the canonical origin the operator supplied (`--origin`), compiled into the project exactly as `context` does; never guessed.
 */
export interface FeaturePlanOptions { target?:string; extensions?:readonly RuntimeExtension[]|undefined; origin?:string|undefined; }
export interface FeaturePlan {
 format:1; goalTerms:string[]; target:CapabilityTarget; project:{routes:number;extensions:string[]};
 applicable:{capabilities:{name:CapabilityName;support:string;reason:string}[];recipes:{name:string;description:string;matched:string[]}[]};
 extensions:{required:{name:string;reason:string;declared:boolean;registered:boolean;target:string;artifact:'none'|'installed'|'unpinned'|'modified'|'invalid'}[];surfaces:PlannedSurface[];ordering:{status:'operator-resolved';names:string[];note:string}};
 outline:{kind:string;note:string}[]; applicationCode:{requirement:string;reason:string}[]; unsupported:{requirement:string;reason:string}[]; next:string[]; estimatedTokens:number;
}

/**
 * An extension authoring surface whose declared `goals` share words with the goal (#913). `source` says which contract
 * named it: the loaded host's registration, the descriptor installed in the site, or this core's release catalog.
 */
export interface PlannedSurface {extension:string;surface:string;kind:string;source:'registered'|'installed'|'catalog';matched:string[]}
type AuthoringSource=PlannedSurface['source'];
/** The most surfaces one plan lists; each also adds one outline entry. */
const plannedSurfaceLimit=12;
/**
 * Every extension's authoring contract the planner may read, by name: a registration from the loaded host wins, then the
 * descriptor installed in the site around the project, then the release catalog. Data only; nothing is imported.
 */
async function authoringContracts(project:string,registrations:readonly RuntimeExtension[],catalog:AddonCatalog|undefined):Promise<Map<string,{source:AuthoringSource;authoring:ExtensionAuthoringContract}>> {
 const contracts=new Map<string,{source:AuthoringSource;authoring:ExtensionAuthoringContract}>();
 for(const registration of registrations)if(registration.authoring)contracts.set(registration.name,{source:'registered',authoring:registration.authoring});
 try {
  for(const provider of (await installedProviders(dirname(resolve(project)))).providers.values())
   if(provider.descriptor.kind==='extension'&&provider.descriptor.authoring&&!contracts.has(provider.name))contracts.set(provider.name,{source:'installed',authoring:provider.descriptor.authoring});
 } catch {/* no readable site is an ordinary absence */}
 for(const entry of catalog?.addons??[])if(entry.kind==='extension'&&entry.authoring&&!contracts.has(entry.name))contracts.set(entry.name,{source:'catalog',authoring:entry.authoring});
 return contracts;
}
type MatchedSurface=PlannedSurface&{description:string;path?:string|undefined};
/**
 * The surfaces whose goals the goal terms name, in contract order, extensions by name. A surface named by two or more
 * goal terms is `strong`: one word alone ("notify the team", "send an email") is incidental and never makes an
 * extension required by itself (#932). A single-word surface is still listed when something stronger requires its
 * extension (a recipe, a goal noun or another surface).
 */
function matchedSurfaces(goalTerms:readonly string[],contracts:Map<string,{source:AuthoringSource;authoring:ExtensionAuthoringContract}>):(MatchedSurface&{strong:boolean})[] {
 const found:(MatchedSurface&{strong:boolean})[]=[];
 for(const name of [...contracts.keys()].sort()){
  const {source,authoring}=contracts.get(name)!;
  for(const surface of authoring.surfaces){
   const matched=(surface.goals??[]).filter(goal=>goalTerms.includes(goal));
   if(matched.length)found.push({extension:name,surface:surface.name,kind:surface.kind,source,matched,description:surface.description,path:surface.path,strong:matched.length>=surfaceStrength});
  }
 }
 return found;
}
/** The fewest distinct goal terms one surface must share before it alone requires its extension (#932). */
const surfaceStrength=2;
const stop=new Set(['a','an','and','the','with','for','to','of','in','on','that','my','i','want','need','from']);
function terms(goal:string):string[] {
 // A hyphenated word also counts as its parts, so "hmac-signed" reaches both hmac and signed.
 const words=goal.toLowerCase().split(/[^a-z0-9.-]+/).flatMap(word=>word.includes('-')?[word,...word.split('-')]:[word]).filter(word=>word.length>1&&!stop.has(word));
 return [...new Set(words)].slice(0,16);
}
const signatureTerms=['hmac','signature','signatures','signing','webhook','webhooks'];
/**
 * List, filter, sort and paging vocabulary (#834). These goals are declarations: a store collection's `filterable` and
 * `sortable` properties with limit/cursor paging, or query `parameters` on a route, never a handler that parses the
 * query string itself.
 */
const listQueryTerms=['list','lists','listing','filter','filters','filtered','filtering','sort','sorts','sorted','sorting','order','ordered','ordering','paginate','paginated','pagination','paging','query','queries','cursor','limit','newest','oldest'];
/** The fewest distinct goal terms a recipe's tags must share before the tag fallback offers it: one generic word ("status", "json") is not a match. */
const tagFallbackMinimum=2;
const recipeTerms:Record<string,readonly string[]>={
 'json-endpoint':['json','endpoint','api','validate','validates','validated','validation','schema','signup','register','registration','202','422','body','post','field','fields'],
 'webhook-receiver':['webhook','webhooks','hmac','signature','signatures','signing','callback'],
 'contact-form':['contact','form','message','submission','email'],
 'authenticated-json-api':['auth','authenticated','account','accounts','sign','signed','signin','login','logout','session','sessions','password','private','protected'],
 'store-crud':['store','persist','persisted','persistence','durable','database','crud','record','records','submission','submissions',...listQueryTerms],
 'store-booking':['book','booking','bookings','schedule','scheduling','reservation','reservations','reserve','appointment','appointments','slot','slots','calendar','availability','overlap','overlapping','interval','intervals'],
 'store-credits':['credit','credits','wallet','wallets','balance','balances','transfer','transfers','ledger','points','issuer','issuers','mint','payment','payments'],
};
const extensionReason:Record<string,string>={
 auth:'Authentication is an operator-installed extension; its registration and revision pin, not project YAML, select the executable package and grants.',
 store:'Durable state is an operator-installed extension; its data directory and revision pin remain operator-owned.',
};
const outline:Record<string,{kind:string;note:string}>={
 'json-endpoint':{kind:'declarative JSON endpoint',note:'Declare the fields in request.body.POST.schema (the runtime answers 422 before anything runs) and the answer with respond: {status, json}; no function. get_schema request.body.POST.schema lists the supported JSON Schema subset.'},
 'webhook-receiver':{kind:'signed webhook',note:'Declare header parameters with pattern and request.body.POST.schema; verify the HMAC in a trusted function (the default) with node:crypto, reading the key from a secrets: {KEY: {secret: NAME}} binding the operator grants. A sandbox: true route has no crypto API.'},
 'contact-form':{kind:'contact endpoint',note:'The bundled recipe serves a static page that posts JSON to one POST route: request.body.POST.schema validates the fields (format: email), respond answers 202 and a revision-pinned signal notifies a hook; no function. Add policies.throttle before publishing; to email the message, a trusted function calls the mail provider directly (recipe README).'},
 'authenticated-json-api':{kind:'protected endpoint',note:'The bundled recipe protects a function route with auth: true; Better Auth (the auth extension) owns sign-in and sessions, and the function reads context.capabilities.auth.identity.userId.'},
 'store-crud':{kind:'durable collection',note:'The bundled recipe declares a collection and an extension mount; CRUD behavior belongs to the registered store extension, not a generated handler.'},
 'store-booking':{kind:'declarative booking',note:'The bundled recipe declares an owned bookings collection behind auth: true: intervals {start, end, within: [room], when: {status: booked}} answers 409 interval_conflict for an overlapping booking across owners, a cancel transition frees the slot, and status is readOnly; no handler.'},
 'store-credits':{kind:'declarative credits',note:'The bundled recipe declares owned wallets behind auth: true with a balance that defaults to 0, is in readOnlyProperties and is never set by a transition. pay moves whole credits and never overdraws; funding comes from the issuer pattern: an issue transfer with a negative min (the credit outstanding) and members: <membership collection>, so only a listed issuer mints and the sum stays 0. The operator adds issuers with urlcode-store members add; no handler.'},
};
const listQueryOutline={kind:'declarative list query',note:'Declare the query instead of parsing it. A store collection lists the properties a GET may filter by equality in filterable (?status=pending) and sort by in sortable (?sort=<property>, ?sort=-<property> descending; one sort property, id breaks ties); a list answers pages bounded by pageSize and continued with ?limit= and the opaque ?cursor=, and a value the property schema refuses answers 400 invalid_query. A string property needs maxLength or an enum to be filterable or sortable. ownership: owner behind auth: true scopes every list to the signed-in principal. A route that lists something the store does not hold declares its query parameters (parameters: [{name: status, in: query, schema: {type: string, enum: [...]}}]) so the runtime answers 400 before anything runs. get_schema routes.*.parameters and the store README list the exact fields.'};
type Recipe=Awaited<ReturnType<typeof listRecipes>>[number];
/** Goal terms a recipe answers: its planner terms, then whole tags, capabilities and id parts (the same fields search_recipes reads). */
function matchedTerms(goalTerms:string[],recipe:Recipe):string[] {
 const tags=recipe.tags.map(tag=>tag.toLowerCase()),capabilities=(recipe.capabilities??[]).map(name=>name.toLowerCase()),id=recipe.name.split('-');
 const known=recipeTerms[recipe.name]??[];
 return goalTerms.filter(term=>known.includes(term)||tags.includes(term)||capabilities.includes(term)||id.includes(term));
}
/** A recipe that needs `<name> extension` as a service answers the goal terms that extension's matched surfaces named. */
function extensionTerms(recipe:Recipe,surfaceTerms:ReadonlyMap<string,readonly string[]>):string[] {
 return recipeExtensions(recipe).flatMap(name=>surfaceTerms.get(name)??[]);
}
/** The extensions a recipe's `services` name as `<name> extension`. */
function recipeExtensions(recipe:Recipe):string[] {
 return (recipe.services??[]).flatMap(service=>{const match=/\b([a-z][a-z0-9-]*) extension\b/i.exec(service.name);return match?[match[1]!.toLowerCase()]:[];});
}
/**
 * The recipes an extension fallback may offer on words the goal shares only with that extension's surfaces (#957).
 * Those words are inherited by every recipe built on the extension, so they are not distinctive: they select only the
 * extension's general recipe (the one needing the fewest services, as store-crud needs the store alone), for the
 * extension whose surfaces the goal named most. A specialised recipe (store-booking, store-credits need the store and
 * auth) is offered only on its own terms, so an approval goal's "submit", "approve" or "reviewers" never selects it.
 */
function generalExtensionRecipes(recipes:Recipe[],surfaceTerms:ReadonlyMap<string,readonly string[]>):Recipe[] {
 const most=Math.max(0,...[...surfaceTerms.values()].map(words=>words.length));
 return [...surfaceTerms].filter(([,words])=>words.length>0&&words.length===most).flatMap(([name])=>{
  const built=recipes.filter(recipe=>recipeExtensions(recipe).includes(name));
  const fewest=Math.min(...built.map(recipe=>(recipe.services??[]).length));
  return built.filter(recipe=>(recipe.services??[]).length===fewest);
 }).filter((recipe,index,all)=>all.indexOf(recipe)===index);
}
/**
 * Most tags are generic across the catalog ("json" is on ten recipes, "store" and "auth" on the booking and credits
 * recipes alike). A tag is distinctive when at most this many recipes carry it, IDF-style: the tag fallback needs one.
 */
const distinctiveTagMaximum=2;
function selectedRecipes(goalTerms:string[], recipes:Recipe[], surfaceTerms:ReadonlyMap<string,readonly string[]>=new Map()) {
 const mapped=recipes.filter(recipe=>{
  const known=recipeTerms[recipe.name]??[];
  return known.some(term=>goalTerms.includes(term));
 });
 // With no recipe of its own terms, the general recipe of the extension whose surfaces the goal named comes next (#913, #957).
 const viaExtensions=mapped.length?mapped:generalExtensionRecipes(recipes,surfaceTerms);
 // The tag fallback needs several shared terms, one of them distinctive: generic words ("status", "json api") never select a recipe.
 const frequency=new Map<string,number>();
 for(const recipe of recipes)for(const tag of new Set(recipe.tags.map(tag=>tag.toLowerCase())))frequency.set(tag,(frequency.get(tag)??0)+1);
 const candidates=viaExtensions.length?viaExtensions:recipes.filter(recipe=>{
  const shared=new Set(recipe.tags.map(tag=>tag.toLowerCase()).filter(tag=>goalTerms.includes(tag)));
  return shared.size>=tagFallbackMinimum&&[...shared].some(tag=>(frequency.get(tag)??0)<=distinctiveTagMaximum);
 });
 // Declarative first (docs/PROJECT-DIRECTION.md): a recipe that runs no project code outranks one that does, then more
 // of the goal's words in the recipe's own terms, then the recipe needing fewer services (a goal that names none of a
 // specialised recipe's words gets the general one: approvals get store-crud, not store-booking), then more words overall.
 return candidates.map((recipe,index)=>({recipe,index,code:runsProjectCode(recipe),own:matchedTerms(goalTerms,recipe).length,services:(recipe.services??[]).length,matched:new Set([...matchedTerms(goalTerms,recipe),...extensionTerms(recipe,surfaceTerms)]).size}))
  .sort((a,b)=>Number(a.code)-Number(b.code)||b.own-a.own||a.services-b.services||b.matched-a.matched||a.index-b.index).map(item=>item.recipe).slice(0,4);
}

/**
 * Plans only from the current compiled project, package-owned catalogs, locked
 * inert artifacts, installed add-on descriptors, and registrations passed by the
 * already-opened operator session. It intentionally has no filesystem path, host-file, binding, or
 * execution argument.
 */
export async function planFeature(project:string,goal:string,options:FeaturePlanOptions={}):Promise<FeaturePlan> {
 if(typeof goal!=='string'||goal.length<1||goal.length>featurePlanMaxGoalLength)throw new Error(`Feature goal must be 1 to ${featurePlanMaxGoalLength} characters`);
 const goalTerms=terms(goal),target=normalizeCapabilityTarget(options.target??'self-hosted');
 // "signed" in a signature goal ("an HMAC-signed webhook") or "sign" in "sign-up" is not about signing a person in.
 const signatureGoal=goalTerms.some(term=>signatureTerms.includes(term)),signupGoal=goalTerms.includes('sign-up');
 const recipeGoalTerms=signatureGoal||signupGoal?goalTerms.filter(term=>term!=='sign'&&term!=='signed'):goalTerms;
 let addonCatalog:AddonCatalog|undefined;
 try {addonCatalog=await readAddonCatalog();} catch {/* a core without its catalog (an unbuilt checkout) plans from registrations and installed descriptors */}
 // Extension authoring contracts name their own surfaces' goal words (#913); core keeps no per-extension vocabulary for them.
 const candidates=matchedSurfaces(recipeGoalTerms,await authoringContracts(project,options.extensions??[],addonCatalog));
 // Only a strong surface requires its extension or steers recipe selection (#932).
 const surfaceTerms=new Map<string,string[]>();
 for(const surface of candidates)if(surface.strong)surfaceTerms.set(surface.extension,[...new Set([...(surfaceTerms.get(surface.extension)??[]),...surface.matched])]);
 const context=await buildContext(project,{target,projectFlag:'.',origin:options.origin}), recipes=selectedRecipes(recipeGoalTerms,await listRecipes(),surfaceTerms);
 const listQuery=recipeGoalTerms.some(term=>listQueryTerms.includes(term));
 const capabilities=[...new Set([...recipes.flatMap(recipe=>recipe.capabilities??[]),...(listQuery?['parameters']:[])].filter((name):name is CapabilityName=>typeof name==='string'))].sort();
 const catalog=getCapabilities(target), rows=new Map(catalog.capabilities.map(row=>[row.capability,row]));
 const registrations=new Map((options.extensions??[]).map(extension=>[extension.name,extension]));
 const wanted=new Set<string>();
 for(const recipe of recipes) for(const service of recipe.services??[]) {
  const match=/\b(auth|store) extension\b/i.exec(service.name); if(match)wanted.add(match[1]!.toLowerCase());
 }
 // These nouns request composition, not a project-controlled package choice.
 if(recipeGoalTerms.some(term=>['auth','authenticated','account','sign','signed','private','protected'].includes(term)))wanted.add('auth');
 // Per-owner records (store ownership: owner) sit behind a principal-providing policy such as auth: true.
 if(listQuery&&goalTerms.some(term=>['owner','owners','owned','ownership'].includes(term)))wanted.add('auth');
 if(goalTerms.some(term=>['store','persist','persisted','persistence','durable','database','crud','record','records','submission','submissions'].includes(term))||listQuery)wanted.add('store');
 for(const extension of surfaceTerms.keys())wanted.add(extension);
 // A surface is listed when its extension is required: every strong one, and a single-word one beside them.
 const surfaces=candidates.filter(surface=>wanted.has(surface.extension)).slice(0,plannedSurfaceLimit).map(({strong:_strong,...surface})=>surface);
 const declaredTargets=addonCatalog?declaredExtensionTargets(addonCatalog):new Map<string,string[]>();
 let artifacts:Awaited<ReturnType<typeof describeInstalledArtifacts>>['artifacts']=[];
 try {artifacts=(await describeInstalledArtifacts(project)).artifacts;} catch {/* no site is an ordinary absence, never a reason to read elsewhere */}
 const declared=new Set(context.project.extensions);
 const required=[...wanted].sort().map(name=>{
  const registration=registrations.get(name), artifact=artifacts.find(item=>item.name===name);
  // The registration decides; without one, the release descriptor's declared targets can still refuse (never confirm) a target.
  const internal=target==='self-hosted'?'node':target, catalogTargets=declaredTargets.get(name);
  const verdict=registration?(target!=='static'&&registration.targets.includes(internal as never)?'supported':'refused')
   :catalogTargets&&!catalogTargets.includes(internal)?'refused':'unknown';
  return {name,reason:extensionReason[name]??'This feature needs an operator-registered extension contract.',declared:declared.has(name),registered:Boolean(registration),target:verdict,artifact:artifact?.status??'none'} as const;
 });
 const unsupported:FeaturePlan['unsupported']=[];
 if(goalTerms.some(term=>['flow','workflow','multistep','multi-step','wizard'].includes(term)))unsupported.push({requirement:'Declarative form flow',reason:'No bundled core capability or recipe declares multi-step form state, transitions, or submission orchestration. Keep the steps in the application frontend and validate each JSON submission with request.body.POST.schema on a function route or a store mount.'});
 if(goalTerms.some(term=>['idempotent','idempotency'].includes(term)))unsupported.push({requirement:'Idempotent mutation',reason:'The core capability catalog has no idempotent mutation primitive. Require an installed extension contract that exposes it, or keep the idempotency key and mutation logic in application code.'});
 for(const capability of capabilities){const row=rows.get(capability);if(row?.targets[target]?.support==='refused')unsupported.push({requirement:capability,reason:row.targets[target]!.reason});}
 for(const extension of required)if(extension.target==='refused')unsupported.push({requirement:`${extension.name} extension on ${target}`,reason:extension.registered?'The already-registered extension does not declare support for this target.':'The extension does not declare support for this target (the targets in its release descriptor).'});
 const applicationCode:FeaturePlan['applicationCode']=[];
 if(signatureGoal)applicationCode.push({requirement:'Signature verification',reason:'YAML cannot compute an HMAC. Keep the route trusted (the default) and verify the signature in a small function with node:crypto (createHmac, timingSafeEqual), reading the key from a secrets: {KEY: {secret: NAME}} binding that an operator grants with --policy; declare the header parameters and request.body.POST.schema so the function only checks the signature. A sandbox: true route has no crypto API and cannot verify it. See the webhook-receiver recipe.'});
 if(recipes.some(recipe=>recipe.name==='contact-form'))applicationCode.push({requirement:'Product-specific form presentation and submission rules',reason:'The contact recipe covers a minimal page, a bounded JSON endpoint and an optional signal only; email delivery, product-specific UI and business workflow stay application code.'});
 if(!recipes.length)applicationCode.push({requirement:'Feature-specific behavior',reason:'No bundled declarative recipe matched the bounded goal terms. Check capability and extension contracts before writing focused application code.'});
 const plan:Omit<FeaturePlan,'estimatedTokens'>={
  format:1,goalTerms,target,project:{routes:context.project.routes,extensions:context.project.extensions},
  applicable:{capabilities:capabilities.map(name=>{const decision=rows.get(name)?.targets[target];return {name,support:decision?.support??'unknown',reason:decision?.reason??'Not in this revision\'s capability catalog'};}),recipes:recipes.map(recipe=>({name:recipe.name,description:recipe.description,matched:[...new Set([...matchedTerms(recipeGoalTerms,recipe),...extensionTerms(recipe,surfaceTerms)])].slice(0,8)}))},
  extensions:{required,surfaces:surfaces.map(({extension,surface,kind,source,matched})=>({extension,surface,kind,source,matched})),ordering:{status:'operator-resolved',names:[...wanted].sort(),note:'Extension package selection, prerequisites, and canonical activation order are resolved by the operator-approved init/host composition. Add one with `urlcode extensions add <name>`; this read-only plan installs nothing and never turns project YAML into an operator decision.'}},
  outline:[...(listQuery?[listQueryOutline]:[]),...surfaces.map(surface=>({kind:`${surface.extension} ${surface.surface}`,note:`${surface.description}${surface.path?` (${surface.path})`:''}`})),...recipes.map(recipe=>outline[recipe.name]??{kind:runsProjectCode(recipe)?`${recipe.name} (runs project code)`:`${recipe.name} (declarative)`,note:recipe.description})],applicationCode,unsupported,
  // get_extensions exists only when an operator host file was loaded (extensions passed, even empty).
  next:['get_context','search_recipes','get_capability',...(options.extensions===undefined?[]:['get_extensions']),'get_extension_artifacts'],
 };
 const estimatedTokens=estimateTokens(JSON.stringify(plan)); const result={...plan,estimatedTokens};
 if(Buffer.byteLength(JSON.stringify(result))>featurePlanMaxBytes)throw new Error('Feature plan exceeds output limit');
 return result;
}
