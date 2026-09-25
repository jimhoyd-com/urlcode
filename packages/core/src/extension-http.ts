// Request helpers every extension uses instead of hand-rolling its own (RIM-EXT-HTTP-001): one bounded body reader,
// one field reader on top of it, one JSON response with the extension security headers, one cookie reader that
// refuses ambiguity, and one same-origin admission rule. Pure functions over `ExtensionRequest` fields, written with
// web-standard APIs only (TextDecoder, URL, URLSearchParams) so every target can run them; they keep no state and
// know no extension.
import { maxRequestBodyBytes } from './body-schema.ts';
import { isSiteOrigin } from './site-origins.ts';
import type { ExtensionRequest } from './extensions.ts';
import type { HandlerResult, HeaderPair } from './http-response.ts';

export type ExtensionHttpErrorCode = 'body_too_large'|'unsupported_media_type'|'invalid_encoding'|'invalid_json'
  |'duplicate_key'|'too_deep'|'expected_object'|'too_many_fields'|'invalid_field'|'invalid_cookie'|'duplicate_header';
const messages:Readonly<Record<ExtensionHttpErrorCode,string>>={
  body_too_large:'Request body too large',unsupported_media_type:'Unsupported request content type',invalid_encoding:'Invalid request encoding',
  invalid_json:'Invalid JSON body',duplicate_key:'Duplicate JSON key',too_deep:'JSON body nested too deeply',expected_object:'Expected an object',
  too_many_fields:'Too many fields',invalid_field:'Invalid request field',invalid_cookie:'Invalid cookies',duplicate_header:'Duplicate request header',
};
/** A refused request. The message is fixed per code and never echoes request data, so it is safe to show the client. */
export class ExtensionHttpError extends Error {
  readonly status:400|413|415; readonly code:ExtensionHttpErrorCode;
  constructor(status:400|413|415,code:ExtensionHttpErrorCode){super(messages[code]);this.name='ExtensionHttpError';this.status=status;this.code=code;}
}
const refuse=(code:ExtensionHttpErrorCode):never=>{throw new ExtensionHttpError(code==='body_too_large'?413:code==='unsupported_media_type'?415:400,code);};

export type BodyKind='json'|'form';
export interface ReadBodyOptions {
  /** The media types this endpoint takes: `application/json` and/or `application/x-www-form-urlencoded`. Non-empty. */
  accept:readonly BodyKind[];
  /** An integer from 1 to the runtime's request body cap (1 MiB). */
  maxBytes:number;
  /** JSON nesting (objects and arrays together): default 32, at most 64. */
  maxDepth?:number;
}
export type RequestBody=
  | { readonly kind:'json'; readonly value:unknown }
  | { readonly kind:'form'; readonly entries:readonly (readonly [string,string])[] };
type BodySource=Pick<ExtensionRequest,'headers'|'headerCounts'|'body'>;
const mediaTypes:Readonly<Record<BodyKind,string>>={json:'application/json',form:'application/x-www-form-urlencoded'};
const count=(request:Pick<ExtensionRequest,'headerCounts'>,name:string):number=>request.headerCounts?.[name]??0;

/**
 * Walks `text` once outside strings, refusing nesting deeper than `maxDepth` and a key repeated within one object
 * (compared after decoding, so `"a"` and `"a"` are the same key), so a hostile body never reaches a recursive
 * parse. Anything else malformed is left to `JSON.parse`.
 */
function checkJsonShape(text:string,maxDepth:number):void {
  const stack:{keys:Set<string>|null;expectKey:boolean}[]=[];
  for(let index=0;index<text.length;index++){
    const char=text[index];
    if(char==='"'){
      const start=index;
      for(index++;index<text.length&&text[index]!=='"';index++)if(text[index]==='\\')index++;
      const top=stack.at(-1);
      if(top?.keys&&top.expectKey){
        let key:string;
        try{key=JSON.parse(text.slice(start,index+1)) as string;}catch{return refuse('invalid_json');}
        if(top.keys.has(key))refuse('duplicate_key');
        top.keys.add(key);top.expectKey=false;
      }
    }else if(char==='{'||char==='['){
      if(stack.length>=maxDepth)refuse('too_deep');
      stack.push({keys:char==='{'?new Set():null,expectKey:char==='{'});
    }else if(char==='}'||char===']')stack.pop();
    else if(char===','){const top=stack.at(-1);if(top?.keys)top.expectKey=true;}
  }
}

