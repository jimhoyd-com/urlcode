import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {createInterface} from 'node:readline';
import {isAbsolute} from 'node:path';
import {managementPolicy} from './management-policy.ts';
import {openLinkStore} from './link-store.ts';
import type {LinkStore,LinkStoreOptions} from './link-store.ts';
import {startLinkApi,loadLinkToken} from './link-api.ts';
import {linkCollection,linkCode,linkData} from './link-records.ts';
import {assert} from './errors.ts';
/** The parsed command-line values the links commands read; every flag is a string or absent. */
interface LinkCommandValues {
  project?: string|undefined; store?: string|undefined; collection?: string|undefined; code?: string|undefined;
  destination?: string|undefined; status?: string|undefined; enabled?: string|undefined; expires?: string|undefined;
  'if-version'?: string|undefined; limit?: string|undefined; after?: string|undefined; input?: string|undefined; 'page-size'?: string|undefined;
  'auth-file'?: string|undefined; 'token-file'?: string|undefined; port?: string|undefined; host?: string|undefined;
  'link-readers'?: string|undefined; 'link-read-limit'?: string|undefined; 'link-write-limit'?: string|undefined;
}
export type Print=(value: unknown)=>unknown;
export interface LinkPoolOptions { readers?: number; maxReads?: number; maxWrites?: number }
export interface LinkBinding extends LinkPoolOptions { collection: string; file: string }
const poolFlags=[['link-readers','readers',8],['link-read-limit','maxReads',32],['link-write-limit','maxWrites',32]] as const;
export function linkPoolOptions(values: LinkCommandValues): LinkPoolOptions {
  const result: LinkPoolOptions={};
  for(const [flag,key,max] of poolFlags){
    const value=values[flag];
    if(value===undefined)continue;
    assert(/^\d+$/.test(value)&&Number(value)>=1&&Number(value)<=max,`Invalid --${flag}`);result[key]=Number(value);
  }
  return result;
}
export function parseLinkBinding(value: string|undefined,options: LinkPoolOptions={}): LinkBinding|undefined {
  if(value===undefined)return undefined;
  const index=value.indexOf('=');assert(index>0,'Use --link-store collection=/absolute/path.sqlite');
  return {collection:linkCollection(value.slice(0,index)),file:value.slice(index+1),...options};
}
const isRecord=(value: unknown): value is Record<string,unknown>=>value!==null && typeof value==='object' && !Array.isArray(value);
export async function runLinkCommand(action: string|undefined,values: LinkCommandValues,print: Print): Promise<void> {
  assert(action!==undefined && ['init','create','get','list','update','delete','export','import','api'].includes(action),'Use links init/create/get/list/update/delete/export/import/api');
  assert(values.store,'Links commands require --store with an absolute database path');
  const collection=linkCollection(values.collection||'links');
  const poolOptions=linkPoolOptions(values);
  // Authentication material is checked before creating or opening a writable store.
  if(values['auth-file'] && values['token-file'])throw new Error('Use either --auth-file or --token-file');
  const project=values.project??'.';
  const authorize=action==='api' && values['auth-file']?await managementPolicy(values['auth-file'],project):undefined;
  if(authorize)await authorize('');
  const token=action==='api' && !authorize?await loadLinkToken(values['token-file'],project):undefined;
  const storeOptions: LinkStoreOptions={file:values.store,project:values.project,readOnly:['get','list','export'].includes(action),...poolOptions};
  const store=await openLinkStore(storeOptions);
  try {
    if(action==='api'){
      const port=Number(values.port);assert(values.port!==undefined&&/^\d+$/.test(values.port)&&port>=0&&port<=65535,'Invalid port');
      const api=await startLinkApi({store,collection,token,authorize,host:values.host,port});
      print({event:'link-management-listening',address:api.address.address,port:api.address.port,collection});
      await new Promise<void>(resolve=>{
        const stop=()=>{process.off('SIGINT',stop);process.off('SIGTERM',stop);resolve();};
        process.once('SIGINT',stop);process.once('SIGTERM',stop);
      });
      await api.close();return;
    }
    let value: unknown;
    if(action==='init')value={event:'link-store-initialized'};
    if(action==='get'){value=await store.get(collection,values.code??'');assert(value,'Link not found');}
    if(action==='list')value=await store.list(collection,{limit:values.limit===undefined?100:Number(values.limit),after:values.after||''});
    if(action==='create'||action==='update'){
      assert(values.destination,'Use --destination with an HTTP(S) URL');
      assert(values.enabled===undefined||['true','false'].includes(values.enabled),'Enabled must be true or false');
      const data={url:values.destination,status:values.status===undefined?302:Number(values.status),enabled:values.enabled!=='false',expires:values.expires||null};
      value=action==='create'?await store.create(collection,data,values.code):await store.update(collection,values.code??'',data,Number(values['if-version']));
    }
    if(action==='delete')value={deleted:await store.delete(collection,values.code??'',Number(values['if-version']))};
    // Export and import stream their own NDJSON; they never buffer the store.
    if(action==='export'){await exportLinks(store,values,print);return;}
    if(action==='import'){print(await importLinks(store,values));return;}
    print(value);
  }finally{await store.close();}
}

