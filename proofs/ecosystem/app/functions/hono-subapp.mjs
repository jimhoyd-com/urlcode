// The reverse direction: a Hono application served from a URLCode trusted function route. Hono's app.fetch takes
// the standard Request the function receives and returns a standard Response; URLCode keeps the routes, their methods
// and parameter validation. Function routes have no wildcard, so urlcode.yaml declares each path this app serves.
// The function sees the full URL, so the sub-app's base path is the route prefix.
import { Hono } from 'hono';

const app = new Hono().basePath('/app/sub');
app.get('/hello', c => c.json({ from: 'hono', path: c.req.path }));
app.get('/items/:id', c => c.json({ id: c.req.param('id'), q: c.req.query('q') ?? null }));
app.post('/items', async c => c.json({ created: await c.req.json() }, 201));

export default request => app.fetch(request);
