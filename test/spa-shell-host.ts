import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import type {HostPlugin} from '../packages/core/src/runtime.ts';

export interface SpaShellOptions { route?: string; shell?: string; exclude?: string[]; api?: string[] }
export interface SpaShellHost { path: string; default: {extensions: unknown[]; plugins: HostPlugin[]}; spaShell(options?: SpaShellOptions): HostPlugin }

/** The spa-shell recipe's host file exactly as its README teaches it, written to `directory` (outside the project) with
 * the package specifier pointed at this checkout, then imported. Tests exercise the README code, not a copy of it. */
export async function readmeHost(directory: string): Promise<SpaShellHost> {
  const readme=await readFile(new URL('../recipes/spa-shell/README.md',import.meta.url),'utf8');
  const example=/## The host file[\s\S]*?```js\n([\s\S]*?)```/.exec(readme)?.[1];
  if(!example?.includes(`'@jimhoyd/urlcode/host'`))throw new Error('The spa-shell README must carry the host file importing @jimhoyd/urlcode/host');
  await mkdir(directory,{recursive:true});
  const path=join(directory,'host.mjs');
  await writeFile(path,example.replace(`'@jimhoyd/urlcode/host'`,JSON.stringify(new URL('../packages/core/src/host.ts',import.meta.url).href)));
  return {path,...await import(pathToFileURL(path).href) as Omit<SpaShellHost,'path'>};
}
