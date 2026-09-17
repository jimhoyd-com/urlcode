import {createHash} from 'node:crypto';
import {stringify} from 'yaml';
import {importRoutes} from './interchange.ts';
import type {ConversionDiagnostic} from './interchange.ts';
import {publishAuthoringProject} from './authoring-files.ts';
import {assert} from './errors.ts';

export type BulkFormat='csv'|'json'|'yaml';
export interface BulkFilePlan {path: string;routeCount: number;firstPath?: string;lastPath?: string}
export interface BulkImportReport {
  ok: boolean;dryRun: boolean;output?: string;routeCount: number;diagnostics: ConversionDiagnostic[];
  files: BulkFilePlan[];source: {name: string;format: BulkFormat;sha256: string};
}
/** Import ordinary redirect rows into small, portable include files. There is no
 * merge mode: duplicate rules and existing output directories are refused. */
export async function importBulkProject(text: string,format: BulkFormat,output: string,{dryRun=false,source='<input>'}: {dryRun?: boolean|undefined;source?: string|undefined}={}): Promise<BulkImportReport> {
  assert(['csv','json','yaml'].includes(format),'Bulk input must be csv, json or yaml');
  assert(source.length<=1024 && !/[\u0000-\u001f\u007f]/u.test(source),'Invalid bulk provenance source name');
  const provenance={name:source,format,sha256:createHash('sha256').update(text).digest('hex')};
  const converted=await importRoutes({text,format,source});
  const report: BulkImportReport={ok:converted.ok,dryRun,routeCount:converted.routeCount,diagnostics:converted.diagnostics,files:[],source:provenance};
  if(!converted.ok || !converted.document)return report;
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
