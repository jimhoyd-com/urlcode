import { stringify } from 'yaml';
import { parseYaml, validateDocument, MAX_CONFIG_BYTES } from './config.ts';
import { compileRoutes } from './router.ts';
import type { ProjectDocument, RouteConfig, RedirectConfig } from './types.ts';

export type InterchangeFormat = 'csv' | 'json' | 'yaml' | 'netlify' | 'cloudflare' | 'vercel' | 'netlify-toml';
export interface ConversionDiagnostic { severity: 'error' | 'warning'; code: string; source: string; row?: number; path?: string; message: string }
export interface ConversionCounts {
  convertedRoutes:number; nativeEquivalentRoutes:number; runtimeRequiredRoutes:number;
  unsupportedRows:number; providerDifferenceRoutes:number; fullyScanned:boolean;
}
export interface ConversionReport { counts:ConversionCounts; ok: boolean; lossless: boolean; routeCount: number; diagnostics: ConversionDiagnostic[]; document?: ProjectDocument; output?: string }
export interface ImportRoutesOptions { format: InterchangeFormat; text: string; source?: string; acceptProviderDifferences?: boolean }
export interface ExportRoutesOptions { format: InterchangeFormat; document: ProjectDocument; source?: string; acceptProviderDifferences?: boolean }
interface Row { path: string; url: string; status: number; row: number }
const formats = new Set(['csv','json','yaml','netlify','cloudflare','vercel','netlify-toml']);
const providers = new Set(['netlify','cloudflare','vercel','netlify-toml']);
const statuses = new Set([301,302,303,307,308]);
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected an object');
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new Error('Unsupported field; conversion would discard behavior');
}
function row(value: unknown, index: number): Row {
  const item = record(value); keys(item, ['path','url','status']);
  if (typeof item.path !== 'string' || typeof item.url !== 'string' || (item.status !== undefined && typeof item.status !== 'number')) throw new Error('Expected path and url strings and optional numeric status');
  const status = item.status === undefined ? 302 : item.status as number;
  if (!statuses.has(status)) throw new Error('Unsupported redirect status');
  if (!/^\/[A-Za-z0-9_./~-]*$/.test(item.path)) throw new Error('Only literal ASCII paths are supported; patterns, escapes and conditions require the runtime');
  if (/[{}]/.test(item.url)) throw new Error('Destination placeholders require the runtime');
  return {path:item.path,url:item.url,status,row:index};
}
/** RFC 4180-style fields, including quoted commas/newlines and escaped quotes. */
function csv(text: string): {cells:string[];row:number}[] {
  const result: {cells:string[];row:number}[] = []; let cells:string[] = [], cell = '', quoted = false, closed = false, line = 1, start = 1;
  for (let i=0;i<text.length;i++) {
    const ch=text[i]!;
    if (quoted) { if(ch==='"') { if(text[i+1]==='"'){cell+='"';i++;}else{quoted=false;closed=true;} }else{cell+=ch;if(ch==='\n')line++;} continue; }
    if(ch==='"'){if(cell || closed)throw new Error(`Invalid CSV quoting at row ${line}`);quoted=true;continue;}
    if(ch===',' || ch==='\n' || ch==='\r') {
      cells.push(cell);cell='';closed=false;
      if(ch!==','){if(ch==='\r'&&text[i+1]==='\n')i++;result.push({cells,row:start});cells=[];line++;start=line;}
      continue;
    }
    if(closed)throw new Error(`Unexpected data after CSV quote at row ${line}`);cell+=ch;
  }
  if(quoted)throw new Error(`Unterminated CSV quote at row ${start}`);
  if(cell || cells.length || closed){cells.push(cell);result.push({cells,row:start});}
  return result;
}
function parseRows(format: InterchangeFormat, text: string, add: (value:unknown,index:number)=>void): void {
  if(format==='csv') {
    const entries=csv(text), header=entries.shift()?.cells;
    if(!header || header.join(',')!=='path,url,status')throw new Error('CSV header must be path,url,status');
    for(const entry of entries){if(entry.cells.length!==3)throw new Error(`CSV row ${entry.row} must have three fields`);add({path:entry.cells[0],url:entry.cells[1],...(entry.cells[2] ? {status:Number(entry.cells[2])}: {})},entry.row);}
  }else if(format==='netlify'||format==='cloudflare') {
    for(const [i,line] of text.split(/\r?\n/).entries()) {
      const trimmed=line.trim();if(!trimmed||trimmed.startsWith('#'))continue;
      const fields=trimmed.split(/\s+/);if(fields.length<2||fields.length>3)throw new Error(`Unsupported redirect fields at row ${i+1}`);
      const status=fields[2] === undefined ? (format==='netlify'?301:302) : Number(fields[2]);
      add({path:fields[0],url:fields[1],status},i+1);
    }
  }else if(format==='netlify-toml') {
    // Deliberately a redirects-only grammar, not a general TOML implementation.
    let current:Record<string,unknown>|undefined, start=0;
    const finish=()=>{if(current)add({path:current.from,url:current.to,status:current.status??301},start);};
    for(const [i,line]of text.split(/\r?\n/).entries()) {
      const value=line.trim();if(!value||value.startsWith('#'))continue;
      if(value==='[[redirects]]'){finish();current={};start=i+1;continue;}
      const match=/^(from|to|status)\s*=\s*(.+)$/.exec(value);
      if(!current||!match||Object.hasOwn(current,match[1]!))throw new Error(`Unsupported or duplicate TOML declaration at row ${i+1}`);
      const key=match[1]!, literal=match[2]!;
      if(key==='status'){if(!/^\d{3}$/.test(literal))throw new Error(`Invalid TOML status at row ${i+1}`);current[key]=Number(literal);}
      else { if(!/^"[^"\\\u0000-\u001f]*"$/u.test(literal))throw new Error(`Only unescaped basic TOML strings are supported at row ${i+1}`);current[key]=literal.slice(1,-1); }
    }
    finish();
  }else {
    const data:unknown=format==='json'||format==='vercel'?JSON.parse(text):parseYaml(text);
    // Apply the same reserved-key/depth/JSON-value policy to JSON inputs.
    if(format==='json'||format==='vercel')parseYaml(text);
    if(format==='vercel') {
      const doc=record(data);keys(doc,['redirects']);if(!Array.isArray(doc.redirects))throw new Error('Expected redirects array');
      doc.redirects.forEach((value:unknown,i:number)=>{const entry=record(value);keys(entry,['source','destination','permanent','statusCode']);
        if(entry.permanent!==undefined&&(typeof entry.permanent!=='boolean'||entry.statusCode!==undefined))throw new Error(`Invalid permanent/statusCode at row ${i+1}`);
        if(entry.permanent===undefined&&entry.statusCode===undefined)throw new Error(`Specify permanent or statusCode at row ${i+1}`);
        add({path:entry.source,url:entry.destination,status:entry.statusCode??(entry.permanent?308:307)},i+1);});
    }else {if(!Array.isArray(data))throw new Error('Expected an array of {path,url,status} rows');data.forEach((value:unknown,i:number)=>add(value,i+1));}
  }
}
function providerRows(format:InterchangeFormat, rows:Row[]):void {
  if(!providers.has(format))return;
  if(rows.some(entry=> /:[A-Za-z_]|[*$]/.test(entry.url.replace(/^https?:\/\//,''))))throw new Error('Provider placeholder-like destinations cannot be converted safely');
  if(format==='cloudflare'&&(rows.length>2000||rows.some(entry=>`${entry.path} ${entry.url} ${entry.status}`.length>1000)))throw new Error('Cloudflare Pages supports at most 2,000 static redirects and 1,000 characters per rule');
}
function differences(format: InterchangeFormat, accepted:boolean, source:string):ConversionDiagnostic[] {
  if(!providers.has(format))return [];
  return [{severity:accepted?'warning':'error',code:'provider-semantics',source,message:(format==='netlify'||format==='netlify-toml'?'Netlify may forward incoming query parameters and let existing assets shadow redirects. ':'The provider request/query normalization and redirect method coverage are not guaranteed to match URLCode. ')+(format==='cloudflare'?'Cloudflare Pages Functions take precedence over _redirects. ':'')+'URLCode drops incoming queries and limits these routes to GET/HEAD; provider redirects can cover other methods. Only literal GET/HEAD requests without incoming queries, conflicting assets/functions or normalization are in scope. Explicit acknowledgment produces a non-lossless migration candidate; use the runtime for exact behavior.'}];
}
async function validateRows(rows:Row[], source:string, diagnostics:ConversionDiagnostic[]):Promise<ProjectDocument> {
  const routes:Record<string,RouteConfig>=Object.create(null) as Record<string,RouteConfig>;
  for(const entry of rows) {
    if(Object.hasOwn(routes,entry.path)){diagnostics.push({severity:'error',code:'duplicate-path',source,row:entry.row,path:entry.path,message:'Duplicate route path; no rule is overwritten'});continue;}
    routes[entry.path]={redirect:{url:entry.url,status:entry.status as NonNullable<RedirectConfig['status']>}};
  }
  const document:ProjectDocument={version:'1',routes};
  try {
    validateDocument(document);
    await compileRoutes({root:'.',document,routes,files:[],version:'interchange'},{});
  }catch(error){
    // On failure identify offending rows without exposing destination values.
    let located=false, examined=0;
    const deadline=performance.now()+10000;
    for(let offset=0;offset<rows.length;offset+=128){
      if(performance.now()>deadline||diagnostics.length>=100)break;
      const chunk=rows.slice(offset,offset+128);
      const subset:ProjectDocument={version:'1',routes:Object.fromEntries(chunk.map(entry=>[entry.path,routes[entry.path]!]))};
      try{validateDocument(subset);await compileRoutes({root:'.',document:subset,routes:subset.routes,files:[],version:'interchange'},{});examined+=chunk.length;continue;}catch{/* Locate the failure inside this bounded chunk. */}
      for(const entry of chunk){examined++;const one:ProjectDocument={version:'1',routes:{[entry.path]:routes[entry.path]!}};
        try{validateDocument(one);await compileRoutes({root:'.',document:one,routes:one.routes,files:[],version:'interchange'},{});}
        catch{located=true;diagnostics.push({severity:'error',code:'invalid-route',source,row:entry.row,path:entry.path,message:'Invalid route path or redirect destination under the URLCode contract'});}
        if(diagnostics.length>=100||performance.now()>deadline)break;
      }
    }
    if(examined<rows.length)diagnostics.push({severity:'error',code:'diagnostic-limit',source,message:'Diagnostic scan stopped at its resource limit; remaining rows were not classified'});
    if(!located)diagnostics.push({severity:'error',code:'invalid-project',source,message:error instanceof Error?error.message:'Invalid project'});
  }
  return document;
}
function counts(routeCount:number, diagnostics:ConversionDiagnostic[], ok:boolean):ConversionCounts {
  const runtimeRequiredRoutes=diagnostics.filter(item=>item.code==='runtime-required').length;
  const unsupportedRows=diagnostics.filter(item=>['unsupported-row','invalid-route','duplicate-path'].includes(item.code)).length;
  const providerDifferenceRoutes=diagnostics.some(item=>item.code==='provider-semantics')?routeCount:0;
  return {convertedRoutes:ok?routeCount:0,nativeEquivalentRoutes:ok&&diagnostics.length===0?routeCount:0,runtimeRequiredRoutes,unsupportedRows,providerDifferenceRoutes,
    fullyScanned:!diagnostics.some(item=>['invalid-input','invalid-project','diagnostic-limit'].includes(item.code))&&diagnostics.length<100};
}
function report(document:ProjectDocument, diagnostics:ConversionDiagnostic[], output:string):ConversionReport {
  const ok=!diagnostics.some(d=>d.severity==='error');
  const routeCount=Object.keys(document.routes).length;
  return {ok,lossless:diagnostics.length===0,routeCount,counts:counts(routeCount,diagnostics,ok),diagnostics,...(ok?{document,output}:{})};
}
/** Pure conversion: does not read projects, resolve bindings, execute guests or write files. */
export async function importRoutes(options:ImportRoutesOptions):Promise<ConversionReport> {
  const source=options.source??'<input>', diagnostics:ConversionDiagnostic[]=[],rows:Row[]=[];
  try{
    if(!formats.has(options.format))throw new Error('Unknown interchange format');
    if(Buffer.byteLength(options.text)>MAX_CONFIG_BYTES)throw new Error('Input exceeds 32 MiB');
    parseRows(options.format,options.text,(value,index)=>{
      if(rows.length>=100000)throw new Error('Input exceeds 100,000 routes');
      try{rows.push(row(value,index));}catch(error){diagnostics.push({severity:'error',code:'unsupported-row',source,row:index,message:error instanceof Error?error.message:'Invalid row'});}
      if(diagnostics.length>=100)throw new Error('Stopped after 100 invalid rows');
    });
    providerRows(options.format,rows);
    diagnostics.push(...differences(options.format,options.acceptProviderDifferences===true,source));
    rows.sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);
    const document=await validateRows(rows,source,diagnostics);
    return report(document,diagnostics,stringify(document));
  }catch(error){diagnostics.push({severity:'error',code:'invalid-input',source,message:error instanceof SyntaxError?'Invalid input syntax':error instanceof Error?error.message:'Invalid input'});return{ok:false,lossless:false,routeCount:rows.length,counts:counts(rows.length,diagnostics,false),diagnostics};}
}
function encodedCsv(value:string):string { return /[",\r\n]/.test(value)?`"${value.replaceAll('"','""')}"`:value; }
export async function exportRoutes(options:ExportRoutesOptions):Promise<ConversionReport> {
  const source=options.source??'<project>',diagnostics:ConversionDiagnostic[]=[],rows:Row[]=[];
  try{
    if(!formats.has(options.format))throw new Error('Unknown interchange format');
    keys(record(options.document),['version','routes']);validateDocument(options.document);
    if(Object.keys(options.document.routes).length>100000)throw new Error('Input exceeds 100,000 routes');
    for(const [path,config]of Object.entries(options.document.routes)) {
      try{keys(record(config),['redirect']);if(!config.redirect)throw new Error('Only redirects can be exported');if(path.includes('*')||config.redirect.url.startsWith('/'))throw new Error('Suffix wildcards and root-relative destinations have no provider equivalent');keys(record(config.redirect),['url','status']);rows.push(row({path,url:config.redirect.url,status:config.redirect.status??302},rows.length+1));}
      catch{diagnostics.push({severity:'error',code:'runtime-required',source,path,message:'Only literal redirects with default methods and no extra behavior can be exported'});}
    }
    rows.sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);
    providerRows(options.format,rows);
    diagnostics.push(...differences(options.format,options.acceptProviderDifferences===true,source));
    const document=await validateRows(rows,source,diagnostics);
    const simple=rows.map(({path,url,status})=>({path,url,status}));let output:string;
    switch(options.format){
      case 'csv':output='path,url,status\n'+simple.map(r=>[r.path,r.url,String(r.status)].map(encodedCsv).join(',')+'\n').join('');break;
      case 'json':output=JSON.stringify(simple,null,2)+'\n';break;
      case 'yaml':output=stringify(simple);break;
      case 'vercel':output=JSON.stringify({redirects:simple.map(r=>({source:r.path,destination:r.url,statusCode:r.status}))},null,2)+'\n';break;
      case 'netlify-toml':
        if(simple.some(r=>/["\\]/.test(r.url)))throw new Error('TOML subset cannot represent escaped destination strings');
        output=simple.map(r=>`[[redirects]]\nfrom = "${r.path}"\nto = "${r.url}"\nstatus = ${r.status}\n`).join('\n');break;
      default:output=simple.map(r=>`${r.path} ${r.url} ${r.status}\n`).join('');
    }
    return report(document,diagnostics,output);
  }catch(error){diagnostics.push({severity:'error',code:'invalid-project',source,message:error instanceof Error?error.message:'Invalid project'});return{ok:false,lossless:false,routeCount:rows.length,counts:counts(rows.length,diagnostics,false),diagnostics};}
}
