import {buildContext,estimateTokens} from './context.ts';
import {getCapabilities,normalizeCapabilityTarget} from './capabilities.ts';
import type {CapabilityName,CapabilityTarget} from './capabilities.ts';
import {listRecipes} from './recipes.ts';
import {describeArtifactCache} from './extension-artifacts.ts';
import type {RuntimeExtension} from './extensions.ts';

/** The planner is deliberately a small, local projection. It never treats goal
 * text as instructions, opens a host, or reads extension/project source. */
export const featurePlanMaxBytes=32768;
export const featurePlanMaxGoalLength=512;
export interface FeaturePlanOptions { target?:string; extensions?:readonly RuntimeExtension[]|undefined; }
export interface FeaturePlan {
 format:1; goalTerms:string[]; target:CapabilityTarget; project:{routes:number;extensions:string[]};
 applicable:{capabilities:{name:CapabilityName;support:string;reason:string}[];recipes:{name:string;description:string;matched:string[]}[]};
 extensions:{required:{name:string;reason:string;declared:boolean;registered:boolean;target:string;artifact:'none'|'cached'|'missing'|'invalid'}[];ordering:{status:'operator-resolved';names:string[];note:string}};
 outline:{kind:string;note:string}[]; applicationCode:{requirement:string;reason:string}[]; unsupported:{requirement:string;reason:string}[]; next:string[]; estimatedTokens:number;
}

const stop=new Set(['a','an','and','the','with','for','to','of','in','on','that','my','i','want','need','from']);
function terms(goal:string):string[] {
 const words=goal.toLowerCase().split(/[^a-z0-9.-]+/).filter(word=>word.length>1&&!stop.has(word));
 return [...new Set(words)].slice(0,16);
}
const recipeTerms:Record<string,readonly string[]>={
 'contact-form':['contact','form','message','submit','submission','email'],
 'authenticated-json-api':['auth','authenticated','account','sign','signed','private','protected'],
 'store-crud':['store','persist','persisted','persistence','durable','database','crud','record','records','submission','submissions'],
};
const extensionReason:Record<string,string>={
 ui:'Presentation is an operator-installed extension; its registered authoring surfaces govern project-owned UI customization.',
 auth:'Authentication is an operator-installed extension; its registration and revision pin, not project YAML, select the executable package and grants.',
 store:'Durable state is an operator-installed extension; its data directory and revision pin remain operator-owned.',
 forms:'Form workflow is available only through the already-registered forms extension contract; the project cannot select or install it.',
};
const outline:Record<string,{kind:string;note:string}>={
 'contact-form':{kind:'contact endpoint',note:'The bundled recipe establishes one POST JSON endpoint with bounded validation and a revision-pinned signal; it does not provide a browser form flow.'},
 'authenticated-json-api':{kind:'protected endpoint',note:'The bundled recipe protects a function route through the auth extension policy; the project declares the requirement but never loads the package.'},
 'store-crud':{kind:'durable collection',note:'The bundled recipe declares a collection and an extension mount; CRUD behavior belongs to the registered store extension, not a generated handler.'},
};
function selectedRecipes(goalTerms:string[], recipes:Awaited<ReturnType<typeof listRecipes>>) {
 const mapped=recipes.filter(recipe=>{
  const known=recipeTerms[recipe.name]??[];
  return known.some(term=>goalTerms.includes(term));
 });
 return (mapped.length?mapped:recipes.filter(recipe=>recipe.tags.some(tag=>goalTerms.includes(tag.toLowerCase())))).slice(0,4);
}

/**
 * Plans only from the current compiled project, package-owned catalogs, locked
 * inert artifacts, and registrations passed by the already-opened operator
 * session. It intentionally has no filesystem path, host-file, binding, or
 * execution argument.
 */
