import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir,cpus,totalmem} from 'node:os';
import {join} from 'node:path';
import {importBulkProject} from '../src/bulk.ts';
import {createRuntime} from '../src/runtime.ts';
import type {Runtime} from '../src/runtime.ts';

const count=Number(process.argv[2]||1000);
if(![1000,10000,100000].includes(count))throw new Error('Dataset must be 1000, 10000 or 100000');
const root=await mkdtemp(join(tmpdir(),'urlcode-bulk-benchmark-'));let runtime: Runtime|undefined;
const result: Record<string,unknown>={node:process.version,platform:process.platform,arch:process.arch,cpu:cpus()[0]?.model,systemMemoryGiB:Math.round(totalmem()/2**30),routes:count,shardSize:1000};
let phase='conversion';
try {
  const input='path,url,status\n'+Array.from({length:count},(_,i)=>`/r${i},https://example.com/items/${i},302`).join('\n')+'\n';
  const started=performance.now();
  const imported=await importBulkProject(input,'csv',join(root,'project'),{source:'synthetic.csv'});
  if(!imported.ok)throw new Error(imported.diagnostics.map(item=>item.message).join('; '));
  result.conversionMs=Math.round(performance.now()-started);result.includeFiles=imported.files.filter(file=>file.routeCount>0).length;
  result.afterConversionRssMiB=Math.round(process.memoryUsage().rss/2**20);
  phase='activation';const activation=performance.now();runtime=await createRuntime(join(root,'project'));
  result.activationMs=Math.round(performance.now()-activation);result.afterActivationRssMiB=Math.round(process.memoryUsage().rss/2**20);result.afterActivationHeapMiB=Math.round(process.memoryUsage().heapUsed/2**20);
  phase='lookup';const requests=5000,times: number[]=[];
  for(let i=0;i<requests+100;i++){
    const index=(i*7919)%count,began=performance.now();const reply=await runtime.handle({target:`/r${index}`});
    if(reply.status!==302||!reply.headers.some(([key,value])=>key.toLowerCase()==='location'&&value===`https://example.com/items/${index}`))throw new Error('Incorrect redirect');
    if(i>=100)times.push(performance.now()-began);
  }
  times.sort((a,b)=>a-b);result.requests=requests;result.concurrency=1;result.lookup='Runtime.handle (no socket transport)';
  result.p50Ms=times[Math.floor(times.length*.5)];result.p95Ms=times[Math.floor(times.length*.95)];result.ok=true;
}catch(error){result.ok=false;result.failedPhase=phase;result.error=error instanceof Error?error.message:'Benchmark failed';process.exitCode=1;}
finally{await runtime?.close();await rm(root,{recursive:true,force:true});console.log(JSON.stringify(result));}
