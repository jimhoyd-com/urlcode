import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { TestContext } from 'node:test';

interface RunResult { status: number; stdout: string; stderr: string }
interface AgentOptions { status?: number }

const script = fileURLToPath(new URL('../examples/tunnel/dev-with-ngrok.sh', import.meta.url));
const windows = process.platform === 'win32';

// Serve what the ngrok agent's local inspection API returns, so tunnel selection
// is exercised against the real response shape rather than a mock of our own.
async function agent(t: TestContext, body: unknown, { status = 200 }: AgentOptions = {}): Promise<string> {
  const server = http.createServer((req,res) => {
    res.writeHead(status,{'content-type':'application/json'});
    res.end(typeof body === 'string' ? body : JSON.stringify(body));
  });
  await new Promise<void>(resolve => server.listen(0,'127.0.0.1',resolve));
  t.after(() => { server.closeAllConnections(); return new Promise<void>(resolve => server.close(() => resolve())); });
  const address = server.address();
  assert.ok(address !== null && typeof address === 'object','agent server has no address');
  return `http://127.0.0.1:${address.port}/api/tunnels`;
}
const tunnel = (publicUrl: string, addr: string, proto = 'https') => ({public_url:publicUrl,proto,config:{addr}});
// Never spawnSync here: the script fetches from a server in this process.
const run = (api: string, env: Record<string, string> = {}): Promise<RunResult> => new Promise(resolve => {
  execFile('sh',[script,'--print'],{encoding:'utf8',timeout:60000,
    env:{...process.env,URLCODE_NGROK_API:api,PORT:'3000',...env}},
    (error,stdout,stderr) => resolve({status:error?(typeof error.code === 'number' ? error.code : 1):0,stdout,stderr}));
});

test('the tunnel origin is taken from the tunnel forwarding to this port',{skip:windows && 'POSIX shell script'},async t => {
  const api = await agent(t,{tunnels:[
    tunnel('http://plain.ngrok-free.app','http://localhost:3000','http'),
    tunnel('https://other.ngrok-free.app','http://localhost:9999'),
    tunnel('https://correct.ngrok-free.app','http://localhost:3000'),
  ]});
  const result = await run(api);
  assert.equal(result.status,0,result.stderr);
  assert.match(result.stdout,/public origin https:\/\/correct\.ngrok-free\.app/);
});

test('a tunnel for a different port is never guessed at',{skip:windows && 'POSIX shell script'},async t => {
  const api = await agent(t,{tunnels:[tunnel('https://elsewhere.ngrok-free.app','http://localhost:9999')]});
  const result = await run(api);
  assert.equal(result.status,1);
  assert.match(result.stderr,/no https tunnel forwarding to port 3000/);
  assert.doesNotMatch(result.stdout,/public origin/);
});

test('an unreachable, empty or malformed agent fails with a usable message',{skip:windows && 'POSIX shell script'},async t => {
  const cases: Array<[unknown, AgentOptions]> = [[{tunnels:[]},{}],[{},{}],['not json',{}],[{tunnels:[]},{status:502}]];
  for (const [body,options] of cases) {
    const api = await agent(t,body,options);
    const result = await run(api);
    assert.equal(result.status,1);
    assert.match(result.stderr,/dev-with-ngrok/);
  }
  const dead = await run('http://127.0.0.1:1/api/tunnels');
  assert.equal(dead.status,1);
  assert.match(dead.stderr,/ngrok http 3000/);
});
