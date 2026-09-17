import test from 'node:test';
import assert from 'node:assert/strict';
import type { Runtime } from '@jimhoyd/urlcode';
import type { AuthPrincipal } from '@jimhoyd/urlcode-auth';
import { withSupportBanner } from '../src/support-banner.ts';
const token='a'.repeat(43),principal={id:'target',email:'target@example.test',emailVerified:true,roles:[],permissions:[],sessionId:'session',authenticatedAt:0,impersonatorId:'operator'} satisfies AuthPrincipal;
test('support wrapper marks every HTML response and suppresses conditional/compressed/cache delivery',async()=>{
    let incoming:Headers|undefined;
    const runtime={handle:async(request:{headers?:Headers})=>{incoming=request.headers;return {status:200,headers:[['content-type','text/html'],['etag','old'],['cache-control','public'],['content-length','5']] as [string,string][],contentLength:5,body:'<!doctype html><html><body><p>App</p></body></html>'};},get healthy(){return true;}} as unknown as Runtime;
    const wrapped=withSupportBanner(runtime,{service:{authenticate:async value=>value===token?principal:null},message:'Support <script>',endLabel:'End & return'});
    const result=await wrapped.handle({target:'/any/app/page',headers:new Headers({cookie:'__Host-urlcode-session='+token,'if-none-match':'old','accept-encoding':'gzip'})});
    assert.equal(wrapped.healthy,true);assert.equal(incoming!.has('if-none-match'),false);assert.equal(incoming!.has('accept-encoding'),false);
    assert.match(Buffer.from(result.body as Uint8Array).toString(),/<body><aside role="alert"/);assert.match(Buffer.from(result.body as Uint8Array).toString(),/Support &lt;script&gt;/);
    assert.ok(!result.headers.some(([key])=>['etag','content-length'].includes(key)));assert.equal(result.contentLength,undefined);assert.ok(result.headers.some(([key,value])=>key==='cache-control'&&value==='no-store'));
});
test('support wrapper leaves ordinary responses intact and fails closed for undecoratable HTML',async()=>{
    const result={status:200,headers:[['content-type','text/html'],['content-encoding','gzip']] as [string,string][],body:new Uint8Array([0xff])};
    const runtime={handle:async()=>result} as unknown as Runtime;
    const wrapped=withSupportBanner(runtime,{service:{authenticate:async()=>principal}});
    assert.equal(await wrapped.handle({target:'/'}),result);
    const guarded=await wrapped.handle({target:'/',headers:new Headers({cookie:'__Host-urlcode-session='+token})});assert.equal(guarded.status,409);assert.match(String(guarded.body),/urlcode-support-banner/);
});

test('support wrapper rejects cached 304 responses and decorates HTML error pages',async()=>{
 const request={target:'/',headers:new Headers({cookie:'__Host-urlcode-session='+token})};
 for(const status of [304,500]) {
  const runtime={handle:async()=>({status,headers:[['content-type','text/html']],body:'<body>Error</body>'})} as unknown as Runtime;
  const response=await withSupportBanner(runtime,{service:{authenticate:async()=>principal}}).handle(request);
  assert.equal(response.status,status===304?409:500);
  assert.match(typeof response.body==='string'?response.body:Buffer.from(response.body!).toString(),/urlcode-support-banner/);
 }
});
