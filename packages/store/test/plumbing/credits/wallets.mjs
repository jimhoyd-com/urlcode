// The host-transaction counterexample of recipes/store-credits (#902 item 6): trusted operator code that serves
// /api/wallets/* through StoreExports.transaction, with the transfers, the issuer gate, conservation, retries, the owner
// and its authorization written by hand. A measurement fixture for docs/FRAMEWORK.md, not a recipe: the declared
// `transfers` replace it.
import { defineExtension, isSameOriginRequest, jsonResponse, readBody } from '@jimhoyd/urlcode/extensions';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_PER_OWNER = 10;
// Each transfer's floor: the lowest balance it may leave the debited wallet holding, and who may run it.
const TRANSFERS = {
  pay: { min: 0 },
  issue: { min: -1000000, members: 'issuers' },
};

class Refusal extends Error {
  constructor(status, code, message, headers = []) {
    super(message);
    Object.assign(this, { status, code, headers });
  }
}

// What a caller sees of a wallet: everything but the owner.
function view(record) {
  const { owner: _owner, ...shown } = record;
  return shown;
}
// Every answer is a JSON value, so that a retried request can be answered from the kept result.
function answer(status, found, headers = []) {
  return { status, body: view(found.record), headers: [['etag', found.etag], ...headers] };
}
function failure(error) {
  // A StoreError, a readBody error and a Refusal all carry an HTTP status and a code.
  if (typeof error?.status !== 'number' || typeof error?.code !== 'string') {
    return jsonResponse(500, { error: { code: 'internal_error', message: 'The request failed' } });
  }
  const { status, code, message, issues } = error;
  return jsonResponse(status, { error: { code, message, ...(issues ? { issues } : {}) } }, error.headers ?? []);
}

function json(request) {
  const body = readBody(request, { maxBytes: 16384 });
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new Refusal(422, 'invalid_record', 'The body must be a JSON object');
  }
  return body;
}
// The body of a create, PUT or PATCH. Only a transfer changes a balance, so no body may name it, or the owner.
function values(request, complete) {
  const body = json(request);
  for (const name of ['balance', 'owner']) {
    if (Object.hasOwn(body, name)) throw new Refusal(422, 'invalid_record', `${name} cannot be set`);
  }
  // PUT replaces the wallet, but tx.update merges, so a PUT must name every writable property.
  if (complete && !Object.hasOwn(body, 'name')) throw new Refusal(422, 'invalid_record', 'PUT needs name');
  return body;
}
function transferBody(request) {
  const body = json(request);
  const { from, to, amount } = body;
  const valid = Object.keys(body).length === 3 && UUID.test(from) && UUID.test(to) && from !== to
    && Number.isSafeInteger(amount) && amount >= 1;
  if (!valid) throw new Refusal(422, 'invalid_transfer', 'The body must be {from, to, amount}: two wallet ids and a positive whole amount');
  return { from, to, amount };
}

function* every(records) {
  let cursor;
  do {
    const page = records.list(null, cursor === undefined ? {} : { cursor });
    yield* page.items;
    cursor = page.next;
  } while (cursor !== undefined);
}
// One of the caller's wallets; another owner's is answered as a missing one.
function own(wallets, principal, id) {
  const found = wallets.get(null, id);
  if (found.record.owner !== principal) throw new Refusal(404, 'not_found', 'No such record');
  return found;
}

// Moves amount from one of the caller's wallets to anyone's in the surrounding transaction, so the sum never changes.
function transfer(tx, request, principal, name, ifMatch) {
  const rule = TRANSFERS[name];
  const { from, to, amount } = transferBody(request);
  if (rule.members !== undefined && ![...every(tx.records(rule.members))].some(member => member.userId === principal)) {
    throw new Refusal(403, 'membership_required', 'Only members may run this transfer');
  }
  const wallets = tx.records('wallets');
  const debited = own(wallets, principal, from);
  // If-Match guards what the caller read before spending: the debited wallet's ETag.
  if (ifMatch !== undefined && ifMatch !== debited.etag) throw new Refusal(412, 'precondition_failed', 'The record has changed');
  const left = debited.record.balance - amount;
  if (left < rule.min) throw new Refusal(409, 'insufficient_balance', 'The balance is too low for this transfer');
  const credited = wallets.get(null, to);
  const received = credited.record.balance + amount;
  if (!Number.isSafeInteger(left) || !Number.isSafeInteger(received)) {
    throw new Refusal(409, 'transfer_limit', 'The transfer would leave a balance its property does not allow');
  }
  const after = wallets.update(null, from, { balance: left }, { ifMatch: debited.etag });
  const other = wallets.update(null, to, { balance: received }, { ifMatch: credited.etag });
  // The credited wallet is shown only to its owner.
  const body = { from: view(after.record), ...(credited.record.owner === principal ? { to: view(other.record) } : {}) };
  return { status: 200, body, headers: [['etag', after.etag]] };
}