export async function planFeature(project:string,goal:string,options:FeaturePlanOptions={}):Promise<FeaturePlan> {
 if(typeof goal!=='string'||goal.length<1||goal.length>featurePlanMaxGoalLength)throw new Error(`Feature goal must be 1 to ${featurePlanMaxGoalLength} characters`);
 const goalTerms=terms(goal),target=normalizeCapabilityTarget(options.target??'self-hosted');
 const context=await buildContext(project,{target,projectFlag:'.'}), recipes=selectedRecipes(goalTerms,await listRecipes());
 const capabilities=[...new Set(recipes.flatMap(recipe=>recipe.capabilities??[]).filter((name):name is CapabilityName=>typeof name==='string'))].sort();
 const catalog=getCapabilities(target), rows=new Map(catalog.capabilities.map(row=>[row.capability,row]));
 const registrations=new Map((options.extensions??[]).map(extension=>[extension.name,extension]));
 const wanted=new Set<string>();
 for(const recipe of recipes) for(const service of recipe.services??[]) {
  const match=/\b(ui|auth|store) extension\b/i.exec(service.name); if(match)wanted.add(match[1]!.toLowerCase());
 }
 // These nouns request composition, not a project-controlled package choice.
 if(goalTerms.some(term=>['form','contact','screen','page','ui'].includes(term)))wanted.add('ui');
 // A forms capability is discoverable only from an operator registration. Do
 // not turn a goal noun into an implied package choice or YAML declaration.
 if(goalTerms.some(term=>['form','flow','workflow','multistep','multi-step','wizard'].includes(term))&&registrations.has('forms'))wanted.add('forms');
 if(goalTerms.some(term=>['auth','authenticated','account','sign','signed','private','protected'].includes(term)))wanted.add('auth');
 if(goalTerms.some(term=>['store','persist','persisted','persistence','durable','database','crud','record','records','submission','submissions'].includes(term)))wanted.add('store');
 let artifacts:Awaited<ReturnType<typeof describeArtifactCache>>['artifacts']=[];
 try {artifacts=(await describeArtifactCache(project)).artifacts;} catch {/* no lock is an ordinary absence, never a reason to read elsewhere */}
 const declared=new Set(context.project.extensions);
 const required=[...wanted].sort().map(name=>{
  const registration=registrations.get(name), artifact=artifacts.find(item=>item.name===name);
  const supported=target!=='static'&&registration?.targets.includes(target==='self-hosted'?'node':target);
  return {name,reason:extensionReason[name]??'This feature needs an operator-registered extension contract.',declared:declared.has(name),registered:Boolean(registration),target:registration?(supported?'supported':'refused'):'unknown',artifact:artifact?.status??'none'} as const;
 });
 const unsupported:FeaturePlan['unsupported']=[];
 if(goalTerms.some(term=>['flow','workflow','multistep','multi-step','wizard'].includes(term))&&!registrations.has('forms'))unsupported.push({requirement:'Declarative form flow',reason:'No already-registered forms extension contract is available, and no bundled core capability or recipe declares multi-step form state, transitions, or submission orchestration. Keep that application behavior focused, or define it as an extension boundary.'});
 if(goalTerms.some(term=>['idempotent','idempotency'].includes(term)))unsupported.push({requirement:'Idempotent mutation',reason:'The core capability catalog has no idempotent mutation primitive. Require an installed extension contract that exposes it, or keep the idempotency key and mutation logic in application code.'});
 for(const capability of capabilities){const row=rows.get(capability);if(row?.targets[target]?.support==='refused')unsupported.push({requirement:capability,reason:row.targets[target]!.reason});}
 for(const extension of required)if(extension.target==='refused')unsupported.push({requirement:`${extension.name} extension on ${target}`,reason:'The already-registered extension does not declare support for this target.'});
 const applicationCode:FeaturePlan['applicationCode']=[];
 if(recipes.some(recipe=>recipe.name==='contact-form'))applicationCode.push({requirement:'Product-specific form presentation and submission rules',reason:'The contact recipe covers a bounded JSON endpoint and optional signal only; it does not generate browser UI or business workflow code.'});
 if(!recipes.length)applicationCode.push({requirement:'Feature-specific behavior',reason:'No bundled declarative recipe matched the bounded goal terms. Check capability and extension contracts before writing focused application code.'});
 const plan:Omit<FeaturePlan,'estimatedTokens'>={
  format:1,goalTerms,target,project:{routes:context.project.routes,extensions:context.project.extensions},
  applicable:{capabilities:capabilities.map(name=>{const decision=rows.get(name)?.targets[target];return {name,support:decision?.support??'unknown',reason:decision?.reason??'Not in this revision\'s capability catalog'};}),recipes:recipes.map(recipe=>({name:recipe.name,description:recipe.description,matched:(recipeTerms[recipe.name]??[]).filter(term=>goalTerms.includes(term)).slice(0,4)}))},
  extensions:{required,ordering:{status:'operator-resolved',names:[...wanted].sort(),note:'Extension package selection, prerequisites, and canonical activation order are resolved by the operator-approved init/host composition. This read-only plan neither loads a bundle nor turns project YAML into an operator decision.'}},
  outline:recipes.map(recipe=>outline[recipe.name]??{kind:recipe.name,note:'Use the bundled recipe metadata as the known contract.'}),applicationCode,unsupported,
  next:['get_context','search_recipes','get_capability','get_extensions','get_extension_artifacts'].filter((name,index,all)=>all.indexOf(name)===index),
 };
 const estimatedTokens=estimateTokens(JSON.stringify(plan)); const result={...plan,estimatedTokens};
 if(Buffer.byteLength(JSON.stringify(result))>featurePlanMaxBytes)throw new Error('Feature plan exceeds output limit');
 return result;
}