/**
 * Reads the request body as JSON or form data. Checks, in order: one `Content-Type` header (400
 * `duplicate_header`), `maxBytes` (413 `body_too_large`), an accepted media type (415 `unsupported_media_type`;
 * lower-cased, parameters ignored), fatal UTF-8 (400 `invalid_encoding`), then for JSON the depth and duplicate-key
 * pre-pass (400 `too_deep`/`duplicate_key`) before `JSON.parse` (400 `invalid_json`). Form entries keep duplicates.
 */
export function readBody(request:BodySource,options:ReadBodyOptions):RequestBody {
  const {accept,maxBytes,maxDepth=32}=options;
  if(!Array.isArray(accept)||!accept.length||!accept.every(kind=>kind==='json'||kind==='form'))throw new TypeError('readBody accept must list json and/or form');
  if(!Number.isInteger(maxBytes)||maxBytes<1||maxBytes>maxRequestBodyBytes)throw new TypeError(`readBody maxBytes must be an integer from 1 to ${maxRequestBodyBytes}`);
  if(!Number.isInteger(maxDepth)||maxDepth<1||maxDepth>64)throw new TypeError('readBody maxDepth must be an integer from 1 to 64');
  if(count(request,'content-type')>1)refuse('duplicate_header');
  if(request.body.byteLength>maxBytes)refuse('body_too_large');
  const type=(request.headers.get('content-type')??'').split(';')[0]!.trim().toLowerCase();
  const kind=(accept as readonly BodyKind[]).find(candidate=>mediaTypes[candidate]===type);
  if(!kind)return refuse('unsupported_media_type');
  let text:string;
  try{text=new TextDecoder('utf-8',{fatal:true}).decode(request.body);}catch{return refuse('invalid_encoding');}
  if(kind==='form')return {kind,entries:[...new URLSearchParams(text)]};
  checkJsonShape(text,maxDepth);
  let value:unknown;
  try{value=JSON.parse(text);}catch{return refuse('invalid_json');}
  return {kind,value};
}

export interface ReadFieldsOptions {
  /** The exact allow-list of field names. List `csrf` (and any challenge token) explicitly. */
  fields:readonly string[];
  /** Trusted, anchored patterns for dynamic names (for example `selected.<uuid>`). */
  patterns?:readonly RegExp[];
  /** Default `['json','form']`. */
  accept?:readonly BodyKind[];
  /** Default 16384. */
  maxBytes?:number;
  /** Default 64. */
  maxFields?:number;
  /** Default 4096 characters per value. */
  maxValueLength?:number;
  /** Per-field value length, replacing `maxValueLength` for that name. */
  limits?:Readonly<Record<string,number>>;
}
/**
 * Reads a flat set of string fields through `readBody`: a JSON body must be an object (400 `expected_object`), more
 * than `maxFields` entries is 400 `too_many_fields`, and a name outside `fields`/`patterns`, a repeated name, a
 * non-string value or an over-long value is 400 `invalid_field`. The result is frozen with a null prototype.
 */
export function readFields(request:BodySource,options:ReadFieldsOptions):Readonly<Record<string,string>> {
  const {fields,patterns=[],accept=['json','form'],maxBytes=16384,maxFields=64,maxValueLength=4096,limits={}}=options;
  const body=readBody(request,{accept,maxBytes});
  let entries:readonly (readonly [string,unknown])[];
  if(body.kind==='json'){
    const value=body.value;
    if(!value||typeof value!=='object'||Array.isArray(value))return refuse('expected_object');
    entries=Object.entries(value);
  }else entries=body.entries;
  if(entries.length>maxFields)refuse('too_many_fields');
  const result=Object.create(null) as Record<string,string>;
  for(const [key,value]of entries){
    const allowed=fields.includes(key)||patterns.some(pattern=>{pattern.lastIndex=0;return pattern.test(key);});
    const limit=Object.hasOwn(limits,key)?limits[key]!:maxValueLength;
    if(!allowed||Object.hasOwn(result,key)||typeof value!=='string'||value.length>limit)refuse('invalid_field');
    result[key]=value as string;
  }
  return Object.freeze(result);
}

const jsonDefaults:readonly HeaderPair[]=[
  ['content-type','application/json; charset=utf-8'],['cache-control','no-store'],['x-content-type-options','nosniff'],
  ['content-security-policy',"default-src 'none'; frame-ancestors 'none'; base-uri 'none'"],['referrer-policy','strict-origin'],
];
/**
 * A JSON response with the extension security headers (content type, `no-store`, `nosniff`, a deny-all CSP and
 * `strict-origin` referrer policy). A caller header with the same name (case-insensitive) replaces the default;
 * `set-cookie` is always appended.
 */
