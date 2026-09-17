import {randomBytes} from 'node:crypto';
import {HttpError} from './errors.ts';
const check = (value,message) => { if(!value)throw new HttpError(400,message); };
export function linkCollection(value) {
  check(typeof value==='string' && /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(value),'Invalid link collection');return value;
}
export function linkCode(value) {
  check(typeof value==='string' && /^[A-Za-z0-9_-]{1,128}$/.test(value),'Invalid short code');return value;
}
export function linkVersion(value) {
  check(Number.isSafeInteger(value) && value>0,'A positive expected version is required');return value;
}
export function linkData(value) {
  check(value && typeof value==='object' && !Array.isArray(value),'Invalid link record');
  check(Object.keys(value).every(k=>['url','status','enabled','expires'].includes(k)),'Unsupported link field');
  check(typeof value.url==='string' && value.url.length<=8192 && !/[\s\u0000-\u001f\u007f\\]/u.test(value.url),'Invalid destination');
  let url;try{url=new URL(value.url);}catch{throw new HttpError(400,'Invalid destination');}
  check(['http:','https:'].includes(url.protocol) && !url.username && !url.password,'Destination must be HTTP(S) without credentials');
  check(Buffer.byteLength(url.href)<=8192,'Destination exceeds 8192 bytes');
  const status=value.status??302,enabled=value.enabled??true,expires=value.expires??null;
  check([301,302,303,307,308].includes(status),'Invalid redirect status');
  check(typeof enabled==='boolean','Invalid enabled flag');
  if(expires!==null){
    check(typeof expires==='string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(expires) && Number.isFinite(Date.parse(expires)),'Invalid expiry');
    check(new Date(expires).toISOString().replace('.000Z','Z')===expires.replace('.000Z','Z'),'Invalid expiry');
  }
  return {url:url.href,status,enabled,expires};
}
export const randomLinkCode=()=>randomBytes(12).toString('base64url');