// A restorable point-in-time snapshot: a header line carrying format, schema and
// snapshot identity, one line per record, and a completion line with the record
// count and a digest over every preceding line. Operator data goes to stdout
// deliberately; redirect it to a file only operators can read.
async function exportLinks(store: LinkStore,values: LinkCommandValues,print: Print): Promise<void> {
  const pageSize=values['page-size']===undefined?100:Number(values['page-size']);
  assert(Number.isInteger(pageSize)&&pageSize>=1&&pageSize<=100,'Use --page-size 1–100');
  const hash=createHash('sha256');
  const line=(value: unknown)=>{hash.update(JSON.stringify(value)+'\n');print(value);};
  const summary=await store.exportSnapshot(
    {collection:values.collection===undefined?undefined:linkCollection(values.collection),pageSize},
    {
      onHeader:header=>line({event:'link-export-begin',format:header.format,schemaVersion:header.schemaVersion,
        applicationId:header.applicationId,collection:header.collection,revision:header.revision,
        records:header.records,generatedAt:header.generatedAt}),
      onRecords:records=>{for(const record of records)line({record});},
    });
  print({event:'link-export-complete',exported:summary.exported,sha256:hash.digest('hex')});
}
async function importLinks(store: LinkStore,values: LinkCommandValues): Promise<object> {
  assert(typeof values.input==='string' && isAbsolute(values.input),'Use --input with an absolute export file path');
  const hash=createHash('sha256');
  const counts=new Map<string,number>();let imported=0,header: Record<string,unknown>|undefined,complete: Record<string,unknown>|undefined;
  const stream=createReadStream(values.input,{encoding:'utf8'});
  try {
    for await (const text of createInterface({input:stream,crlfDelay:Infinity})) {
      if(text==='')continue;
      assert(Buffer.byteLength(text)<=65536,'Export line exceeds 65536 bytes');
      assert(!complete,'Export file has content after its completion line');
      let parsed: unknown;try{parsed=JSON.parse(text);}catch{throw new Error('Export file is not valid NDJSON');}
      const line: Record<string,unknown>=isRecord(parsed)?parsed:{};
      if(line.event==='link-export-complete'){
        assert(header,'Export file has no header line');
        assert(hash.copy().digest('hex')===line.sha256,'Export digest does not match its content');
        assert(line.exported===imported,'Export record count does not match its record lines');
        complete=line;continue;
      }
      hash.update(text+'\n');
      if(line.event==='link-export-begin'){
        assert(!header && !imported,'Export file has more than one header line');
        assert(line.format==='urlcode.links.v1' && line.schemaVersion===1 && line.applicationId===1431456835,
          'Unsupported export format, schema version or store identity');
        header=line;continue;
      }
      assert(header,'Export records precede the header line');
      assert(isRecord(line.record),'Unsupported export line');
      const collection=linkCollection(line.record.collection),code=linkCode(line.record.code);
      // Restore into empty collections only: this never overwrites live records.
      if(!counts.has(collection)){
        assert((await store.list(collection,{limit:1})).length===0,'Target collection already contains records');
        counts.set(collection,0);
      }
      await store.create(collection,linkData({url:line.record.url,status:line.record.status,enabled:line.record.enabled,expires:line.record.expires}),code);
      counts.set(collection,(counts.get(collection)??0)+1);imported++;
    }
  } finally { stream.destroy(); }
  assert(complete,'Export file has no completion line; it is truncated');
  // Versions and audit revisions are reassigned by this store, so management
  // ETags taken against the exported database do not survive a restore.
  return {event:'link-import-complete',imported,collections:Object.fromEntries(counts),
    source:{revision:header?.revision,generatedAt:header?.generatedAt,sha256:complete.sha256},versionsReassigned:true};
}
