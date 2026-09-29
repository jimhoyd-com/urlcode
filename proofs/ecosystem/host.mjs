// Trusted operator host: keep it outside app/ and review it like any other code you deploy. The same file serves
// both hosting modes: `urlcode serve --host-file host.mjs` loads it, and hono/server.mjs imports it and passes the
// same registrations to createRuntime. Both extensions are plain host code with no package, descriptor or catalog
// entry. PROJECT_SHA256 is the reviewed project revision (`urlcode extensions --project app --host-file host.mjs`).
import { Hono } from 'hono';
import { isSameOriginRequest } from '@jimhoyd/urlcode/extensions';

const registration = { version: '1', projectSha256: process.env.PROJECT_SHA256 ?? '', targets: ['node'], schema: { type: 'object', additionalProperties: false } };

// Answers with the origin, client address and same-origin verdict URLCode handed it, so the two hosting modes can be
// compared request for request.
const probe = {
  ...registration, name: 'probe',
  activate(_config, context) {
    const site = { origin: context.origin, origins: context.origins };
    return {
      handle(request) {
        return {
          status: 200, headers: [['content-type', 'application/json']],
          body: JSON.stringify({ path: request.path, origin: request.origin, client: request.client, sameOrigin: isSameOriginRequest(request, site, { whenAbsent: 'refuse' }) }),
        };
      },
    };
  },
};

// A whole Hono application behind an `extension:` mount (the reverse direction, operator side). The mount is a
// wildcard, so the app's own router decides the paths below it; review sees only the mount.
const hono = {
  ...registration, name: 'hono',
  activate(_config, context) {
    const [mount] = context.mounts;
    const app = new Hono().basePath(mount);
    app.get('/', c => c.json({ from: 'hono-extension', path: c.req.path }));
    app.get('/deep/:a/:b', c => c.json({ a: c.req.param('a'), b: c.req.param('b') }));
    app.post('/echo', async c => c.json({ got: await c.req.json() }));
    return {
      async handle(request) {
        const response = await app.fetch(new Request(request.origin + request.target, {
          method: request.method, headers: request.headers,
          body: ['GET', 'HEAD'].includes(request.method) ? undefined : request.body,
        }));
        return { status: response.status, headers: [...response.headers], body: new Uint8Array(await response.arrayBuffer()) };
      },
    };
  },
};

export default { extensions: [probe, hono] };
