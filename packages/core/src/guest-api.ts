import type { HeaderPair } from './http-response.ts';
// What crosses the guest boundary, in both directions. Only strings cross it;
// function-worker.ts stringifies the request and checks the response's shape
// before trusting it. The response body crosses on its own, in slices, not
// inside the JSON: escaping and copying it whole would multiply its size in the
// guest heap (up to six times for control characters), so the body a guest
// could deliver would depend on its content (#1096).
/** The request the guest receives (stringified as JSON in the worker). */
export interface GuestRequestPayload { url: string; method: string; headers: HeaderPair[]; body?: Uint8Array | undefined }
/** The response metadata the guest returns as JSON text; the worker enforces this shape before trusting it. The body is read separately. */
export interface GuestResponsePayload { status: number; headers: HeaderPair[]; nativeBody?: boolean; contentLength?: number }
// Runs only inside QuickJS/WASM. No native host functions or objects are exposed.
// This is the documented text/JSON subset, not a complete Fetch implementation.
export const guestBootstrap = String.raw`
(() => {
  const NativeJSON = JSON;
  const stringify = JSON.stringify.bind(JSON);
  const now = Date.now.bind(Date);
  // The guest has no TextEncoder/Buffer; this counts the UTF-8 bytes a
  // Response's text would occupy on the wire (matching Buffer.byteLength on
  // the host side, including its handling of lone surrogates as U+FFFD),
  // without pulling any Node capability into the sandbox (#144).
  function byteLength(text) {
    let bytes = 0;
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      if (code >= 0xd800 && code <= 0xdbff) {
        const next = text.charCodeAt(i + 1);
        if (next >= 0xdc00 && next <= 0xdfff) { bytes += 4; i++; continue; }
        bytes += 3; continue;
      }
      if (code >= 0xdc00 && code <= 0xdfff) { bytes += 3; continue; }
      bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : 3;
    }
    return bytes;
  }
  // The invocation's outcome lives in this closure. The host reads it through
  // accessors and calls the entry points below, all fixed before guest code
  // runs, so a guest can neither rewrite its result nor replace the code that
  // shapes it. The first outcome settles the invocation.
  let state = 'pending', output = '', content = '';
  const settle = (next, text = '', body = '') => { if (state === 'pending') { state = next; output = text; content = body; } };
  const fix = (name, value) => Object.defineProperty(globalThis, name, {value, writable:false, enumerable:false, configurable:false});
  Object.defineProperty(globalThis, '__state', {get: () => state, enumerable:false, configurable:false});
  Object.defineProperty(globalThis, '__output', {get: () => output, enumerable:false, configurable:false});
  // The host reads the body in slices of at most 2^20 UTF-16 units, so the
  // hand-over needs one slice's copy in the heap, not the whole body's. A slice
  // never ends between the halves of a surrogate pair.
  const isWellFormed = Function.prototype.call.bind(String.prototype.isWellFormed);
  const toWellFormed = Function.prototype.call.bind(String.prototype.toWellFormed);
  const slice = Function.prototype.call.bind(String.prototype.slice);
  const charCodeAt = Function.prototype.call.bind(String.prototype.charCodeAt);
  Object.defineProperty(globalThis, '__bodyLength', {get: () => content.length, enumerable:false, configurable:false});
  fix('__bodyChunk', start => {
    let end = start + 1048576;
    if (end >= content.length) end = content.length;
    else { const code = charCodeAt(content, end - 1); if (code >= 0xd800 && code <= 0xdbff) end--; }
    return slice(content, start, end);
  });
  // The body the host reads. A lone surrogate becomes U+FFFD here, as Node's
  // UTF-8 encoding would make it and byteLength counts it; a well-formed
  // string is kept as is, without a copy.
  const bodyText = response => {
    const text = response._text;
    if (typeof text !== 'string') throw new TypeError('Invalid body');
    return isWellFormed(text) ? text : toWellFormed(text);
  };
  fix('__ready', () => settle('done'));
  const timers = new Map(); let next = 1;
  globalThis.setTimeout = (fn, delay = 0) => {
    if (typeof fn !== 'function' || timers.size >= 128) throw new Error('Timer limit');
    const id = next++; timers.set(id, {fn, at:now() + Math.max(0, Number(delay) || 0)}); return id;
  };
  globalThis.clearTimeout = id => timers.delete(id);
  fix('__pump', () => {
    for (const [id,timer] of timers) if (timer.at <= now()) { timers.delete(id); timer.fn(); }
  });
  globalThis.console = Object.freeze({log(){},error(){},warn(){},info(){},debug(){}});
  class Headers {
    constructor(init = []) {
      this._pairs = [];
      for (const [k,v] of init instanceof Headers ? init._pairs : Array.isArray(init) ? init : Object.entries(init)) this.append(k,v);
    }
    append(key,value) {
      key = String(key).toLowerCase(); value = String(value).trim();
      if (!/^[!#$%&'*+.^_\x60|~0-9a-z-]+$/.test(key) || /[\r\n\0]/.test(value)) throw new TypeError('Invalid header');
      this._pairs.push([key,value]);
    }
    set(key,value) { this.delete(key); this.append(key,value); }
    delete(key) { this._pairs = this._pairs.filter(p => p[0] !== String(key).toLowerCase()); }
    get(key) { const values = this._pairs.filter(p=>p[0]===String(key).toLowerCase()).map(p=>p[1]); return values.length ? values.join(', ') : null; }
    has(key) { return this.get(key) !== null; }
    getSetCookie() { return this._pairs.filter(p=>p[0]==='set-cookie').map(p=>p[1]); }
    *entries() { const keys = new Set(this._pairs.map(p=>p[0])); for (const key of keys) yield [key,this.get(key)]; }
    [Symbol.iterator]() { return this.entries(); }
  }
  class Request {
    constructor(url, init = {}) {
      this.url = String(url); this.method = init.method || 'GET'; this.headers = new Headers(init.headers);
      this._text = init.body || ''; this.bodyUsed = false;
    }
    async text() { if (this.bodyUsed) throw new TypeError('Body already read'); this.bodyUsed = true; return this._text; }
    async json() { return NativeJSON.parse(await this.text()); }
  }
  class Response {
    constructor(body = null, init = {}) {
      if (body !== null && typeof body !== 'string') throw new TypeError('Only text/JSON bodies are supported');
      this.status = init.status ?? 200;
      if (!Number.isInteger(this.status) || this.status < 200 || this.status > 599) throw new TypeError('Invalid status');
      if ([204,205,304].includes(this.status) && body !== null && body !== '') throw new TypeError('Null-body status');
      this.headers = new Headers(init.headers);
      this._text = body || ''; this.bodyUsed = false; this.ok = this.status >= 200 && this.status < 300;
      if (body !== null && !this.headers.has('content-type')) this.headers.set('content-type','text/plain;charset=UTF-8');
    }
    async text() { if (this.bodyUsed) throw new TypeError('Body already read'); this.bodyUsed = true; return this._text; }
    async json() { return NativeJSON.parse(await this.text()); }
    static json(value, init = {}) { const headers = new Headers(init.headers); if (!headers.has('content-type')) headers.set('content-type','application/json'); return new Response(stringify(value), {...init,headers}); }
    static redirect(url, status = 302) { if (![301,302,303,307,308].includes(status)) throw new TypeError('Invalid redirect status'); return new Response(null,{status,headers:{location:String(url)}}); }
  }
  globalThis.Headers = Headers; globalThis.Request = Request; globalThis.Response = Response;
  fix('__invokePipeline', async (middleware, handler, payload) => {
    try {
      const input = NativeJSON.parse(payload);
      const request = new Request(input.request.url, input.request);
      const context = input.context; context.state = {};
      let nativeResponse;
      if (input.native) {
        nativeResponse = new Response(null,input.native);
        nativeResponse.text = nativeResponse.json = async () => { throw new TypeError('Native body is opaque; return a new Response to replace it'); };
      }
      let violated = false;
      async function dispatch(index) {
        if (index === middleware.length) return handler ? await handler(request,context) : nativeResponse;
        let called = false, open = true, pending;
        const next = (...args) => {
          if (args.length || called || !open) { violated = true; throw new TypeError('next may be called once during middleware'); }
          called = true; pending = dispatch(index+1); return pending;
        };
        try {
          const response = await middleware[index](request,context,next);
          // Drain downstream work under the same deadline even if the caller forgot await.
          if (pending) await pending.catch(() => {});
          if (!(response instanceof Response)) throw new TypeError('Middleware must return a Response');
          return response;
        } finally { open = false; }
      }
      const response = await dispatch(0);
      if (violated || !(response instanceof Response)) throw new TypeError('Invalid middleware response');
      const nativeBody = response === nativeResponse;
      const isHead = input.request.method === 'HEAD';
      // The real length is already known "for free": _text is a fully
      // materialized string at construction time, no stream read needed
      // (#144, mirroring #139's fix for the trusted path). Only the
      // transmitted bytes are suppressed for HEAD, never the length.
      const text = bodyText(response);
      settle('done', stringify({status:response.status,headers:response.headers._pairs,nativeBody,
        ...(isHead && !nativeBody ? {contentLength:byteLength(text)} : {})}), nativeBody || isHead ? '' : text);
    } catch { settle('failed'); }
  });
  fix('__invoke', async (handler, payload) => {
    try {
      const input = NativeJSON.parse(payload);
      const response = await handler(new Request(input.request.url, input.request), input.context);
      if (!(response instanceof Response)) throw new TypeError('Return a Response');
      const headers = response.headers._pairs;
      const isHead = input.request.method === 'HEAD';
      const text = bodyText(response);
      settle('done', stringify({status:response.status,headers,
        ...(isHead ? {contentLength:byteLength(text)} : {})}), isHead ? '' : text);
    } catch { settle('failed'); }
  });
})();
`;
