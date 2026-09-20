import {readFile} from 'node:fs/promises';
import {join} from 'node:path';

const safeName = /^[a-z0-9-]{1,64}$/;

// Trusted function: `env.DATA_DIR` is the operator-resolved {env: DATA_DIR}
// binding, so the host chooses the directory and this code never reads
// process.env. The name is still request data: validate it before joining.
export default async function note(request, {args, env}) {
  if (!safeName.test(args.name)) return Response.json({error: 'unknown note'}, {status: 404});
  try {
    const text = await readFile(join(env.DATA_DIR, `${args.name}.txt`), 'utf8');
    return Response.json({name: args.name, text: text.trimEnd()});
  } catch (error) {
    if (error.code === 'ENOENT') return Response.json({error: 'unknown note'}, {status: 404});
    throw error;
  }
}
