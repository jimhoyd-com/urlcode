import { parentPort, workerData } from 'node:worker_threads';
import { pathToFileURL } from 'node:url';

const modules = new Map();
try {
  for (const [source, exports] of workerData.modules) {
    const module = await import(pathToFileURL(source).href);
    for (const name of exports) if (typeof module[name] !== 'function') throw new Error('Invalid export');
    modules.set(source, module);
  }
  parentPort.postMessage({ ready: true });
} catch { parentPort.postMessage({ startupError: true }); }
parentPort.on('message', async ({ id, source, name, request, context, maxBytes }) => {
  try {
    const handler = modules.get(source)?.[name];
    if (typeof handler !== 'function') throw new Error('Invalid handler');
    const req = new Request(request.url, { method: request.method, headers: request.headers,
      ...(!['GET', 'HEAD'].includes(request.method) && request.body?.length ? { body: request.body } : {}) });
    const response = await handler(req, Object.freeze(context));
    if (!(response instanceof Response)) throw new Error('Handler must return Response');
    const chunks = []; let size = 0;
    if (response.body && request.method !== 'HEAD') {
      const reader = response.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > maxBytes) { await reader.cancel(); throw new Error('Response too large'); }
        chunks.push(Buffer.from(value));
      }
    } else await response.body?.cancel();
    const headers = [...response.headers].filter(([key]) => key !== 'set-cookie');
    for (const cookie of response.headers.getSetCookie()) headers.push(['set-cookie', cookie]);
    if (headers.reduce((n,[key,value]) => n + Buffer.byteLength(key) + Buffer.byteLength(value) + 4, 0) > 16384) throw new Error('Response headers too large');
    parentPort.postMessage({ id, status: response.status, headers, body: Buffer.concat(chunks) });
  } catch { parentPort.postMessage({ id, error: true }); }
});
