// The host-transaction counterexample of recipes/store-booking (#902 item 6): trusted operator code that serves
// /api/bookings/* through StoreExports.transaction, with the overlap check, the owner and its authorization written by
// hand. A measurement fixture for docs/FRAMEWORK.md, not a recipe: the declared `intervals` constraint replaces it.
import { defineExtension, isSameOriginRequest, jsonResponse, readBody } from '@jimhoyd/urlcode/extensions';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_PER_OWNER = 100;
const WRITABLE = ['room', 'start', 'end'];

class Refusal extends Error {
  constructor(status, code, message, headers = []) {
    super(message);
    Object.assign(this, { status, code, headers });
  }
}

// What a caller sees of a booking: everything but the owner.
function view({ record, etag }) {
  const { owner: _owner, ...shown } = record;
  return { shown, etag };
}
function answer(status, found, headers = []) {
  const { shown, etag } = view(found);
  return jsonResponse(status, shown, [['etag', etag], ...headers]);
}
function failure(error) {
  // A StoreError, a readBody error and a Refusal all carry an HTTP status and a code.
  if (typeof error?.status !== 'number' || typeof error?.code !== 'string') {
    return jsonResponse(500, { error: { code: 'internal_error', message: 'The request failed' } });
  }
  const { status, code, message, issues } = error;
  return jsonResponse(status, { error: { code, message, ...(issues ? { issues } : {}) } }, error.headers ?? []);
}

// The body of a create, PUT or PATCH: a JSON object that never names the owner.
function values(request, complete) {
  const body = readBody(request, { maxBytes: 16384 });
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new Refusal(422, 'invalid_record', 'The body must be a JSON object');
  }
  if (Object.hasOwn(body, 'owner')) throw new Refusal(422, 'invalid_record', 'owner cannot be set');
  // PUT replaces the record, but tx.update merges, so a PUT must name every writable property.
  if (complete && WRITABLE.some(name => !Object.hasOwn(body, name))) {
    throw new Refusal(422, 'invalid_record', `PUT needs ${WRITABLE.join(', ')}`);
  }
  return body;
}

// Every booking of every owner, page by page.
function* everyBooking(bookings) {
  let cursor;
  do {
    const page = bookings.list(null, cursor === undefined ? {} : { cursor });
    yield* page.items;
    cursor = page.next;
  } while (cursor !== undefined);
}

// The interval rules: end after start, and no overlap with another booked booking of the same room, whoever owns it.
function checkInterval(bookings, record) {
  const start = Date.parse(record.start);
  const end = Date.parse(record.end);
  if (!(end > start)) throw new Refusal(422, 'invalid_record', 'end must be after start');
  if (record.status !== 'booked') return;
  for (const other of everyBooking(bookings)) {
    if (other.id === record.id || other.room !== record.room || other.status !== 'booked') continue;
    if (start < Date.parse(other.end) && Date.parse(other.start) < end) {
      throw new Refusal(409, 'interval_conflict', 'The interval overlaps another record');
    }
  }
}

// One of the caller's bookings; another owner's is answered as a missing one.
function own(bookings, principal, id) {
  const found = bookings.get(null, id);
  if (found.record.owner !== principal) throw new Refusal(404, 'not_found', 'No such record');
  return found;
}

function serve(tx, request, principal) {
  const bookings = tx.records('bookings');
  const method = request.method.toUpperCase();
  const ifMatch = request.headers.get('if-match') ?? undefined;
  const [id, action, ...extra] = request.path.slice(request.mount.length).split('/').filter(Boolean);
  if (id === undefined) {
    if (method === 'GET' || method === 'HEAD') {
      const items = [...everyBooking(bookings)].filter(record => record.owner === principal);
      return jsonResponse(200, { items: items.map(record => view({ record }).shown), total: items.length });
    }
    if (method !== 'POST') throw new Refusal(405, 'method_not_allowed', 'Method not allowed', [['allow', 'GET, HEAD, POST']]);
    const body = values(request, false);
    const held = [...everyBooking(bookings)].filter(record => record.owner === principal).length;
    if (held >= MAX_PER_OWNER) throw new Refusal(409, 'owner_quota_exceeded', 'You hold the most records this collection allows each user');
    const created = bookings.create(null, { ...body, owner: principal });
    checkInterval(bookings, created.record);
    return answer(201, created, [['location', `${request.mount}/${created.record.id}`]]);
  }
  if (!UUID.test(id) || extra.length > 0) throw new Refusal(404, 'not_found', 'No such record');
  if (action === 'cancel') {
    if (method !== 'POST') throw new Refusal(405, 'method_not_allowed', 'Method not allowed', [['allow', 'POST']]);
    if (request.body.byteLength > 0) throw new Refusal(400, 'body_not_allowed', 'A transition takes no request body');
    own(bookings, principal, id);
    return answer(200, bookings.transition(null, id, 'cancel', { ifMatch }));
  }
  if (action !== undefined) throw new Refusal(404, 'not_found', 'No such record');
  if (method === 'GET' || method === 'HEAD') return answer(200, own(bookings, principal, id));
  if (method === 'PUT' || method === 'PATCH') {
    const body = values(request, method === 'PUT');
    own(bookings, principal, id);
    const updated = bookings.update(null, id, body, { ifMatch });
    checkInterval(bookings, updated.record);
    return answer(200, updated);
  }
  if (method === 'DELETE') {
    own(bookings, principal, id);
    bookings.remove(null, id, { ifMatch });
    return { status: 204, headers: [['cache-control', 'no-store']] };
  }
  throw new Refusal(405, 'method_not_allowed', 'Method not allowed', [['allow', 'GET, HEAD, PUT, PATCH, DELETE']]);
}

export default defineExtension({
  name: 'bookings',
  description: 'Room bookings served through a host transaction (a measurement fixture)',
  contract: 2,
  targets: ['node'],
  requires: ['store'],
  schema: { type: 'object', additionalProperties: false },
  host(context) {
    const store = context.get('store');
    const schema = { type: 'object', additionalProperties: false };
    const registration = {
      name: 'bookings', version: '1', projectSha256: context.projectSha256, targets: ['node'], schema,
      activate(_config, site) {
        return {
          handle(request) {
            const principal = request.principal?.id;
            if (principal === undefined) return failure(new Refusal(401, 'principal_required', 'Sign in to use this collection'));
            const write = !['GET', 'HEAD'].includes(request.method.toUpperCase());
            if (write && !isSameOriginRequest(request, site, { whenAbsent: 'admit' })) {
              return failure(new Refusal(403, 'forbidden_origin', 'Cross-origin writes are refused'));
            }
            try {
              // One BEGIN IMMEDIATE transaction: the overlap scan and the write it guards see the same bookings.
              return store.transaction(tx => serve(tx, request, principal));
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
