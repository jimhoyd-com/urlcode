import { readFile, stat } from 'node:fs/promises';
import { relative, dirname, resolve, sep, posix } from 'node:path';
import { init, parse } from 'es-module-lexer';
import { functionFile } from './config.ts';
import { assert } from './errors.ts';

export function routeFunctions(route) { return [...(route.middleware || []), ...(route.function ? [route.function] : [])]; }

// Parse and snapshot source without ever importing project code into Node.
export async function collectFunctionSources(routes, root) {
  await init;
  const sources = Object.create(null), dependencies = Object.create(null), entries = [], names = new Map(), seenEntries = new Set();
  let bytes = 0;
  async function collect(file) {
    const name = '/' + relative(root,file).split(sep).join('/');
    if (Object.hasOwn(sources,name)) return name;
    assert(Object.keys(sources).length < 128, 'Function module limit exceeded');
    const info = await stat(file);
    assert(info.size <= 1048576 && bytes + info.size <= 4194304, 'Function source limit exceeded');
    const code = await readFile(file,'utf8'); bytes += Buffer.byteLength(code);
    assert(bytes <= 4194304, 'Function source limit exceeded');
    sources[name] = code; dependencies[name] = [];
    const [imports] = parse(code);
    for (const item of imports) {
      assert(item.type === 'static' && typeof item.specifier === 'string' && !item.attributes && !item.phase, 'Dynamic imports and import.meta are unsupported in sandbox functions');
      assert(item.specifier.startsWith('./') || item.specifier.startsWith('../'), 'Only relative project JavaScript imports are allowed');
      const dependency = await functionFile(root,relative(root,resolve(dirname(file),item.specifier)));
      assert(posix.normalize(posix.join(posix.dirname(name),item.specifier)).startsWith('/'), 'Invalid module reference');
      dependencies[name].push(await collect(dependency));
    }
    return name;
  }
  for (const definition of routes.flatMap(routeFunctions)) {
    const name = await collect(definition.source);
    names.set(definition.source,name);
    const key = name + ":" + definition.export;
    if (!seenEntries.has(key)) { entries.push([name,definition.export]); seenEntries.add(key); }
  }
  return { sources,dependencies,entries,names };
}
