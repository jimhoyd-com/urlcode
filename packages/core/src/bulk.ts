import {createHash} from 'node:crypto';
import {open} from 'node:fs/promises';
import {stringify} from 'yaml';
import {parseYaml, validateDocument, MAX_CONFIG_BYTES} from './config.ts';
import {compileRoutes} from './router.ts';
import {isRecord} from './object-guards.ts';
import {publishAuthoringProject} from './authoring-files.ts';
import {assert} from './errors.ts';
import type {ProjectDocument, RouteConfig, RedirectConfig} from './types.ts';

export type BulkFormat='csv'|'json'|'yaml';
export interface BulkDiagnostic {severity: 'error'|'warning';code: string;source: string;row?: number;path?: string;message: string}
export interface BulkFilePlan {path: string;routeCount: number;firstPath?: string;lastPath?: string}
export interface BulkImportReport {
  ok: boolean;dryRun: boolean;output?: string;routeCount: number;diagnostics: BulkDiagnostic[];
  files: BulkFilePlan[];source: {name: string;format: BulkFormat;sha256: string};
}
interface Row {path: string;url: string;status: number;row: number}
const statuses=new Set([301,302,303,307,308]);
const MAX_ROUTES=100000, MAX_DIAGNOSTICS=100;

/** A regular UTF-8 file of at most 32 MiB, read once; growth during the read is refused. */
export async function readBulkInput(file: string): Promise<string> {
  const handle=await open(file,'r');
  try {
    const stat=await handle.stat();assert(stat.isFile()&&stat.size<=MAX_CONFIG_BYTES,'Bulk input must be a regular file of at most 32 MiB');
    const buffer=Buffer.alloc(stat.size+1);let size=0;
    while(size<buffer.length){const result=await handle.read(buffer,size,buffer.length-size,null);if(!result.bytesRead)break;size+=result.bytesRead;}
    assert(size<=stat.size,'Bulk input grew during read');
    return new TextDecoder('utf-8',{fatal:true}).decode(buffer.subarray(0,size));
  } finally {await handle.close();}
}
function row(value: unknown, index: number): Row {
  if(!isRecord(value))throw new Error('Expected an object');
  if(Object.keys(value).some(key=>!['path','url','status'].includes(key)))throw new Error('Unsupported field; conversion would discard behavior');
  if(typeof value.path!=='string'||typeof value.url!=='string'||(value.status!==undefined&&typeof value.status!=='number'))throw new Error('Expected path and url strings and optional numeric status');
  const status=value.status===undefined?302:value.status as number;
  if(!statuses.has(status))throw new Error('Unsupported redirect status');
  if(!/^\/[A-Za-z0-9_./~-]*$/.test(value.path))throw new Error('Only literal ASCII paths are supported; patterns, escapes and conditions require the runtime');
  if(/[{}]/.test(value.url))throw new Error('Destination placeholders require the runtime');
  // JSON and YAML refuse an unpaired surrogate escape when parsed (parseYaml, #1021); CSV text can still carry one,
  // which a redirect would send as %EF%BF%BD.
  if(!value.url.isWellFormed())throw new Error('Destination holds an unpaired UTF-16 surrogate (\\uD800-\\uDFFF), which UTF-8 cannot carry');
  return {path:value.path,url:value.url,status,row:index};
}
/** RFC 4180-style fields, including quoted commas/newlines and escaped quotes. */
function csv(text: string): {cells: string[];row: number}[] {
  const result: {cells: string[];row: number}[]=[];let cells: string[]=[],cell='',quoted=false,closed=false,line=1,start=1;
  for(let i=0;i<text.length;i++){
    const ch=text[i]!;
    if(quoted){if(ch==='"'){if(text[i+1]==='"'){cell+='"';i++;}else{quoted=false;closed=true;}}else{cell+=ch;if(ch==='\n')line++;}continue;}
    if(ch==='"'){if(cell||closed)throw new Error(`Invalid CSV quoting at row ${line}`);quoted=true;continue;}
    if(ch===','||ch==='\n'||ch==='\r'){
      cells.push(cell);cell='';closed=false;
      if(ch!==','){if(ch==='\r'&&text[i+1]==='\n')i++;result.push({cells,row:start});cells=[];line++;start=line;}
      continue;
    }
    if(closed)throw new Error(`Unexpected data after CSV quote at row ${line}`);cell+=ch;
  }
  if(quoted)throw new Error(`Unterminated CSV quote at row ${start}`);
  if(cell||cells.length||closed){cells.push(cell);result.push({cells,row:start});}
  return result;
}
function parseRows(format: BulkFormat, text: string, add: (value: unknown,index: number)=>void): void {
  if(format==='csv'){
    const entries=csv(text),header=entries.shift()?.cells;
    if(!header||header.join(',')!=='path,url,status')throw new Error('CSV header must be path,url,status');
    for(const entry of entries){if(entry.cells.length!==3)throw new Error(`CSV row ${entry.row} must have three fields`);add({path:entry.cells[0],url:entry.cells[1],...(entry.cells[2]?{status:Number(entry.cells[2])}:{})},entry.row);}
    return;
  }
  // JSON goes through the same reserved-key/depth/JSON-value policy as YAML.
  const data: unknown=format==='json'?JSON.parse(text):parseYaml(text);
  if(format==='json')parseYaml(text);
  if(!Array.isArray(data))throw new Error('Expected an array of {path,url,status} rows');
  data.forEach((value: unknown,i: number)=>add(value,i+1));
}
const compiles=async (document: ProjectDocument): Promise<void>=>{validateDocument(document);await compileRoutes({root:'.',document,routes:document.routes,files:[],version:'bulk'},{});};
async function validateRows(rows: Row[], source: string, diagnostics: BulkDiagnostic[]): Promise<ProjectDocument> {
  const routes: Record<string,RouteConfig>=Object.create(null) as Record<string,RouteConfig>;
  for(const entry of rows){
    if(Object.hasOwn(routes,entry.path)){diagnostics.push({severity:'error',code:'duplicate-path',source,row:entry.row,path:entry.path,message:'Duplicate route path; no rule is overwritten'});continue;}
    routes[entry.path]={redirect:{url:entry.url,status:entry.status as NonNullable<RedirectConfig['status']>}};
  }
  const document: ProjectDocument={version:'1',routes};
  try {await compiles(document);}
  catch(error){
    // On failure identify offending rows without exposing destination values.
    let located=false,examined=0;
    const deadline=performance.now()+10000;
    for(let offset=0;offset<rows.length;offset+=128){
      if(performance.now()>deadline||diagnostics.length>=MAX_DIAGNOSTICS)break;
      const chunk=rows.slice(offset,offset+128);
      try{await compiles({version:'1',routes:Object.fromEntries(chunk.map(entry=>[entry.path,routes[entry.path]!]))});examined+=chunk.length;continue;}catch{/* Locate the failure inside this bounded chunk. */}
      for(const entry of chunk){
        examined++;
        try{await compiles({version:'1',routes:{[entry.path]:routes[entry.path]!}});}
        catch{located=true;diagnostics.push({severity:'error',code:'invalid-route',source,row:entry.row,path:entry.path,message:'Invalid route path or redirect destination under the URLCode contract'});}
        if(diagnostics.length>=MAX_DIAGNOSTICS||performance.now()>deadline)break;
      }
    }
    if(examined<rows.length)diagnostics.push({severity:'error',code:'diagnostic-limit',source,message:'Diagnostic scan stopped at its resource limit; remaining rows were not classified'});
    if(!located)diagnostics.push({severity:'error',code:'invalid-project',source,message:error instanceof Error?error.message:'Invalid project'});
  }
  return document;
}
/** Parses and validates redirect rows into one project document, sorted by path; no partial document on failure. */
async function convertRows(text: string, format: BulkFormat, source: string): Promise<{document?: ProjectDocument;routeCount: number;diagnostics: BulkDiagnostic[]}> {
  const diagnostics: BulkDiagnostic[]=[],rows: Row[]=[];
  try {
    if(Buffer.byteLength(text)>MAX_CONFIG_BYTES)throw new Error('Input exceeds 32 MiB');
    parseRows(format,text,(value,index)=>{
      if(rows.length>=MAX_ROUTES)throw new Error('Input exceeds 100,000 routes');
      try{rows.push(row(value,index));}catch(error){diagnostics.push({severity:'error',code:'unsupported-row',source,row:index,message:error instanceof Error?error.message:'Invalid row'});}
      if(diagnostics.length>=MAX_DIAGNOSTICS)throw new Error('Stopped after 100 invalid rows');
    });
    rows.sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);
    const document=await validateRows(rows,source,diagnostics);
    return {routeCount:Object.keys(document.routes).length,diagnostics,...(diagnostics.length?{}:{document})};
  }catch(error){
    diagnostics.push({severity:'error',code:'invalid-input',source,message:error instanceof SyntaxError?'Invalid input syntax':error instanceof Error?error.message:'Invalid input'});
    return {routeCount:rows.length,diagnostics};
  }
}
/** Import ordinary redirect rows into small, portable include files. There is no
 * merge mode: duplicate rules and existing output directories are refused. */
