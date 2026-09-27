#!/usr/bin/env node
// Hosted-assisted mode's HTTP fallback (#806): one bounded MCP exchange with
// the URLCode AI endpoint when no hosted MCP server is registered in the
// client. It sends exactly one tool argument, `task` (the published
// urlcode_task_plan input schema accepts nothing else), and compares the
// runtime the returned kit is pinned to with the runtime the site runs. It
// prints one JSON object and never writes files or reads the project.
//
//   node hosted-plan.mjs --task TEXT --runtime X.Y.Z [--capabilities a,b] [--timeout-ms N]
//
// Exit 0: `outcome: ok`, `hostedGuidance: used`. 1: unavailable (network,
// timeout, HTTP, protocol, tool error or malformed reply). 2: refused input,
// nothing sent. 3: version-mismatch, kit withheld. Only exit 0 means hosted
// guidance may be used or claimed.
import { parseArgs } from 'node:util';

const DEFAULT_ENDPOINT = 'https://urlcode.ai/mcp';
const PROTOCOL_VERSION = '2025-06-18';
const MAX_TASK = 512; // the published inputSchema's maxLength
const MAX_REPLY_BYTES = 1024 * 1024;
const SECRET = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/, /\b[spr]k_(?:live|test)_[A-Za-z0-9]{8,}/, /\bgh[pousr]_[A-Za-z0-9]{20,}/,
  /\bAKIA[0-9A-Z]{16}\b/, /\bxox[abprs]-[A-Za-z0-9-]{10,}/, /\bBearer\s+[A-Za-z0-9._~+/-]{16,}/i,
  /\b(?:password|passwd|secret|api[_-]?key|token)\s*[:=]\s*\S+/i,
];

const emit = (code, result) => { process.stdout.write(`${JSON.stringify(result, null, 2)}\n`); process.exit(code); };
const refuse = message => emit(2, { outcome: 'invalid-input', hostedGuidance: 'not-used', message, sent: null });

let options;
try {
  ({ values: options } = parseArgs({ options: {
    task: { type: 'string' }, runtime: { type: 'string' }, capabilities: { type: 'string' },
    endpoint: { type: 'string' }, 'timeout-ms': { type: 'string' },
  } }));
} catch (error) { refuse(error.message); }

const runtime = options.runtime ?? '';
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(runtime)) refuse('--runtime must be the exact installed runtime version from urlcode bootstrap (runtime.installed.version, or runtime.running.version when status is matched).');
const capabilities = (options.capabilities ?? '').split(',').map(name => name.trim()).filter(Boolean);
if (capabilities.length > 8 || capabilities.some(name => !/^[a-z][a-z0-9-]{0,39}$/.test(name))) refuse('--capabilities takes at most eight comma-separated capability names.');
const described = (options.task ?? '').replace(/\s+/g, ' ').trim();
if (!described) refuse('--task is required: the requirements in plain words.');
if (SECRET.some(pattern => pattern.test(described))) refuse('The task text looks like it contains a secret. Describe the requirement without it; nothing was sent.');
// Capability names go first: the service keeps only the first few search terms.
const task = capabilities.length ? `${capabilities.join(' ')}: ${described}` : described;
if (task.length > MAX_TASK) refuse(`The task text is ${task.length} characters; the hosted tool accepts ${MAX_TASK}. Summarize the requirements; nothing was sent.`);

let endpoint;
try { endpoint = new URL(options.endpoint ?? DEFAULT_ENDPOINT); } catch { refuse('--endpoint is not a URL.'); }
const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname);
if (endpoint.protocol !== 'https:' && !(endpoint.protocol === 'http:' && loopback)) refuse('--endpoint must be https (plain http only on a loopback host).');
const timeoutMs = Math.min(60000, Math.max(1000, Number(options['timeout-ms'] ?? 20000) || 20000));

const sent = { tool: 'urlcode_task_plan', arguments: { task } };
const base = { endpoint: endpoint.href, sent, runtime: { installed: runtime } };
class Unavailable extends Error { constructor(outcome, message, extra = {}) { super(message); this.outcome = outcome; this.extra = extra; } }

