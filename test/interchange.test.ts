import test from 'node:test';
import assert from 'node:assert/strict';
import { importRoutes, exportRoutes } from '../src/interchange.ts';
import type { InterchangeFormat } from '../src/interchange.ts';
import type { ProjectDocument } from '../src/types.ts';
const document:ProjectDocument={version:'1',routes:{'/z':{redirect:{url:'https://example.test/z',status:308}},'/a':{redirect:{url:'https://example.test/a?x=a,b',status:301}}}};
test('bulk formats round-trip and sort deterministically',async()=>{
  for(const format of ['csv','json','yaml'] as const){
    const exported=await exportRoutes({format,document});assert.equal(exported.ok,true);assert.equal(exported.lossless,true);
    const imported=await importRoutes({format,text:exported.output!,source:'fixture'});assert.equal(imported.ok,true);assert.deepEqual(JSON.parse(JSON.stringify(imported.document)),{version:'1',routes:{'/a':document.routes['/a'],'/z':document.routes['/z']}});
    assert.equal((await exportRoutes({format,document:imported.document!})).output,exported.output);
  }
});
test('provider reports require explicit acknowledgement and never claim exact parity',async()=>{
  for(const format of ['netlify','cloudflare','vercel','netlify-toml'] as const){
    const rejected=await exportRoutes({format,document});assert.equal(rejected.ok,false);assert.equal(rejected.output,undefined);
    const exported=await exportRoutes({format,document,acceptProviderDifferences:true});assert.equal(exported.ok,true);assert.equal(exported.lossless,false);assert.equal(exported.diagnostics[0]?.code,'provider-semantics');
    const imported=await importRoutes({format,text:exported.output!,acceptProviderDifferences:true});assert.equal(imported.ok,true);assert.equal(imported.lossless,false);assert.deepEqual(imported.document,exported.document);
  }
});
test('provider default status codes match the source format',async()=>{
  for(const [format,text,status]of [['netlify','/a https://example.test',301],['cloudflare','/a https://example.test',302],['netlify-toml','[[redirects]]\nfrom = "/a"\nto = "https://example.test"',301]] as const){
    assert.equal((await importRoutes({format,text,acceptProviderDifferences:true})).document?.routes['/a']?.redirect?.status,status);
  }
});
test('duplicate rows preserve provenance and produce no partial output',async()=>{
  const result=await importRoutes({format:'csv',source:'routes.csv',text:'path,url,status\n/a,https://example.test,301\n/a,https://example.test/other,302\n'});
  assert.equal(result.ok,false);assert.equal(result.output,undefined);assert.equal(result.document,undefined);assert.deepEqual(result.diagnostics.find(d=>d.code==='duplicate-path'),{severity:'error',code:'duplicate-path',source:'routes.csv',row:3,path:'/a',message:'Duplicate route path; no rule is overwritten'});
});
test('CSV quotes are parsed without dropping columns or malformed data',async()=>{
  assert.equal((await importRoutes({format:'csv',text:'path,url,status\r\n/a,"https://example.test/?a=x,y",302\r\n'})).ok,true);
  for(const text of ['path,url,status\n/a,"https://example.test,302','path,url,status\n/a,"https://example.test"oops,302','path,url,status\n/a,https://example.test,302,extra'])assert.equal((await importRoutes({format:'csv',text})).ok,false);
});
test('invalid or unsupported semantics reject even after acknowledgment',async()=>{
  const fixtures:[InterchangeFormat,string][]=[
    ['netlify','/a https://example.test 200'],['netlify','/a https://example.test 301!'],['cloudflare','/* https://example.test/:splat 301'],
    ['vercel','{"redirects":[{"source":"/a","destination":"https://example.test","permanent":true,"has":[]}]}'],
    ['vercel','{"redirects":[{"source":"/a","destination":"https://example.test","permanent":true,"statusCode":301}]}'],
    ['netlify-toml','[build]\ncommand = "echo unsafe"'],['netlify-toml','[[redirects]]\nfrom="/a"\nto="https://example.test"\nforce=true'],
    ['json','[{"path":"/a","url":"https://user:password@example.test"}]'],['json','[{"path":"/a","url":"javascript:alert(1)"}]'],
    ['json','[{"path":"/a","url":"https://example.test/{x}"}]'],['json','[{"path":"/_urlcode/health","url":"https://example.test"}]'],
    ['json','[{"path":"/../a","url":"https://example.test"}]'],['json','[{"path":"/a","url":"https://example.test","__proto__":{}}]'],
    ['json','[{"path":"/a","path":"/b","url":"https://example.test"}]'],['yaml','- &row {path: /a, url: "https://example.test"}\n- *row'],
  ];
  for(const [format,text]of fixtures){const report=await importRoutes({format,text,acceptProviderDifferences:true});assert.equal(report.ok,false,`${format}: ${text}`);assert.equal(report.output,undefined);}
});
test('export refuses bindings, code, policy and project metadata before compilation',async()=>{
  for(const config of [{redirect:{url:'https://example.test'},secrets:{X:{secret:'private'}}},{function:{source:'does-not-exist.mjs'}},{redirect:{url:'https://example.test'},methods:['POST']},{redirect:{url:'https://example.test',query:{pass:['q']}}}]){
    const result=await exportRoutes({format:'netlify',document:{version:'1',routes:{'/a':config}},acceptProviderDifferences:true});assert.equal(result.ok,false);assert.equal(result.output,undefined);
  }
  assert.equal((await exportRoutes({format:'json',document:{...document,includes:['ignored.yaml']}})).ok,false);
});
test('invalid route diagnostic identifies the file and physical CSV row without echoing credentials',async()=>{
  const result=await importRoutes({format:'csv',source:'data.csv',text:'path,url,status\n/a,https://private:credential@example.test,301\n'});
  assert.equal(result.diagnostics[0]?.row,2);assert.equal(result.diagnostics[0]?.source,'data.csv');assert.ok(!JSON.stringify(result).includes('credential'));
});
test('large literal import uses normal compilation and enforces source bounds',async()=>{
  const result=await importRoutes({format:'json',text:JSON.stringify(Array.from({length:1000},(_,i)=>({path:`/r${i}`,url:'https://example.test'})))});assert.equal(result.ok,true);assert.equal(result.routeCount,1000);
  assert.equal((await importRoutes({format:'json',text:' '.repeat(32*1024*1024+1)})).ok,false);
});
test('provider syntax and Cloudflare platform limits cannot be acknowledged away',async()=>{
  assert.equal((await importRoutes({format:'cloudflare',text:'/a https://example.test/:splat 301',acceptProviderDifferences:true})).ok,false);
  const text=Array.from({length:2001},(_,i)=>`/a${i} https://example.test 301`).join('\n');
  const result=await importRoutes({format:'cloudflare',text,acceptProviderDifferences:true});assert.equal(result.ok,false);assert.equal(result.output,undefined);
});
test('late invalid bulk rows retain provenance through bounded compiler diagnostics',async()=>{
  const rows=Array.from({length:1000},(_,i)=>({path:`/p${i}`,url:i===999?'https://secret:credential@example.test':'https://example.test'}));
  const result=await importRoutes({format:'json',source:'rows.json',text:JSON.stringify(rows)});assert.equal(result.ok,false);assert.equal(result.diagnostics[0]?.row,1000);assert.equal(result.diagnostics[0]?.source,'rows.json');
});
test('conversion counts distinguish returned output, runtime requirements and known invalid rows',async()=>{
  const mixed=await exportRoutes({format:'json',document:{version:'1',routes:{'/a':{redirect:{url:'https://example.test'}},'/code':{respond:{text:'runtime required'}}}}});
  assert.equal(mixed.ok,false);assert.equal(mixed.output,undefined);assert.equal(mixed.counts.convertedRoutes,0);assert.equal(mixed.counts.nativeEquivalentRoutes,0);assert.equal(mixed.counts.runtimeRequiredRoutes,1);assert.equal(mixed.counts.fullyScanned,true);
  const native=await exportRoutes({format:'json',document});assert.equal(native.counts.nativeEquivalentRoutes,2);assert.equal(native.counts.convertedRoutes,2);
  const provider=await exportRoutes({format:'netlify',document,acceptProviderDifferences:true});assert.equal(provider.counts.convertedRoutes,2);assert.equal(provider.counts.nativeEquivalentRoutes,0);assert.equal(provider.counts.providerDifferenceRoutes,2);
  const invalid=await importRoutes({format:'json',text:'[{"path":"/a","url":"https://example.test"},{"path":"/*","url":"https://example.test"}]'});assert.equal(invalid.counts.unsupportedRows,1);assert.equal(invalid.counts.convertedRoutes,0);assert.equal(invalid.counts.fullyScanned,true);
  const syntax=await importRoutes({format:'json',text:'['});assert.equal(syntax.counts.fullyScanned,false);
});
