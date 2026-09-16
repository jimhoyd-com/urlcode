// Runs only inside QuickJS/WASM. No native host functions or objects are exposed.
// This is the documented text/JSON subset, not a complete Fetch implementation.
export const guestBootstrap = String.raw`
(() => {
  const NativeJSON = JSON;
  const stringify = JSON.stringify.bind(JSON);
  const now = Date.now.bind(Date);
  const timers = new Map(); let next = 1;
  globalThis.setTimeout = (fn, delay = 0) => {
    if (typeof fn !== 'function' || timers.size >= 128) throw new Error('Timer limit');
    const id = next++; timers.set(id, {fn, at:now() + Math.max(0, Number(delay) || 0)}); return id;
  };
  globalThis.clearTimeout = id => timers.delete(id);
  globalThis.__pump = () => {
    for (const [id,timer] of timers) if (timer.at <= now()) { timers.delete(id); timer.fn(); }
  };
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
  globalThis.__state = 'pending'; globalThis.__output = '';
  globalThis.__invoke = async (handler, payload) => {
    try {
      const input = NativeJSON.parse(payload);
      const response = await handler(new Request(input.request.url, input.request), input.context);
      if (!(response instanceof Response)) throw new TypeError('Return a Response');
      const headers = response.headers._pairs;
      globalThis.__output = stringify({status:response.status,headers,body: input.request.method === 'HEAD' ? '' : response._text});
      globalThis.__state = 'done';
    } catch { globalThis.__state = 'failed'; }
  };
})();
`;