export async function importBulkProject(text: string,format: BulkFormat,output: string,{dryRun=false,source='<input>'}: {dryRun?: boolean|undefined;source?: string|undefined}={}): Promise<BulkImportReport> {
  assert(['csv','json','yaml'].includes(format),'Bulk input must be csv, json or yaml');
  assert(source.length<=1024 && !/[\u0000-\u001f\u007f]/u.test(source),'Invalid bulk provenance source name');
  const provenance={name:source,format,sha256:createHash('sha256').update(text).digest('hex')};
  const converted=await convertRows(text,format,source);
  const report: BulkImportReport={ok:!!converted.document,dryRun,routeCount:converted.routeCount,diagnostics:converted.diagnostics,files:[],source:provenance};
  if(!converted.document)return report;
  const files=new Map<string,string>(),entries=Object.entries(converted.document.routes),includes: string[]=[];
  // 100 includes at the 100,000-route cap; each parser AST stays small without
  // changing the configuration worker heap, wall deadline or include limits.
  for(let offset=0;offset<entries.length;offset+=1000){
    const group=entries.slice(offset,offset+1000),path=`routes/redirects-${String(includes.length+1).padStart(3,'0')}.yaml`;
    includes.push(path);files.set(path,stringify({version:'1',routes:Object.fromEntries(group)}));
    report.files.push({path,routeCount:group.length,firstPath:group[0]![0],lastPath:group.at(-1)![0]});
  }
  files.set('urlcode.yaml',stringify({version:'1',...(includes.length?{includes}:{}),routes:{}}));
  report.files.unshift({path:'urlcode.yaml',routeCount:0});
  const metadata={version:1,source:provenance,routeCount:report.routeCount,files:report.files};
  files.set('provenance.json',JSON.stringify(metadata,null,2)+'\n');report.files.push({path:'provenance.json',routeCount:0});
  report.output=await publishAuthoringProject(output,files,dryRun);
  return report;
}
