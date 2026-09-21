/**
 * Client behaviour of the data-bound list and form screen (`crud`). Served as a
 * content-hashed kit asset and loaded with the page nonce, so it needs no inline
 * script. It builds every node with `createElement`, `textContent` and `value`
 * and never assigns markup, so record values cannot become HTML. The source
 * avoids backticks, template placeholders and backslashes so it can live in a
 * template literal unchanged.
 *
 * State lives in this closure and every render rebuilds the list from it. Two
 * rules follow from that and are what the tests pin down:
 *  - text typed into an edit row is kept in a per-record draft, so a reload or
 *    any other re-render restores it (and focus and caret) instead of resetting
 *    the row to the stored value;
 *  - a checkbox toggle changes local state first for a fast response and is
 *    rolled back to the previous value when the server refuses the update, so
 *    the screen never keeps a value the server does not hold.
 */
export const crudScript: string = `(function(){
'use strict';
function make(tag,cls,text){var e=document.createElement(tag);if(cls)e.className=cls;if(text!==undefined&&text!==null)e.textContent=String(text);return e;}
function start(root){
var api=root.getAttribute('data-api'),fields,copy,query=null;
try{fields=JSON.parse(root.getAttribute('data-fields'));copy=JSON.parse(root.getAttribute('data-copy'));var qa=root.getAttribute('data-query');if(qa)query=JSON.parse(qa);}catch(e){return;}
if(!api||api.charAt(0)!=='/'||api.charAt(1)==='/'||!Array.isArray(fields)||!copy)return;
if(query&&(!Array.isArray(query.s)||!Array.isArray(query.f)))query=null;
var readOnly=root.getAttribute('data-readonly')==='true';
var items=[],next=null,applied='',sortBox=null,filterBoxes={},drafts=new Map(),pending=new Set(),keys={},serial=0;
var status=make('div','ui-crud-status');status.setAttribute('role','status');
var form=make('form','ui-form ui-crud-form');form.setAttribute('novalidate','');
var list=make('ul','ui-crud-list');list.setAttribute('data-slot','crud-list');
var bar=make('div','ui-crud-bar');
var refresh=make('button','ui-button ui-button-ghost',copy.refresh);refresh.type='button';
var more=make('button','ui-button ui-button-ghost',copy.more);more.type='button';more.hidden=true;
bar.appendChild(refresh);bar.appendChild(more);
var qbar=make('div','ui-crud-query');
function say(kind,text){status.replaceChildren();if(!text)return;var box=make('div','ui-alert ui-alert-'+kind);box.setAttribute('role',kind==='error'?'alert':'status');box.appendChild(make('p',null,text));status.appendChild(box);}
function call(method,url,body){
var init={method:method,credentials:'same-origin',headers:{accept:'application/json'}};
if(body!==undefined){init.headers['content-type']='application/json';init.body=JSON.stringify(body);}
return fetch(url,init).then(function(res){
if(res.status===204)return {ok:true,status:204,data:null};
return res.json().then(function(data){return {ok:res.ok,status:res.status,data:data};},function(){return {ok:res.ok,status:res.status,data:null};});
},function(){return {ok:false,status:0,data:null};});
}
function fieldErrors(res){var out={};var f=res&&res.data&&res.data.error&&res.data.error.fields;if(f&&typeof f==='object')for(var k in f)if(typeof f[k]==='string')out[k]=f[k];return out;}
function urlOf(id){return api+'/'+encodeURIComponent(id);}
function initial(f){return f.d!==undefined?f.d:(f.k==='checkbox'?false:'');}
function control(f,value,id){
var input;
if(f.k==='select'){input=make('select','ui-input ui-select');if(!f.r){input.appendChild(option('',''));}for(var i=0;i<f.o.length;i++)input.appendChild(option(String(f.o[i]),String(f.o[i])));}
else if(f.k==='textarea'){input=make('textarea','ui-input ui-textarea');input.setAttribute('rows','3');}
else{input=make('input',f.k==='checkbox'?'ui-checkbox':'ui-input');input.type=f.k==='number'?'number':(f.k==='checkbox'?'checkbox':'text');if(f.k==='number')input.setAttribute('step',f.t==='integer'?'1':'any');}
input.setAttribute('id',id);input.setAttribute('name',f.n);
if(f.r&&f.k!=='checkbox')input.setAttribute('required','');
if(f.m&&f.k!=='select'&&f.k!=='number'&&f.k!=='checkbox')input.setAttribute('maxlength',String(f.m));
if(f.k==='checkbox')input.checked=value===true;else input.value=value===undefined||value===null?'':String(value);
return input;
}
function option(value,label){var o=make('option',null,label);o.setAttribute('value',value);return o;}
function raw(f,input){return f.k==='checkbox'?input.checked:input.value;}
function typed(f,value){
if(f.k==='checkbox')return value===true;
if(f.k==='number'){if(value===''||value===undefined||value===null)return undefined;return Number(value);}
if(value===''&&!f.r)return undefined;
return String(value);
}
function labelled(f,input,id,error){
var wrap=make('div','ui-field');wrap.setAttribute('data-slot','field');
if(f.k==='checkbox'){var l=make('label','ui-crud-check');l.setAttribute('for',id);l.appendChild(input);l.appendChild(make('span',null,f.l));wrap.appendChild(l);}
else{var lab=make('label','ui-label',f.l);lab.setAttribute('for',id);wrap.appendChild(lab);wrap.appendChild(input);}
var err=make('p','ui-error',error||'');err.hidden=!error;if(error)err.setAttribute('role','alert');wrap.appendChild(err);
if(error)input.setAttribute('aria-invalid','true');
return {wrap:wrap,err:err};
}
function param(f,input,id){var wrap=make('div','ui-field'),lab=make('label','ui-label',f.l);lab.setAttribute('for',id);wrap.appendChild(lab);wrap.appendChild(input);input.addEventListener('change',function(){load(false);});qbar.appendChild(wrap);}
if(query){
if(query.s.length){
sortBox=make('select','ui-input ui-select');sortBox.appendChild(option('','-'));
var up=String.fromCharCode(8593),down=String.fromCharCode(8595);
query.s.forEach(function(s){sortBox.appendChild(option(s.n,s.l+' '+up));sortBox.appendChild(option('-'+s.n,s.l+' '+down));});
sortBox.setAttribute('id','crud-sort');param({l:copy.sort},sortBox,'crud-sort');
}
query.f.forEach(function(f){
var g=f.k==='checkbox'?{n:f.n,l:f.l,k:'select',t:'string',r:false,o:['true','false']}:{n:f.n,l:f.l,k:f.k==='textarea'?'text':f.k,t:f.t,r:false,m:f.m,o:f.o};
var id='crud-filter-'+f.n,input=control(g,'',id);filterBoxes[f.n]=input;param(f,input,id);
});
}
var createInputs={},createErrors={},submit=make('button','ui-button ui-button-primary',copy.add);submit.type='submit';
fields.forEach(function(f){var id='crud-new-'+f.n;var input=control(f,initial(f),id);var l=labelled(f,input,id,'');createInputs[f.n]=input;createErrors[f.n]=l.err;form.appendChild(l.wrap);});
var actions=make('div','ui-form-actions');actions.appendChild(submit);form.appendChild(actions);
function showCreateErrors(errors){fields.forEach(function(f){var m=errors[f.n];createErrors[f.n].textContent=m||'';createErrors[f.n].hidden=!m;if(m)createErrors[f.n].setAttribute('role','alert');});}
form.addEventListener('submit',function(e){
if(e&&e.preventDefault)e.preventDefault();
if(submit.disabled)return;
var body={};fields.forEach(function(f){var v=typed(f,raw(f,createInputs[f.n]));if(v!==undefined)body[f.n]=v;});
submit.disabled=true;
call('POST',api,body).then(function(res){
submit.disabled=false;
if(res.ok&&res.data&&typeof res.data.id==='string'){items.push(res.data);showCreateErrors({});say('info','');fields.forEach(function(f){var i=createInputs[f.n];if(f.k==='checkbox')i.checked=initial(f)===true;else i.value=String(initial(f));});render();return;}
var errors=fieldErrors(res);showCreateErrors(errors);
say('error',Object.keys(errors).length?copy.invalid:copy.saveFailed);
});
});
function replace(record){for(var i=0;i<items.length;i++)if(items[i].id===record.id){items[i]=record;return;}}
function toggle(item,f,value){
var previous=item[f.n],body={};
item[f.n]=value;pending.add(item.id);say('info','');render();
body[f.n]=value;
call('PATCH',urlOf(item.id),body).then(function(res){
pending.delete(item.id);
if(res.ok&&res.data&&res.data.id===item.id)replace(res.data);
else{item[f.n]=previous;say('error',copy.saveFailed);}
render();
});
}
function save(item,draft){
var body={};
fields.forEach(function(f){var v=typed(f,draft.values[f.n]);if(v!==undefined)body[f.n]=v;});
pending.add(item.id);draft.errors={};render();
call('PATCH',urlOf(item.id),body).then(function(res){
pending.delete(item.id);
if(res.ok&&res.data&&res.data.id===item.id){drafts.delete(item.id);replace(res.data);say('info','');}
else{draft.errors=fieldErrors(res);say('error',Object.keys(draft.errors).length?copy.invalid:copy.saveFailed);}
render();
});
}
function remove(item){
pending.add(item.id);render();
call('DELETE',urlOf(item.id)).then(function(res){
pending.delete(item.id);
if(res.ok){items=items.filter(function(i){return i.id!==item.id;});drafts.delete(item.id);say('info','');}
else say('error',copy.deleteFailed);
render();
});
}
function button(label,cls,handler,disabled){var b=make('button','ui-button '+cls,label);b.type='button';b.disabled=disabled===true;b.addEventListener('click',handler);return b;}
function editRow(item,draft,busy){
var li=make('li','ui-crud-item ui-crud-editing');li.setAttribute('data-id',item.id);
fields.forEach(function(f){
var key=item.id+':'+f.n,id='crud-'+(serial++);
var input=control(f,draft.values[f.n],id);
input.setAttribute('data-ui-key',key);keys[key]=input;input.disabled=busy;
input.addEventListener('input',function(){draft.values[f.n]=raw(f,input);});
input.addEventListener('change',function(){draft.values[f.n]=raw(f,input);});
var l=labelled(f,input,id,draft.errors[f.n]);li.appendChild(l.wrap);
});
var row=make('div','ui-form-actions');
row.appendChild(button(copy.save,'ui-button-primary',function(){save(item,draft);},busy));
row.appendChild(button(copy.cancel,'ui-button-ghost',function(){drafts.delete(item.id);render();},busy));
li.appendChild(row);
return li;
}
function viewRow(item,busy){
var li=make('li','ui-crud-item');li.setAttribute('data-id',item.id);
var body=make('div','ui-crud-values');var lead=true;
fields.forEach(function(f){
if(f.k==='checkbox'){
var id='crud-'+(serial++),cb=make('input','ui-checkbox');cb.type='checkbox';cb.checked=item[f.n]===true;cb.disabled=busy||readOnly;cb.setAttribute('id',id);cb.setAttribute('name',f.n);
var key=item.id+':'+f.n;cb.setAttribute('data-ui-key',key);keys[key]=cb;
cb.addEventListener('change',function(){toggle(item,f,cb.checked);});
var l=make('label','ui-crud-check');l.setAttribute('for',id);l.appendChild(cb);l.appendChild(make('span','ui-sr-only',f.l));body.appendChild(l);
}else{var v=item[f.n];body.appendChild(make('span',lead?'ui-crud-lead':'ui-crud-value',v===undefined||v===null?'':v));lead=false;}
});
li.appendChild(body);
if(!readOnly){
var row=make('div','ui-crud-actions');
row.appendChild(button(copy.edit,'ui-button-ghost',function(){var values={};fields.forEach(function(f){values[f.n]=item[f.n]===undefined?initial(f):item[f.n];});drafts.set(item.id,{values:values,errors:{}});render();},busy));
row.appendChild(button(copy.remove,'ui-button-destructive',function(){remove(item);},busy));
li.appendChild(row);
}
return li;
}
function render(){
var active=document.activeElement,focus=null,range=null;
if(active&&active.getAttribute){focus=active.getAttribute('data-ui-key');if(typeof active.selectionStart==='number')range=[active.selectionStart,active.selectionEnd];}
keys={};list.replaceChildren();
if(!items.length)list.appendChild(make('li','ui-crud-empty',copy.empty));
items.forEach(function(item){
var busy=pending.has(item.id),draft=drafts.get(item.id);
list.appendChild(draft&&!readOnly?editRow(item,draft,busy):viewRow(item,busy));
});
more.hidden=next===null;
var target=focus&&keys[focus];
if(target&&target.focus){target.focus();if(range&&target.setSelectionRange)try{target.setSelectionRange(range[0],range[1]);}catch(e){}}
}
function current(){var p=new URLSearchParams();if(sortBox&&sortBox.value)p.set('sort',sortBox.value);if(query)query.f.forEach(function(f){var v=filterBoxes[f.n].value;if(v!=='')p.set(f.n,v);});return p;}
function load(append){
var p=append?new URLSearchParams(applied):current();
if(!append)applied=p.toString();
if(append&&next!==null)p.set('cursor',next);
var url=api+(p.toString()?'?'+p.toString():'');
refresh.disabled=true;more.disabled=true;
return call('GET',url).then(function(res){
refresh.disabled=false;more.disabled=false;
if(!res.ok||!res.data||!Array.isArray(res.data.items)){say('error',copy.loadFailed);return;}
var got=res.data.items.filter(function(r){return r&&typeof r==='object'&&typeof r.id==='string';});
items=append?items.concat(got):got;
next=res.data.next===undefined||res.data.next===null?null:String(res.data.next);
say('info','');
render();
});
}
refresh.addEventListener('click',function(){load(false);});
more.addEventListener('click',function(){load(true);});
root.replaceChildren();
if(!readOnly)root.appendChild(form);
root.appendChild(status);if(qbar.children.length)root.appendChild(qbar);root.appendChild(list);root.appendChild(bar);
say('info',copy.loading);
load(false);
}
var roots=document.querySelectorAll('[data-ui-crud]');
for(var i=0;i<roots.length;i++)start(roots[i]);
})();`;
