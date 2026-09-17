import {constants} from 'node:fs';
import {open} from 'node:fs/promises';
import {createHash,timingSafeEqual} from 'node:crypto';
import {outsideProject} from './link-store.ts';
import {assert} from './errors.ts';
const actions=['get','list','create','update','delete'];
export async function managementPolicy(file,project) {
  file=await outsideProject(file,project);
  return async token=>{
    const handle=await open(file,constants.O_RDONLY | (constants.O_NOFOLLOW||0));
    let document;
    try {
      const info=await handle.stat();
      assert(info.isFile() && info.nlink===1 && info.size<=65536 && (process.platform==='win32'||(info.mode&0o077)===0),'Invalid private management policy');
      const buffer=Buffer.alloc(65537);let offset=0;
      while(offset<buffer.length){const {bytesRead}=await handle.read(buffer,offset,buffer.length-offset,null);if(!bytesRead)break;offset+=bytesRead;}
      assert(offset<=65536,'Management policy exceeds 64 KiB');
      document=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(buffer.subarray(0,offset)));
    } finally {await handle.close();}
    assert(document?.version===1 && Object.keys(document).every(k=>['version','credentials'].includes(k)) && Array.isArray(document.credentials) && document.credentials.length<=128,'Invalid management policy');
    const ids=new Set(),hashes=new Set();let principal;
    const digest=createHash('sha256').update(token).digest();
    for(const c of document.credentials){
      assert(c && Object.keys(c).every(k=>['id','sha256','expires','revoked','collections','actions'].includes(k)) && typeof c.id==='string' && /^[A-Za-z0-9_-]{1,64}$/.test(c.id) && !ids.has(c.id),'Invalid credential identity');ids.add(c.id);
      assert(typeof c.sha256==='string' && /^[a-f0-9]{64}$/.test(c.sha256) && !hashes.has(c.sha256),'Invalid credential hash');hashes.add(c.sha256);
      assert(typeof c.expires==='string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(c.expires) && Number.isFinite(Date.parse(c.expires)) && new Date(c.expires).toISOString()===c.expires.replace('Z','.000Z'),'Credential expiry required');
      assert(c.revoked===undefined || typeof c.revoked==='boolean','Invalid revocation');
      assert(Array.isArray(c.collections) && c.collections.length>0 && c.collections.length<=100 && c.collections.every(v=>typeof v==='string' && /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(v)),'Invalid collection scope');
      assert(Array.isArray(c.actions) && c.actions.length>0 && c.actions.every(a=>actions.includes(a)),'Invalid action scope');
      if(timingSafeEqual(digest,Buffer.from(c.sha256,'hex')) && !c.revoked && Date.parse(c.expires)>Date.now())principal=c;
    }
    return principal;
  };
}
