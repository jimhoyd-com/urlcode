import {managementPolicy} from './management-policy.js';
import {openLinkStore} from './link-store.js';
import {startLinkApi,loadLinkToken} from './link-api.js';
import {linkCollection} from './link-records.js';
import {assert} from './errors.js';
export function linkPoolOptions(values) {
  const result={};
  for(const [flag,key,max] of [['link-readers','readers',8],['link-read-limit','maxReads',32],['link-write-limit','maxWrites',32]]){
    if(values[flag]===undefined)continue;
    assert(/^\d+$/.test(values[flag])&&Number(values[flag])>=1&&Number(values[flag])<=max,`Invalid --${flag}`);result[key]=Number(values[flag]);
  }
  return result;
}
export function parseLinkBinding(value,options={}) {
  if(value===undefined)return undefined;
  const index=value.indexOf('=');assert(index>0,'Use --link-store collection=/absolute/path.sqlite');
  return {collection:linkCollection(value.slice(0,index)),file:value.slice(index+1),...options};
}
export async function runLinkCommand(action,values,print) {
  assert(['init','create','get','list','update','delete','api'].includes(action),'Use links init/create/get/list/update/delete/api');
  assert(values.store,'Links commands require --store with an absolute database path');
  const collection=linkCollection(values.collection||'links');
  const poolOptions=linkPoolOptions(values);
  // Authentication material is checked before creating or opening a writable store.
  if(values['auth-file'] && values['token-file'])throw new Error('Use either --auth-file or --token-file');
  const authorize=action==='api' && values['auth-file']?await managementPolicy(values['auth-file'],values.project):undefined;
  if(authorize)await authorize('');
  const token=action==='api' && !authorize?await loadLinkToken(values['token-file'],values.project):undefined;
  const store=await openLinkStore({file:values.store,project:values.project,readOnly:['get','list'].includes(action),...poolOptions});
  try {
    if(action==='api'){
      const port=Number(values.port);assert(/^\d+$/.test(values.port)&&port>=0&&port<=65535,'Invalid port');
      const api=await startLinkApi({store,collection,token,authorize,host:values.host,port});
      print({event:'link-management-listening',address:api.address.address,port:api.address.port,collection});
      await new Promise(resolve=>{
        const stop=()=>{process.off('SIGINT',stop);process.off('SIGTERM',stop);resolve();};
        process.once('SIGINT',stop);process.once('SIGTERM',stop);
      });
      await api.close();return;
    }
    let value;
    if(action==='init')value={event:'link-store-initialized'};
    if(action==='get'){value=await store.get(collection,values.code);assert(value,'Link not found');}
    if(action==='list')value=await store.list(collection,{limit:values.limit===undefined?100:Number(values.limit),after:values.after||''});
    if(action==='create'||action==='update'){
      assert(values.destination,'Use --destination with an HTTP(S) URL');
      assert(values.enabled===undefined||['true','false'].includes(values.enabled),'Enabled must be true or false');
      const data={url:values.destination,status:values.status===undefined?302:Number(values.status),enabled:values.enabled!=='false',expires:values.expires||null};
      value=action==='create'?await store.create(collection,data,values.code):await store.update(collection,values.code,data,Number(values['if-version']));
    }
    if(action==='delete')value={deleted:await store.delete(collection,values.code,Number(values['if-version']))};
    print(value);
  }finally{await store.close();}
}