function serve(tx, request, principal) {
  const wallets = tx.records('wallets');
  const method = request.method.toUpperCase();
  const ifMatch = request.headers.get('if-match') ?? undefined;
  const [id, action, ...extra] = request.path.slice(request.mount.length).split('/').filter(Boolean);
  if (id === undefined) {
    if (method === 'GET' || method === 'HEAD') {
      const items = [...every(wallets)].filter(record => record.owner === principal).map(view);
      return { status: 200, body: { items, total: items.length } };
    }
    if (method !== 'POST') throw new Refusal(405, 'method_not_allowed', 'Method not allowed', [['allow', 'GET, HEAD, POST']]);
    const body = values(request, false);
    const held = [...every(wallets)].filter(record => record.owner === principal).length;
    if (held >= MAX_PER_OWNER) throw new Refusal(409, 'owner_quota_exceeded', 'You hold the most records this collection allows each user');
    const created = wallets.create(null, { ...body, owner: principal });
    return answer(201, created, [['location', `${request.mount}/${created.record.id}`]]);
  }
  if (id === 'transfers' && Object.hasOwn(TRANSFERS, action ?? '') && extra.length === 0) {
    if (method !== 'POST') throw new Refusal(405, 'method_not_allowed', 'Method not allowed', [['allow', 'POST']]);
    return transfer(tx, request, principal, action, ifMatch);
  }
  if (!UUID.test(id) || action !== undefined) throw new Refusal(404, 'not_found', 'No such record');
  if (method === 'GET' || method === 'HEAD') return answer(200, own(wallets, principal, id));
  if (method === 'PUT' || method === 'PATCH') {
    const body = values(request, method === 'PUT');
    own(wallets, principal, id);
    return answer(200, wallets.update(null, id, body, { ifMatch }));
  }
  if (method === 'DELETE') {
    // A wallet leaves only at 0, so deleting one never changes the sum.
    if (own(wallets, principal, id).record.balance !== 0) {
      throw new Refusal(409, 'balance_not_zero', 'The record still holds a balance; transfer it to another record before deleting it');
    }
    wallets.remove(null, id, { ifMatch });
    return { status: 204 };
  }
  throw new Refusal(405, 'method_not_allowed', 'Method not allowed', [['allow', 'GET, HEAD, PUT, PATCH, DELETE']]);
}

// A write with an Idempotency-Key runs at most once per principal and key; a retry answers the kept result.
function retry(request, principal) {
  const key = request.headers.get('idempotency-key');
  if (key === null) return undefined;
  if ((request.headerCounts['idempotency-key'] ?? 1) !== 1 || key.length < 1 || key.length > 128 || /[\u0000-\u001f\u007f]/.test(key)) {
    throw new Refusal(400, 'invalid_idempotency_key', 'Idempotency-Key must be one header value no longer than 128 characters');
  }
  const body = new TextDecoder().decode(request.body);
  return { idempotencyKey: `wallets:${principal}:${key}`, fingerprint: `${request.method.toUpperCase()} ${request.path} ${body}` };
}

export default defineExtension({
  name: 'wallets',
  description: 'Credit wallets served through host transactions (a measurement fixture)',
  contract: 1,
  targets: ['node'],
  requires: ['store'],
  schema: { type: 'object', additionalProperties: false },
  host(context) {
    const store = context.get('store');
    const schema = { type: 'object', additionalProperties: false };
    const registration = {
      name: 'wallets', version: '1', projectSha256: context.projectSha256, targets: ['node'], schema,
      activate(_config, site) {
        return {
          handle(request) {
            const principal = request.principal?.id;
            if (principal === undefined) return failure(new Refusal(401, 'principal_required', 'Sign in to use this collection'));
            const write = !['GET', 'HEAD'].includes(request.method.toUpperCase());
            try {
              if (write && !isSameOriginRequest(request, site, { whenAbsent: 'admit' })) {
                throw new Refusal(403, 'forbidden_origin', 'Cross-origin writes are refused');
              }
              const options = write ? retry(request, principal) : undefined;
              let ran = false;
              // One BEGIN IMMEDIATE transaction: the balances read, both writes and the retry claim commit together.
              const result = store.transaction(tx => { ran = true; return serve(tx, request, principal); }, options);
              const headers = [...(result.headers ?? []), ...(ran ? [] : [['idempotency-replayed', 'true']])];
              if (result.status === 204) return { status: 204, headers: [['cache-control', 'no-store'], ...headers] };
              return jsonResponse(result.status, result.body, headers);
            } catch (error) {
              return failure(error);
            }
          },
        };
      },
    };
    return { registration };
  },
});
