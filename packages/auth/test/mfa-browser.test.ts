import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { passkeyScript } from '../src/auth-ui.ts';

test('second-factor browser proof stays in its submitting form and does not trigger primary navigation',async()=>{
 const hidden={value:''},status={textContent:''},sent:{path:string;body:Record<string,unknown>;csrf:string}[]=[];
 let callback:(()=>Promise<void>)|undefined,navigated=false;
 const form={querySelector:(selector:string)=>selector.includes('csrf')?{value:'form-csrf'}:selector.includes('secondFactorToken')?hidden:selector.includes('data-passkey-status')?status:null};
 const button={disabled:false,dataset:{passkey:'second-factor',base:'/account',failed:'Failed',unavailable:'Unavailable',cancelled:'Cancelled',confirmed:'Confirmed'},closest:()=>form,addEventListener:(_event:string,fn:()=>Promise<void>)=>{callback=fn;}};
 const context={document:{querySelectorAll:()=>[button],querySelector:()=>{throw new Error('Wrong form selected');}},window:{PublicKeyCredential:{}},navigator:{credentials:{get:async()=>({id:'credential',rawId:new Uint8Array([1]).buffer,type:'public-key',getClientExtensionResults:()=>({}),response:{clientDataJSON:new Uint8Array([2]).buffer,authenticatorData:new Uint8Array([3]).buffer,signature:new Uint8Array([4]).buffer,userHandle:null}})}},fetch:async(path:string,init:{body:string;headers:Record<string,string>})=>{sent.push({path,body:JSON.parse(init.body),csrf:init.headers['x-csrf-token']!});return {ok:true,json:async()=>path.endsWith('/options')?{flowId:'flow',options:{challenge:'AQ'}}:{secondFactorToken:'opaque-proof'}};},location:{assign:()=>{navigated=true;}},Uint8Array,atob,btoa,Error};
 vm.runInNewContext(passkeyScript,context);assert.ok(callback);await callback();
 assert.equal(hidden.value,'opaque-proof');assert.equal(status.textContent,'Confirmed');assert.equal(navigated,false);assert.equal(button.disabled,false);
 assert.deepEqual(sent.map(item=>item.path),['/account/second-factor/options','/account/second-factor/verify']);assert.ok(sent.every(item=>item.csrf==='form-csrf'));
 assert.deepEqual(Object.keys(sent[1]!.body).sort(),['flowId','response']);
});
