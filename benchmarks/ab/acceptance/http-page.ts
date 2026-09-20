// Acceptance for the hello-world A/B task: start the app the way its README does,
// request one page, check status, content type, doctype, balanced tags and the
// expected text, then stop the server. Runs no model and touches only --dir.
//   node benchmarks/ab/acceptance/http-page.ts --dir <app> --start "npm start" --port 3000 --expect "Hello World"
import { spawn } from 'node:child_process';
import { parseArgs } from 'node:util';

export interface PageCheck { name: string; pass: boolean; detail?: string }

export function checkPage(status: number, contentType: string, body: string, expect: string): PageCheck[] {
  const tags = (name: string) => (body.match(new RegExp(`<${name}[\\s>]`, 'gi')) ?? []).length === (body.match(new RegExp(`</${name}>`, 'gi')) ?? []).length;
  return [
    { name: 'status 200', pass: status === 200, detail: String(status) },
    { name: 'content type text/html', pass: /^text\/html/i.test(contentType), detail: contentType },
    { name: 'doctype', pass: /^\s*<!doctype html/i.test(body) },
    { name: 'balanced html/head/body', pass: ['html', 'head', 'body'].every(tags) },
    { name: `contains "${expect}"`, pass: body.includes(expect) },
  ];
}

async function main() {
  const { values } = parseArgs({ options: { dir: { type: 'string' }, start: { type: 'string', default: 'npm start' }, port: { type: 'string', default: '3000' }, path: { type: 'string', default: '/' }, expect: { type: 'string', default: 'Hello World' } } });
  if (!values.dir) { console.error('--dir is required'); process.exit(2); }
  const child = spawn(values.start!, { cwd: values.dir, shell: true, env: { ...process.env, PORT: values.port! }, stdio: 'ignore', detached: true });
  const url = `http://127.0.0.1:${values.port}${values.path}`;
  let response: Response | undefined;
  for (let i = 0; i < 50 && !response; i++) {
    try { response = await fetch(url); } catch { await new Promise(r => setTimeout(r, 200)); }
  }
  const checks = response ? checkPage(response.status, response.headers.get('content-type') ?? '', await response.text(), values.expect!) : [{ name: 'server started', pass: false, detail: `no answer from ${url}` }];
  try { process.kill(-child.pid!); } catch { /* already gone */ }
  console.log(JSON.stringify(checks, null, 1));
  process.exit(checks.every(c => c.pass) ? 0 : 1);
}
if (import.meta.filename === process.argv[1]) await main();
