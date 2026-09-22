import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { startServer } from '../packages/core/src/server.ts';
import { createVercelHandler } from '../packages/core/src/vercel.ts';
import { createLambdaHandler } from '../packages/core/src/aws.ts';
import { buildCloudflare } from '../packages/core/src/build-cloudflare.ts';
import { createFetchHandler } from '../packages/core/src/cloudflare.ts';
import type { Artifact, Validators } from '../packages/core/src/cloudflare.ts';
import { providerConformanceCases, runProviderConformance, verifyProviderDeployment } from '../packages/core/src/provider-verification.ts';
import type { ProviderTransport, ProviderProbe } from '../packages/core/src/provider-verification.ts';
import { request } from './helpers.ts';
const project=fileURLToPath(new URL('../examples/provider-conformance',import.meta.url));
const answer=(probe:ProviderProbe)=>({status:probe.expected.status,headers:probe.expected.headers??{},body:probe.expected.body??''});
test('the versioned fixture passes self-hosted, AWS, Vercel and built Cloudflare adapters locally',async t=>{
  const hosted=await startServer({project,port:0,log:()=>{}});t.after(()=>hosted.close());
  const handler=createVercelHandler({project,environment:{}});
  const vercel=http.createServer((req,res)=>{void handler(req,res).catch(()=>res.destroy());});
  await new Promise<void>(resolve=>vercel.listen(0,'127.0.0.1',resolve));
  t.after(()=>{vercel.closeAllConnections();return new Promise<void>(resolve=>vercel.close(()=>resolve()));});
  const address=vercel.address();assert.ok(address&&typeof address==='object');
  const lambda=createLambdaHandler({project,environment:{}});
  const out=await mkdtemp(join(tmpdir(),'urlcode-provider-conformance-'));t.after(()=>rm(out,{recursive:true,force:true}));
  await buildCloudflare(project,{out});
  const artifact=((await import(pathToFileURL(join(out,'artifact.js')).href))as{default:Artifact}).default;
  const validators=(await import(pathToFileURL(join(out,'validators.js')).href))as Validators;
  const cloudflare=createFetchHandler(artifact,validators);
  const httpTransport=(app:{address:{port:number}}):ProviderTransport=>async probe=>{
    const result=await request(app,probe.path,{method:probe.method,headers:probe.headers,body:probe.body});
    const headers:Record<string,string>={};for(const [name,value]of Object.entries(result.headers))if(value!==undefined)headers[name]=Array.isArray(value)?value.join(', '):value;
    return {status:result.status,headers,body:result.body};
  };
  const transports:Record<'self-hosted'|'vercel'|'aws'|'cloudflare',ProviderTransport>={
    'self-hosted':httpTransport(hosted),vercel:httpTransport({address}),
    aws:async probe=>{const [rawPath,rawQueryString='']=probe.path.split('?');const result=await lambda({version:'2.0',rawPath,rawQueryString,requestContext:{http:{method:probe.method}},headers:probe.headers,body:probe.body});return{status:result.statusCode,headers:result.headers,body:Buffer.from(result.body,'base64').toString('utf8')};},
    cloudflare:async probe=>{const result=await cloudflare(new Request(`https://example.test${probe.path}`,{method:probe.method,headers:probe.headers,...(probe.body===undefined?{}:{body:probe.body})}));return{status:result.status,headers:Object.fromEntries(result.headers),body:await result.text()};}
  };
  for(const target of ['self-hosted','aws','vercel','cloudflare']as const){
    const report=await runProviderConformance(target,transports[target],{release:'synthetic-test'});
    assert.equal(report.pass,true,JSON.stringify(report.findings.filter(f=>!f.pass)));assert.equal(report.requests,12);assert.equal(report.evidence,'local-adapter');assert.equal(report.providerVerification,'unverified');assert.equal(report.origin,null);assert.match(report.fixtureSha256,/^[a-f0-9]{64}$/);
  }
});
test('evidence failures do not expose arbitrary response body or header data',async()=>{
  const report=await runProviderConformance('aws',async()=>({status:200,headers:{authorization:'PRIVATE'},body:'PRIVATE'}));
  assert.equal(report.pass,false);assert.ok(report.findings.some(f=>!f.pass));assert.ok(!JSON.stringify(report).includes('PRIVATE'));assert.equal(report.providerVerification,'unverified');
});
test('local adapters are bounded by deadlines and response size',async()=>{
  let aborted=0;
  const timeout=await runProviderConformance('vercel',async(_probe,signal)=>new Promise(()=>{signal.addEventListener('abort',()=>aborted++);}),{timeoutMs:50});
  assert.equal(timeout.pass,false);assert.equal(aborted,12);
  const oversized=await runProviderConformance('cloudflare',async probe=>({...answer(probe),body:'x'.repeat(65537)}));assert.equal(oversized.pass,false);assert.ok(oversized.findings.every(f=>f.failures.includes('transport, deadline or response-limit failure')));
});
test('deployment verifier rejects ambiguous or unsafe target forms before any request',async()=>{
  for(const origin of ['http://example.test','https://user:secret@example.test','https://example.test/path','https://example.test/?q=1','https://example.test/#fragment','https://example.test/../','https://example.test\\@other.test'])await assert.rejects(verifyProviderDeployment('aws',origin));
  await assert.rejects(verifyProviderDeployment('aws','https://example.test',{timeoutMs:0}));
  await assert.rejects(runProviderConformance('aws',async p=>answer(p),{release:'bad\nidentity'}));
});
test('TLS failures are recorded without disabling certificate or handshake verification',async t=>{
  const server=https.createServer();server.on('tlsClientError',()=>{});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise<void>(resolve=>server.close(()=>resolve())));
  const address=server.address();assert.ok(address&&typeof address==='object');
  const report=await verifyProviderDeployment('self-hosted',`https://127.0.0.1:${address.port}`,{timeoutMs:100});
  assert.equal(report.pass,false);assert.equal(report.evidence,'deployment-http');assert.equal(report.providerVerification,'observed');assert.ok(report.findings.every(f=>f.observedStatus===null));
});
test('case copies cannot mutate the fixed verification suite',()=>{
  const first=providerConformanceCases();first[0]!.path='/unsafe';first[0]!.expected.status=500;
  assert.equal(providerConformanceCases()[0]!.expected.status,302);assert.equal(providerConformanceCases()[0]!.path,'/urlcode-conformance/redirect?ignored=secret');
});
