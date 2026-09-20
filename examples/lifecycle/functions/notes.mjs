import { randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// Trusted first-party code: it writes to the data directory.
// The directory comes from a declared env binding; `urlcode test` gives every run a fresh one.
const file = (env, id) => join(env.DATA_DIR, `note-${id}.json`);

export async function create(request, { env }) {
  const { text } = await request.json();
  const id = randomBytes(4).toString('hex');
  await writeFile(file(env, id), JSON.stringify({ id, text, version: 1 }));
  return new Response(JSON.stringify({ id, text, version: 1 }), {
    status: 201, headers: { 'content-type': 'application/json', location: `/notes/${id}` },
  });
}

export async function note(request, { args, env }) {
  // The id becomes part of a file name: accept only what create() issues.
  if (!/^[0-9a-f]{8}$/.test(args.id)) return Response.json({ error: 'not found' }, { status: 404 });
  let current;
  try { current = JSON.parse(await readFile(file(env, args.id), 'utf8')); }
  catch { return Response.json({ error: 'not found' }, { status: 404 }); }
  if (request.method === 'PUT') {
    current = { ...current, text: (await request.json()).text, version: current.version + 1 };
    await writeFile(file(env, args.id), JSON.stringify(current));
  }
  return Response.json(current);
}
