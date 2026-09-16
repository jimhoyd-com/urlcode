import { readFile } from 'node:fs/promises';
import { request } from 'node:http';
import { startServer } from './server.js';
import { safeFile } from './config.js';
import { realpath } from 'node:fs/promises';
import { assert } from './errors.js';

export async function runProjectTests(project, { log = () => {} } = {}) {
  const root = await realpath(project);
  const file = await safeFile(root,'tests/requests.json');
  const cases = JSON.parse(await readFile(file,'utf8'));
  assert(Array.isArray(cases) && cases.length > 0 && cases.length <= 10000, 'Request tests must be a non-empty array (maximum 10000)');
  const app = await startServer({ project, port: 0, local: true, log });
  let failed = 0;
  try {
    for (const [i, test] of cases.entries()) {
      assert(typeof test.path === 'string' && test.path.startsWith('/') && !test.path.startsWith('//'), 'Test path must be local');
      assert(Number.isInteger(test.status), 'Test must declare expected status');
      const result = await new Promise((resolve,reject) => {
        const req = request({ host:'127.0.0.1', port: app.address.port, path:test.path, method:test.method || 'GET', headers:test.headers || {}, timeout:10000 }, res => {
          const chunks = []; let size = 0;
          res.on('data', chunk => { size += chunk.length; if (size > 1048576) res.destroy(new Error('Test response limit')); else chunks.push(chunk); });
          res.on('error',reject);
          res.on('end',() => resolve({ status:res.statusCode, headers:res.headers, body:Buffer.concat(chunks).toString() }));
        });
        req.on('error',reject); req.on('timeout',() => req.destroy(new Error('Test timeout')));
        req.end(test.body);
      });
      const pass = result.status === test.status && Object.entries(test.expectHeaders || {}).every(([key,value]) => result.headers[key.toLowerCase()] === value) && (test.expectBody === undefined || result.body === test.expectBody);
      if (!pass) failed++;
      // Do not echo response bodies, URLs or credentials on assertion failure.
      log({ event:'test', case:i + 1, pass, status:result.status });
    }
  } finally { await app.close(); }
  return { total:cases.length, failed };
}
