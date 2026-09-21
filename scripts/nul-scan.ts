// A literal NUL byte in a text file makes Git classify the whole file as
// binary, so its diffs become unreviewable. Write the escape (\x00) instead.
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';

// Extensions that must stay text. Genuine binary assets (images, fonts, archives) are
// deliberately not listed, so they are never inspected.
export const textFile = /\.(?:[cm]?[jt]s|tsx?|jsx?|json|md|ya?ml|txt|html?|css|svg|sh|toml|mdx)$/i;

export function findNul(files: readonly { path: string; bytes: Uint8Array }[]): string[] {
  return files.filter(f => textFile.test(f.path) && f.bytes.includes(0)).map(f => f.path);
}

export async function trackedTextFilesWithNul(root: string): Promise<string[]> {
  // The release container mounts the source under another owner, and git refuses it as "dubious ownership"; trusting this one
  // directory on the command line (a protected scope) keeps the check runnable there without touching global config.
  const paths = execFileSync('git', ['-c', `safe.directory=${root}`, 'ls-files', '-z'], { cwd: root, encoding: 'utf8', maxBuffer: 1 << 28 }).split('\0').filter(p => p && textFile.test(p));
  const files = [];
  for (const path of paths) files.push({ path, bytes: await readFile(`${root}/${path}`).catch(() => new Uint8Array()) });
  return findNul(files);
}
