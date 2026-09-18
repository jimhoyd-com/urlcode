import {constants} from 'node:fs';
import {open} from 'node:fs/promises';
import {createHash,timingSafeEqual} from 'node:crypto';
import {outsideProject} from './link-store.ts';
import {assert} from './errors.ts';
/** A credential from the operator's management policy file, once it authenticated a request. */
export interface ManagementPrincipal { id: string; collections: string[]; actions: string[] }
export type ManagementAuthorizer=(token: string)=>Promise<ManagementPrincipal|undefined>;
interface Credential extends ManagementPrincipal { sha256: string; expires: string; revoked?: boolean }
const actions: readonly string[]=['get','list','create','update','delete'];
const isRecord=(value: unknown): value is Record<string,unknown>=>value!==null && typeof value==='object' && !Array.isArray(value);
export async function managementPolicy(file: unknown,project: string): Promise<ManagementAuthorizer> {
  const path=await outsideProject(file,project);
  return async token=>{
    const handle=await open(path,constants.O_RDONLY | (constants.O_NOFOLLOW||0));
    let document: unknown;
    try {
      const info=await handle.stat();
      assert(info.isFile() && info.nlink===1 && info.size<=65536 && (process.platform==='win32'||(info.mode&0o077)===0),'Invalid private management policy');
      const buffer=Buffer.alloc(65537);let offset=0;
      while(offset<buffer.length){const {bytesRead}=await handle.read(buffer,offset,buffer.length-offset,null);if(!bytesRead)break;offset+=bytesRead;}
      assert(offset<=65536,'Management policy exceeds 64 KiB');
      document=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(buffer.subarray(0,offset)));
    } finally {await handle.close();}
    assert(isRecord(document) && document.version===1 && Object.keys(document).every(k=>['version','credentials'].includes(k)) && Array.isArray(document.credentials) && document.credentials.length<=128,'Invalid management policy');
    const ids=new Set<string>(),hashes=new Set<string>();let principal: ManagementPrincipal|undefined;
    const digest=createHash('sha256').update(token).digest();
    for(const entry of document.credentials as unknown[]){
      assert(isRecord(entry) && Object.keys(entry).every(k=>['id','sha256','expires','revoked','collections','actions'].includes(k)) && typeof entry.id==='string' && /^[A-Za-z0-9_-]{1,64}$/.test(entry.id) && !ids.has(entry.id),'Invalid credential identity');ids.add(entry.id);
      assert(typeof entry.sha256==='string' && /^[a-f0-9]{64}$/.test(entry.sha256) && !hashes.has(entry.sha256),'Invalid credential hash');hashes.add(entry.sha256);
      assert(typeof entry.expires==='string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(entry.expires) && Number.isFinite(Date.parse(entry.expires)) && new Date(entry.expires).toISOString()===entry.expires.replace('Z','.000Z'),'Credential expiry required');
      assert(entry.revoked===undefined || typeof entry.revoked==='boolean','Invalid revocation');
      assert(Array.isArray(entry.collections) && entry.collections.length>0 && entry.collections.length<=100 && entry.collections.every(v=>typeof v==='string' && /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(v)),'Invalid collection scope');
      assert(Array.isArray(entry.actions) && entry.actions.length>0 && entry.actions.every(a=>actions.includes(a)),'Invalid action scope');
      const c=entry as unknown as Credential; // validated field by field above
      if(timingSafeEqual(digest,Buffer.from(c.sha256,'hex')) && !c.revoked && Date.parse(c.expires)>Date.now())principal=c;
    }
    return principal;
  };
}
