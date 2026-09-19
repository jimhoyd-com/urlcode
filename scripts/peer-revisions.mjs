#!/usr/bin/env node
// Prints the peers.json revisions as GitHub Actions step outputs (name=sha) so the workflow checks out exactly what this checkout was verified against.
import { readFile, appendFile } from 'node:fs/promises';
const peers = JSON.parse(await readFile(new URL('../peers.json', import.meta.url), 'utf8'));
let lines = '';
for (const name of ['urlcode']) {
  if (!/^[a-f0-9]{40}$/.test(peers[name] ?? '')) throw new Error(`peers.json: ${name} must be a 40-character commit SHA`);
  lines += `${name}=${peers[name]}\n`;
}
if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, lines); else process.stdout.write(lines);