export function jsonResponse(status:number,value:unknown,headers:readonly (readonly [string,string])[]=[]):HandlerResult {
  if(!Number.isInteger(status)||status<200||status>599)throw new TypeError('jsonResponse status must be an integer from 200 to 599');
  const replaced=new Set(headers.map(([name])=>name.toLowerCase()).filter(name=>name!=='set-cookie'));
  return {status,headers:[...jsonDefaults.filter(([name])=>!replaced.has(name)).map(([name,value])=>[name,value] as HeaderPair),...headers.map(([name,value])=>[name,value] as HeaderPair)],body:JSON.stringify(value)??'null'};
}

/** Whether the client asked for JSON: `Accept` lists `application/json`, or the request body is `application/json`. */
export function wantsJson(request:Pick<ExtensionRequest,'headers'>):boolean {
  const mediaType=(value:string):string=>value.split(';')[0]!.trim().toLowerCase();
  return (request.headers.get('accept')??'').split(',').some(value=>mediaType(value)==='application/json')||mediaType(request.headers.get('content-type')??'')==='application/json';
}

/**
 * One cookie value. Refuses (400 `invalid_cookie`) more than one `Cookie` header, a header over 8192 bytes, or the
 * name appearing twice. A value that does not match `shape` is `undefined`: treated as absent, never as an error.
 */
export function readCookie(request:Pick<ExtensionRequest,'headers'|'headerCounts'>,name:string,shape:RegExp):string|undefined {
  const raw=request.headers.get('cookie')??'';
  if(count(request,'cookie')>1||new TextEncoder().encode(raw).byteLength>8192)refuse('invalid_cookie');
  const values=raw.split(';').map(part=>part.trim()).filter(part=>part.startsWith(name+'=')).map(part=>part.slice(name.length+1));
  if(values.length>1)refuse('invalid_cookie');
  const value=values[0];
  if(value===undefined)return undefined;
  shape.lastIndex=0;
  return shape.test(value)?value:undefined;
}

export interface SameOriginOptions {
  /**
   * What to do when the request carries no provenance header at all (no `Origin`, `Sec-Fetch-Site` or `Referer`).
   * `'refuse'`: an endpoint that accepts a CORS-safelisted body (form posts) or relies on cookies. `'admit'`: only an
   * endpoint that accepts `application/json` exclusively, which a cross-site browser cannot send without a
   * preflight the runtime never grants; non-browser clients (curl, MCP clients, API keys) send no `Origin`.
   */
  whenAbsent:'refuse'|'admit';
}
/**
 * The one same-origin admission rule; the first matching step decides:
 * 1. more than one `Origin`, `Sec-Fetch-Site` or `Referer` header: refuse;
 * 2. `Sec-Fetch-Site: cross-site`: refuse;
 * 3. `Origin` present: admit only a site origin (`isSiteOrigin`; the opaque `null` never matches);
 * 4. `Sec-Fetch-Site` present: admit only `same-origin` or `none`;
 * 5. `Referer` present: admit only when its origin is a site origin (a Referer that does not parse refuses);
 * 6. otherwise `whenAbsent`.
 * This is admission only: a cookie-bound mutation still needs its own CSRF token.
 */
export function isSameOriginRequest(request:Pick<ExtensionRequest,'headers'|'headerCounts'>,site:{readonly origin:string;readonly origins?:readonly string[]},options:SameOriginOptions):boolean {
  if(options?.whenAbsent!=='refuse'&&options?.whenAbsent!=='admit')throw new TypeError('isSameOriginRequest needs whenAbsent: refuse or admit');
  if(['origin','sec-fetch-site','referer'].some(name=>count(request,name)>1))return false;
  const fetchSite=request.headers.get('sec-fetch-site');
  if(fetchSite!==null&&fetchSite.trim().toLowerCase()==='cross-site')return false;
  const origin=request.headers.get('origin');
  if(origin!==null)return isSiteOrigin(site,origin);
  if(fetchSite!==null)return ['same-origin','none'].includes(fetchSite.trim().toLowerCase());
  const referer=request.headers.get('referer');
  if(referer!==null){
    let url:URL;
    try{url=new URL(referer);}catch{return false;}
    return isSiteOrigin(site,url.origin);
  }
  return options.whenAbsent==='admit';
}
