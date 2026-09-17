import {randomBytes} from 'node:crypto';
import {HttpError} from './errors.ts';
export interface LinkRecord { url: string; status: number; enabled: boolean; expires: string | null }
const check: (value: unknown, message: string) => asserts value = (value,message) => { if(!value)throw new HttpError(400,message); };
export function linkCollection(value: unknown): string {
  check(typeof value==='string' && /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(value),'Invalid link collection');return value;
}
export function linkCode(value: unknown): string {
  check(typeof value==='string' && /^[A-Za-z0-9_-]{1,128}$/.test(value),'Invalid short code');return value;
}
export function linkVersion(value: unknown): number {
  check(typeof value==='number' && Number.isSafeInteger(value) && value>0,'A positive expected version is required');return value;
}
export function linkData(value: unknown): LinkRecord {
  check(value && typeof value==='object' && !Array.isArray(value),'Invalid link record');
  check(Object.keys(value).every(k=>['url','status','enabled','expires'].includes(k)),'Unsupported link field');
  const record=value as {url?: unknown; status?: unknown; enabled?: unknown; expires?: unknown};
  check(typeof record.url==='string' && record.url.length<=8192 && !/[\s\u0000-\u001f\u007f\\]/u.test(record.url),'Invalid destination');
  let url: URL;try{url=new URL(record.url);}catch{throw new HttpError(400,'Invalid destination');}
  check(['http:','https:'].includes(url.protocol) && !url.username && !url.password,'Destination must be HTTP(S) without credentials');
  check(Buffer.byteLength(url.href)<=8192,'Destination exceeds 8192 bytes');
  const status=record.status??302,enabled=record.enabled??true,expires=record.expires??null;
  check(typeof status==='number' && [301,302,303,307,308].includes(status),'Invalid redirect status');
  check(typeof enabled==='boolean','Invalid enabled flag');
  if(expires!==null){
    check(typeof expires==='string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(expires) && Number.isFinite(Date.parse(expires)),'Invalid expiry');
    check(new Date(expires).toISOString().replace('.000Z','Z')===expires.replace('.000Z','Z'),'Invalid expiry');
  }
  return {url:url.href,status,enabled,expires};
}
export const randomLinkCode=(): string=>randomBytes(12).toString('base64url');
