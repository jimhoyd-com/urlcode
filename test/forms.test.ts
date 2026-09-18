import test from 'node:test';
import assert from 'node:assert/strict';
import {hiddenField,postForm,withDeadline} from '../src/index.ts';
test('hiddenField and postForm escape names, values and labels and reject unsafe actions',()=>{
 assert.equal(hiddenField('token','a"b<c>'),'<input type="hidden" name="token" value="a&quot;b&lt;c&gt;">');
 assert.throws(()=>hiddenField('bad" name','x'));
 const html=postForm({action:'/auth/login?lang=fr',csrf:'t"<',fields:hiddenField('email','a@b'),label:'<Sign in>'});
 assert.equal(html,'<form class="ui-stack" method="post" action="/auth/login?lang=fr"><input type="hidden" name="csrf" value="t&quot;&lt;"><input type="hidden" name="email" value="a@b"><div class="ui-actions"><button data-slot="button" type="submit">&lt;Sign in&gt;</button></div></form>');
 for(const action of ['javascript:alert(1)','//evil.test','/bad path','/x"y','','/\\evil','#'.repeat(3000)])assert.throws(()=>postForm({action,csrf:'c',fields:'',label:'Go'}),/safe form action/);
 assert.throws(()=>postForm({action:'/x',csrf:'c',fields:'',label:'Go',className:'bad" onclick'}));
});
test('postForm supports the destructive variant, an icon and a class name',()=>{
 const html=postForm({action:'/admin/delete',csrf:'c',fields:'',label:'Delete',destructive:true,icon:'log-out',className:'ui-form-grid'});
 assert.match(html,/^<form class="ui-form-grid"/);assert.match(html,/<button class="ui-button-destructive" data-slot="button" type="submit"><svg/);
 assert.doesNotMatch(postForm({action:'/x',csrf:'c',fields:'',label:'Go'}),/ui-button-destructive|<svg/);
});
test('withDeadline resolves, times out with the message, aborts the signal and clears the timer',async()=>{
 assert.equal(await withDeadline(async()=>'ok',1000,'late'),'ok');
 let signal:AbortSignal|undefined;
 await assert.rejects(withDeadline(s=>{signal=s;return new Promise(()=>{});},5,'late'),{message:'late'});
 assert.equal(signal?.aborted,true);
 const timers=new Set<object>(),original=globalThis.setTimeout,originalClear=globalThis.clearTimeout;
 globalThis.setTimeout=((...args:Parameters<typeof setTimeout>)=>{const t=original(...args);timers.add(t);return t;}) as typeof setTimeout;
 globalThis.clearTimeout=((t:Parameters<typeof clearTimeout>[0])=>{timers.delete(t as object);return originalClear(t);}) as typeof clearTimeout;
 try{await withDeadline(async()=>1,10_000,'late');await assert.rejects(withDeadline(()=>Promise.reject(new Error('inner')),10_000,'late'),{message:'inner'});}finally{globalThis.setTimeout=original;globalThis.clearTimeout=originalClear;}
 assert.equal(timers.size,0);
 await assert.rejects(withDeadline(async()=>1,-1,'late'),/Invalid deadline/);
});
