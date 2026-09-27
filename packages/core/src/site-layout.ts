import { stat } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { PROJECT_DIRECTORY } from './addon-install.ts';

export const isFile = (path: string): Promise<boolean> => stat(path).then(info => info.isFile(), () => false);
/** The nearest ancestor (not the directory itself) that is a route project or a site, as a POSIX path relative to the directory. */
export async function enclosingProject(directory: string): Promise<string | undefined> {
  for (let current = dirname(directory); ; current = dirname(current)) {
    if (await isFile(join(current, 'urlcode.yaml')) || await isFile(join(current, PROJECT_DIRECTORY, 'urlcode.yaml'))) return relative(directory, current).split('\\').join('/');
    if (dirname(current) === current) return undefined;
  }
}
