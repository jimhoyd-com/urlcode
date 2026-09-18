import { open, unlink } from 'node:fs/promises';
import { extname } from 'node:path';
import { loadDocument } from './config.ts';
import { importRoutes, exportRoutes } from './interchange.ts';
import type { InterchangeFormat, ConversionReport } from './interchange.ts';
import { assert } from './errors.ts';
interface InterchangeCliOptions { project:string; target?:string|undefined; format?:string|undefined; out?:string|undefined; report?:string|undefined; dryRun?:boolean|undefined; acceptProviderDifferences?:boolean|undefined }
export async function readConversionInput(file:string):Promise<string> {
  const handle=await open(file,'r');
  try {
    const stat=await handle.stat();assert(stat.isFile()&&stat.size<=32*1024*1024,'Conversion input must be a regular file of at most 32 MiB');
    const buffer=Buffer.alloc(stat.size+1);let size=0;
    while(size<buffer.length){const result=await handle.read(buffer,size,buffer.length-size,null);if(!result.bytesRead)break;size+=result.bytesRead;}
    assert(size<=stat.size,'Conversion source grew during read');
    return new TextDecoder('utf-8',{fatal:true}).decode(buffer.subarray(0,size));
  } finally {await handle.close();}
}
export async function runInterchange(command:'import'|'export',args:string[],options:InterchangeCliOptions):Promise<{report:ConversionReport; text:string}> {
  assert(!options.report||options.report==='json','Use --report json');
  const explicit=args.length===2?args[0]:undefined;
  const file=args.length===2?args[1]:args[0];
  assert(command==='import'?!!file&&args.length<=2:args.length===0,'Invalid conversion arguments');
  const format=(options.format??(command==='export'?options.target:explicit??extname(file!).slice(1))) as InterchangeFormat;
  let report:ConversionReport;
  if(command==='import') report=await importRoutes({format,text:await readConversionInput(file!),source:file!,acceptProviderDifferences:options.acceptProviderDifferences===true});
  else {
    const loaded=await loadDocument(options.project);
    const {includes:_includes,...document}=loaded.document;
    report=await exportRoutes({format,document:{...document,routes:loaded.routes},source:options.project,acceptProviderDifferences:options.acceptProviderDifferences===true});
  }
  if(report.ok&&options.out&&!options.dryRun) {
    const handle=await open(options.out,'wx',0o600);
    try {await handle.writeFile(report.output!);await handle.sync();}
    catch(error){await handle.close();await unlink(options.out);throw error;}
    await handle.close();
  }
  // Acknowledged non-lossless conversion always carries a report, even when
  // output is written to a file; warnings cannot disappear into raw stdout.
  const text=options.report==='json'||options.dryRun||options.out||!report.ok||!report.lossless
    ? JSON.stringify(report)+'\n' : report.output!;
  return {report,text};
}
