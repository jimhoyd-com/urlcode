import assert from 'node:assert/strict';

const clip = (text: string) => text.length > 2000 ? `${text.slice(0, 2000)}... [truncated ${text.length - 2000} chars]` : text;

// npm can print wrapper noise (for example "built N modules") ahead of the
// --json payload; find the trailing JSON array instead of trusting stdout.
export function parsePackJson<T = unknown>(stdout: string, stderr = ''): T[] {
  const lines = stdout.split('\n');
  for (let index = lines.length - 1; index >= 0; index--) {
    if (!lines[index]!.startsWith('[')) continue;
    try {
      const parsed: unknown = JSON.parse(lines.slice(index).join('\n'));
      if (Array.isArray(parsed)) return parsed as T[];
    } catch { /* keep looking for an earlier array start */ }
  }
  assert.fail(`npm pack --json did not print a JSON array.\nstdout:\n${clip(stdout)}\nstderr:\n${clip(stderr)}`);
}
