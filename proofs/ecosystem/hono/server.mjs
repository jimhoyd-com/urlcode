// A Hono application that owns the HTTP server and hosts URLCode under /app/*. Hono serves its own routes; URLCode
// serves the declared project through core's embedded fetch handler (createEmbeddedHandler). Run: node
// hono/server.mjs --origin http://localhost:4191 --port 4191 [--trusted-proxies 127.0.0.1/32] (PROJECT_SHA256 set to
// the reviewed revision, as for `urlcode serve`).
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { createRuntime, createEmbeddedHandler } from '@jimhoyd/urlcode';
import host from '../host.mjs';

const defaultProject = fileURLToPath(new URL('../app', import.meta.url));

export async function start({ project = defaultProject, origin, port = 0, hostname = '127.0.0.1', trustedProxies = [] } = {}) {
  // The whole project activates (routes, functions, the extension's revision pin) before anything listens: a
  // refused project never serves a request.
  const runtime = await createRuntime(project, { origin, extensions: host.extensions, target: 'node' });
  // The only Hono-specific glue: @hono/node-server's socket peer and Node's raw header lines.
  const info = env => ({ peer: env.incoming.socket.remoteAddress, rawHeaders: env.incoming.rawHeaders });
  // Created once the listener's port is known, so the loopback Host check names it; no request arrives before that.
  let urlcode, mounted;

  const app = new Hono();
  app.get('/', c => c.text('Hono owns this page'));
  app.get('/healthz', c => c.json({ ok: true, host: 'hono' }));
  // URLCode's declared routes keep their full paths here, so no base path is involved.
  app.all('/app/*', c => urlcode(c.req.raw, info(c.env)));
  // Hono's mount() strips its prefix before the sub-application sees the request; basePath puts it back into
  // redirects and a function's request.url.
  app.mount('/mounted', (request, env) => mounted(request, info(env)));

  const server = await new Promise((resolve, reject) => {
    const listening = serve({ fetch: app.fetch, port, hostname }, () => resolve(listening));
    listening.once('error', reject);
  });
  const address = server.address();
  const options = { origin, trustedProxies, loopbackHost: { address: address.address, port: address.port } };
  urlcode = createEmbeddedHandler(runtime, options);
  mounted = createEmbeddedHandler(runtime, { ...options, basePath: '/mounted' });
  let closing;
  return {
    url: `http://${hostname}:${address.port}`,
    close: () => (closing ??= (async () => {
      await new Promise(resolve => server.close(() => resolve()));
      await runtime.close();
    })()),
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { values } = parseArgs({ options: { origin: { type: 'string' }, port: { type: 'string', default: '4191' }, project: { type: 'string' }, 'trusted-proxies': { type: 'string' } } });
  try {
    const running = await start({ origin: values.origin, port: Number(values.port), ...(values.project ? { project: values.project } : {}),
      ...(values['trusted-proxies'] ? { trustedProxies: values['trusted-proxies'].split(',') } : {}) });
    process.stdout.write(JSON.stringify({ event: 'listening', url: running.url }) + '\n');
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void running.close().then(() => process.exit(0)); });
  } catch (error) {
    // Startup refusal: the URLCode message, no stack, non-zero exit, nothing listening.
    process.stderr.write(JSON.stringify({ event: 'error', message: error instanceof Error ? error.message : String(error) }) + '\n');
    process.exit(1);
  }
}