const signal = AbortSignal.timeout(timeoutMs);
let session = null;
let negotiated = null;

async function readBounded(response) {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_REPLY_BYTES) { await reader.cancel(); throw new Unavailable('malformed', `The reply exceeded ${MAX_REPLY_BYTES} bytes.`); }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function post(message) {
  const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
  if (negotiated) headers['mcp-protocol-version'] = negotiated;
  if (session) headers['mcp-session-id'] = session;
  const response = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(message), signal, redirect: 'error' });
  const text = await readBounded(response);
  if (response.status < 200 || response.status > 299) throw new Unavailable('http-error', `HTTP ${response.status} from the hosted endpoint.`, { status: response.status, body: text.slice(0, 200) });
  return { response, text };
}

function rpcResult({ response, text }, id) {
  let reply;
  try {
    if (/^text\/event-stream/i.test(response.headers.get('content-type') ?? '')) {
      const events = text.split(/\r?\n\r?\n/).map(event => event.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('\n')).filter(Boolean);
      reply = events.map(data => JSON.parse(data)).find(message => message?.id === id);
    } else reply = JSON.parse(text);
  } catch { throw new Unavailable('malformed', 'The reply was not JSON-RPC.'); }
  if (!reply || reply.jsonrpc !== '2.0' || reply.id !== id) throw new Unavailable('malformed', 'The reply was not a JSON-RPC response to this request.');
  if (reply.error) throw new Unavailable('rpc-error', `JSON-RPC error ${reply.error.code}: ${String(reply.error.message).slice(0, 300)}`);
  if (!reply.result || typeof reply.result !== 'object') throw new Unavailable('malformed', 'The JSON-RPC response has no result object.');
  return reply.result;
}

try {
  const init = await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'urlcode-authoring-skill', version: '1' } } });
  const initialized = rpcResult(init, 1);
  if (typeof initialized.protocolVersion !== 'string') throw new Unavailable('malformed', 'initialize returned no protocolVersion.');
  negotiated = initialized.protocolVersion;
  session = init.response.headers.get('mcp-session-id');
  await post({ jsonrpc: '2.0', method: 'notifications/initialized' });
  const result = rpcResult(await post({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'urlcode_task_plan', arguments: { task } } }), 2);
  const text = Array.isArray(result.content) ? result.content.find(item => item?.type === 'text')?.text : undefined;
  if (result.isError) throw new Unavailable('tool-error', `urlcode_task_plan reported an error: ${String(text ?? 'no message').slice(0, 300)}`);
  let plan = result.structuredContent;
  if (!plan || typeof plan !== 'object') {
    try { plan = JSON.parse(text); } catch { throw new Unavailable('malformed', 'urlcode_task_plan did not return a JSON plan.'); }
  }
  const hosted = plan?.kit?.runtime?.version ?? plan?.install?.version;
  if (!plan || typeof plan.kit !== 'object' || typeof hosted !== 'string') throw new Unavailable('malformed', 'The plan has no kit pinned to a runtime version.');
  if (hosted !== runtime) emit(3, { outcome: 'version-mismatch', hostedGuidance: 'not-used', ...base, runtime: { installed: runtime, hosted },
    message: `The hosted kit is pinned to ${hosted}; this site runs ${runtime}. The kit was withheld: do not mix its references with this runtime or upgrade the site to match. Continue local-only.` });
  emit(0, { outcome: 'ok', hostedGuidance: 'used', ...base, runtime: { installed: runtime, hosted }, plan });
} catch (error) {
  const aborted = signal.aborted || error?.name === 'TimeoutError' || error?.name === 'AbortError';
  const outcome = error instanceof Unavailable ? error.outcome : aborted ? 'timeout' : 'unavailable';
  const message = error instanceof Unavailable ? error.message
    : aborted ? `No complete reply within ${timeoutMs} ms.`
    : `The hosted endpoint could not be reached: ${error?.cause?.code ?? error?.message ?? 'unknown error'}.`;
  emit(1, { outcome, hostedGuidance: 'not-used', ...base, message: `${message} Hosted guidance is unavailable; continue local-only and say so.`, ...(error?.extra ?? {}) });
}
