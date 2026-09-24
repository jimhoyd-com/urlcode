// A fixture extension definition, shaped like defineExtension's result without importing core.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
const schema = { type: 'object', additionalProperties: false, properties: { greeting: { type: 'string' } } };
const definition = {
  name: 'alpha', description: 'Fixture extension with a mount and a key file', requires: [], schema,
  contributes: { beta: { from: 'alpha' } },
  scaffold: ({ installed }) => ({
    config: { greeting: 'hello' },
    routes: { '/alpha/*': { extension: 'alpha', methods: ['GET', 'HEAD'] } },
    files: [{ path: 'data/alpha.key', content: new Uint8Array(32).fill(7), mode: 0o600 }],
    env: { ALPHA_MODE: 'Optional mode for the fixture' },
    notes: [`installed: ${installed.join(',')}`],
  }),
  async host(ctx, options) {
    const key = await readFile(join(ctx.site, 'data', 'alpha.key'));
    return {
      registration: { name: 'alpha', version: '1', projectSha256: ctx.projectSha256, targets: ['node'], schema,
        activate: config => ({ handle: () => ({ status: 200, headers: { 'content-type': 'text/plain' }, body: `${config.greeting} ${options.suffix ?? ''}`.trim() }) }) },
      exports: { keyLength: key.length },
      close: () => { globalThis.alphaClosed = (globalThis.alphaClosed ?? 0) + 1; },
    };
  },
};
const entry = options => Object.freeze({ definition, options: options ?? {} });
entry.definition = definition;
export default entry;
