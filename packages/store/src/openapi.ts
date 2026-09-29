// The store's OpenAPI 3.1 contribution (core's `RuntimeExtension.describe`, RIM-OPENAPI-001): each store mount of a
// project described from its declaration alone, with every record, request and query schema built from the
// collection's own record schema. A collection whose schema is a project named schema (`schema: <name>`) references
// that component (core writes it once, as for a route body naming it) instead of copying it. Pure: no database is opened. Core adds what the runtime does on every extension
// answer (its always-set headers, Cache-Control: no-store) and what a sign-in gate on the route answers first.
import type { ExtensionDescribeRequest, ExtensionOpenApi } from '@jimhoyd/urlcode/extensions';
import { QUERY_LIMITS } from './query.ts';
import { normalize, transferBodySchema } from './collection.ts';
import type { CollectionSpec, NormalizedSpec, PropertySchema } from './collection.ts';

type Json = Record<string, unknown>;
const pascal = (text: string): string => text.split(/[^A-Za-z0-9]+/).filter(Boolean).map(word => word[0]!.toUpperCase() + word.slice(1)).join('');
const ref = (name: string): Json => ({ $ref: `#/components/schemas/${name}` });
const json = (schema: Json): Json => ({ 'application/json': { schema } });
const ID_PATTERN = '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';

/** The store's error envelope: `fields` on a 400 invalid_query, `issues` (core's body-validation issues) on a 422 invalid_record or invalid_transfer or a 409 increment_limit, `conflict` on a 409 interval_conflict. */
const errorSchema: Json = {
  description: 'Every error the store writes: a fixed code and message, and never a submitted value.',
  type: 'object', required: ['error'], additionalProperties: false,
  properties: { error: { type: 'object', required: ['code', 'message'], additionalProperties: false, properties: {
    code: { type: 'string' }, message: { type: 'string' },
    fields: { type: 'object', additionalProperties: { type: 'string' }, description: 'invalid_query: the offending query parameters, each with a fixed message.' },
    issues: { type: 'array', items: ref('UrlcodeBodyValidationIssue'), description: 'invalid_record, invalid_transfer and increment_limit: the schema issues, in the shape a body-schema route answers.' },
    conflict: { type: 'object', required: ['id'], additionalProperties: false, properties: { id: { type: 'string', pattern: ID_PATTERN } }, description: 'interval_conflict: the record whose interval overlaps, only when the caller may read it (on an owned collection, only the caller\'s own record; another owner\'s blocks the slot without being named).' },
  } } },
};
const failure = (description: string): Json => ({ description, content: json(ref('StoreError')) });
const header = (description: string, schema: Json, required = true): Json => ({ description, required, schema });
const etag = header('The record\'s strong ETag; send it back in If-Match.', { type: 'string' });
const allowTransitions = header('The comma-separated names of the declared transitions the caller may run on this record now (empty when none).', { type: 'string' });
const replayed = header('true when an Idempotency-Key replayed the first answer instead of running the request again.', { const: 'true' }, false);

/** A property's schema as a query parameter takes it: a copy, since a parameter is not validated through a component. */
const valueSchema = (property: PropertySchema): Json => structuredClone(property) as Json;

/** Every schema of one collection, named `Store<Collection><Kind>`. */
function collectionSchemas(name: string, spec: NormalizedSpec): { schemas: Json; names: { record: string; reader: string; create: string; patch: string; list: string; readerList: string; transfer: string; transferred: string } } {
  const base = `Store${pascal(name)}`, records = spec.records, properties = records.properties;
  const names = { record: `${base}Record`, reader: `${base}ReaderRecord`, create: `${base}Create`, patch: `${base}Patch`, list: `${base}List`, readerList: `${base}ReaderList`, transfer: `${base}Transfer`, transferred: `${base}Transferred` };
  const stored = {
    id: { type: 'string', format: 'uuid', readOnly: true, description: 'Store-owned: the record id.' },
    createdAt: { type: 'string', format: 'date-time', readOnly: true, description: 'Store-owned: when the record was created.' },
    updatedAt: { type: 'string', format: 'date-time', readOnly: true, description: 'Store-owned: changes on every write, and with it the ETag.' },
  };
  // A named record schema is referenced, never copied: each property is its component's property, and the store's own
  // layer (a default, readOnly) sits beside the reference as an annotation.
  const named = records.schemaName;
  const value = (field: string): Json => named === undefined ? structuredClone(properties[field]!) as Json : ref(`${named}/properties/${field}`);
  const annotated = (field: string, marks: boolean): Json => ({
    ...value(field),
    ...(Object.hasOwn(records.defaults, field) ? { default: records.defaults[field] } : {}),
    ...(marks && records.readOnly.includes(field) ? { readOnly: true } : {}),
  });
  const record = (extra: Json = {}, extraRequired: string[] = []): Json => ({
    ...(records.schema.title === undefined ? {} : { title: records.schema.title }), ...(records.schema.description === undefined ? {} : { description: records.schema.description }),
    type: 'object', additionalProperties: false,
    // Stored rows are judged without `required`, so a record written before a property became required may lack it.
    required: ['id', 'createdAt', 'updatedAt', ...extraRequired, ...records.required],
    properties: { ...stored, ...extra, ...Object.fromEntries(Object.keys(properties).map(field => [field, annotated(field, true)])) },
  });
  const writable = Object.keys(properties).filter(field => !records.readOnly.includes(field));
  const createRequired = records.required.filter(field => writable.includes(field) && !Object.hasOwn(records.defaults, field));
  const createDescription = 'A create (POST) or replace (PUT) body. Omitted properties take their default; readOnly properties are changed only by a transition and refused here.';
  // When the store takes exactly the named schema as a create body, it is that component: a client sees one type
  // for the store's POST, a route body and an MCP tool naming the same schema.
  const create: Json = named !== undefined && writable.length === Object.keys(properties).length && createRequired.length === records.required.length
    ? { ...ref(named), description: createDescription }
    : {
      description: createDescription,
      type: 'object', additionalProperties: false,
      required: createRequired,
      properties: Object.fromEntries(writable.map(field => [field, annotated(field, false)])),
    };
  const patch: Json = {
    description: 'A partial update (PATCH): only the named properties change, and null removes an optional one. The result must satisfy the record schema.',
    type: 'object', additionalProperties: false, minProperties: 1,
    properties: Object.fromEntries(writable.map(field => [field, records.required.includes(field) || spec.increments.includes(field) ? value(field) : { anyOf: [value(field), { type: 'null' }] }])),
  };
  const list = (item: string): Json => ({
    type: 'object', required: ['items', 'total', 'etags', 'may'], additionalProperties: false,
    properties: {
      items: { type: 'array', items: ref(item) },
      total: { type: 'integer', minimum: 0, description: 'Records in the caller\'s scope that match the filters.' },
      next: { type: ['string', 'integer'], description: 'The cursor for the next page; absent on the last one.' },
      etags: { type: 'object', additionalProperties: { type: 'string' }, description: 'Each listed record\'s ETag by id.' },
      may: { type: 'object', additionalProperties: { type: 'array', items: { type: 'string' } }, description: 'Each listed record\'s transitions the caller may run now, by id.' },
    },
  });
  const schemas: Json = { [names.record]: record(), [names.create]: create, [names.patch]: patch, [names.list]: list(names.record) };
  if (Object.keys(spec.transfers).length) {
    schemas[names.transfer] = { description: 'A transfer request: the debited record, the credited record (a different one) and the whole amount moved.', ...structuredClone(transferBodySchema) as Json };
    schemas[names.transferred] = {
      description: 'A committed transfer: each record as it is now. to is present only when the caller may read it (on an owned collection, only its own record).',
      type: 'object', required: ['from'], additionalProperties: false, properties: { from: ref(names.record), to: ref(names.record) },
    };
  }
  if (spec.readers?.showOwner) {
    schemas[names.reader] = record({ _owner: { type: 'string', readOnly: true, description: 'The owner\'s opaque principal id.' } }, ['_owner']);
    schemas[names.readerList] = list(names.reader);
  }
  return { schemas, names };
}

const idParameter: Json = { name: 'id', in: 'path', required: true, description: 'A record id.', schema: { type: 'string', maxLength: 36, pattern: ID_PATTERN } };
const ifMatch: Json = { name: 'If-Match', in: 'header', description: 'One strong ETag this store issued: the write is refused with 412 when the record changed since.', schema: { type: 'string', maxLength: 34 } };
const idempotencyKey: Json = { name: 'Idempotency-Key', in: 'header', description: 'Replays the first answer to a retry of the same request instead of running it again.', schema: { type: 'string', minLength: 1, maxLength: 128 } };

/** The list query: limit, cursor, sort and the declared filters, each filter taking its property's own schema. */
function listParameters(spec: NormalizedSpec): Json[] {
  return [
    { name: 'limit', in: 'query', description: `Records per page, at most (and by default) ${spec.pageSize}.`, schema: { type: 'integer', minimum: 0, maximum: 999_999_999 } },
    { name: 'cursor', in: 'query', description: 'The previous page\'s next value.', schema: { type: 'string', maxLength: QUERY_LIMITS.cursorLength } },
    ...(spec.sortable.length ? [{ name: 'sort', in: 'query', description: 'A sortable property, or - and the property for descending order.', schema: { enum: spec.sortable.flatMap(field => [field, `-${field}`]) } }] : []),
    ...spec.filterable.map(field => ({ name: field, in: 'query', description: `Only records whose ${field} equals this value; a value its schema refuses answers 400.`, schema: valueSchema(spec.records.properties[field]!) })),
  ];
}

/** The answers every store operation may give, besides its success and what core adds. */
const unavailable = failure('storage_unavailable, or audit_backlog on an audited collection: try again later.');
const badRequest = failure('A malformed header, query, JSON body or Idempotency-Key.');
const notFound = failure('No such record in the caller\'s scope (another owner\'s record answers the same).');

/** One collection mount: the list and create path, the record path, and its increments and transitions. */
function collectionPaths(mount: string, name: string, spec: NormalizedSpec, names: ReturnType<typeof collectionSchemas>['names']): Record<string, Json> {
  const retry = spec.idempotency ? [idempotencyKey] : [];
  const bodyBytes = spec.maxRecordBytes + 4096;
  const body = (schema: string): Json => ({ required: true, content: json(ref(schema)), 'x-urlcode': { maxBytes: bodyBytes } });
  const recordAnswer = (status: string, description: string, extra: Json = {}): Json => ({ [status]: { description, headers: { ETag: etag, 'Allow-Transitions': allowTransitions, ...(spec.idempotency ? { 'Idempotency-Replayed': replayed } : {}), ...extra }, content: json(ref(names.record)) } });
  const writeErrors = (conflict: string | undefined): Json => ({
    '400': badRequest, '403': failure('forbidden_origin: a cross-origin write.'),
    ...(conflict ? { '409': failure(conflict) } : {}),
    '413': failure('record_too_large: the body or the resulting record exceeds maxRecordBytes.'),
    '415': failure('Send Content-Type: application/json.'),
    '422': failure(`invalid_record: the record does not satisfy the collection schema${spec.intervals ? ' or its intervals (a bound that is not a UTC date-time, or an end not after its start)' : ''}${spec.idempotency ? '; or idempotency_key_reused' : ''}.`),
    '503': unavailable,
  });
  const listed = { parameters: listParameters(spec), responses: { '200': { description: 'One page of the caller\'s records.', content: json(ref(names.list)) }, '400': failure('invalid_query: an undeclared, repeated or invalid list parameter.'), '503': unavailable } };
  const overlap = spec.intervals ? 'interval_conflict (the interval overlaps another record\'s; see error.conflict)' : '';
  const conflicts = [spec.key ? 'key_exists' : '', 'collection_full', spec.maxRecordsPerOwner ? 'owner_quota_exceeded' : '', overlap].filter(Boolean).join(', ');
  const paths: Record<string, Json> = {
    [mount]: {
      summary: `The ${name} collection`,
      get: { summary: `List ${name}`, ...listed },
      head: { summary: `List ${name} (headers only)`, ...listed },
      ...(spec.readOnly ? {} : { post: {
        summary: `Create a ${name} record`, parameters: retry, requestBody: body(names.create),
        responses: { ...recordAnswer('201', 'Created.', { Location: header('The new record\'s URL.', { type: 'string' }) }), ...writeErrors(conflicts) },
      } }),
    },
  };
  const read = { parameters: [], responses: { ...recordAnswer('200', 'The record.'), '404': notFound, '503': unavailable } };
  const item: Json = { parameters: [idParameter], get: { summary: `Read a ${name} record`, ...read }, head: { summary: `Read a ${name} record (headers only)`, ...read } };
  if (!spec.readOnly) {
    const update = (kind: string, schema: string): Json => ({
      summary: `${kind} a ${name} record`, parameters: [ifMatch, ...retry], requestBody: body(schema),
      responses: { ...recordAnswer('200', 'Updated.'), '404': notFound, '412': failure('precondition_failed: the record changed since that ETag.'), ...writeErrors([spec.key ? 'key_exists' : '', overlap].filter(Boolean).join(', ') || undefined) },
    });
    item.put = update('Replace', names.create);
    item.patch = update('Update', names.patch);
    item.delete = {
      summary: `Delete a ${name} record`, parameters: [ifMatch, ...retry],
      responses: { '204': { description: 'Deleted.', headers: spec.idempotency ? { 'Idempotency-Replayed': replayed } : {} }, '400': badRequest, '403': failure('forbidden_origin: a cross-origin write.'), '404': notFound, ...(Object.keys(spec.transfers).length ? { '409': failure('balance_not_zero: the record still holds a transfer balance; transfer it out first, so the sum never changes.') } : {}), '412': failure('precondition_failed: the record changed since that ETag.'), ...(spec.idempotency ? { '422': failure('idempotency_key_reused.') } : {}), '503': unavailable },
    };
  }
  paths[`${mount}/{id}`] = item;
  if (!spec.readOnly && spec.increments.length) paths[`${mount}/{id}/increment/{field}`] = {
    parameters: [idParameter, { name: 'field', in: 'path', required: true, description: 'A declared increment property.', schema: { enum: [...spec.increments] } }],
    post: { summary: `Raise a ${name} counter by one`, parameters: retry, responses: { ...recordAnswer('200', 'Incremented.'), '400': badRequest, '403': failure('forbidden_origin: a cross-origin write.'), '404': notFound, '409': failure('increment_limit: one more would break the property\'s schema.'), ...(spec.idempotency ? { '422': failure('idempotency_key_reused.') } : {}), '503': unavailable } },
  };
  if (!spec.readOnly) for (const [transfer, declared] of Object.entries(spec.transfers)) paths[`${mount}/transfers/${transfer}`] = {
    post: {
      summary: `Run the ${transfer} transfer between two ${name} records`,
      description: `Moves amount from the from record's ${declared.amount} to the to record's in one transaction, so their sum is unchanged; the from record may be left no lower than ${declared.min}.${spec.ownership === 'owner' ? ' The caller may debit only its own record, and may credit any owned record.' : ''}`,
      parameters: [ifMatch, ...retry], requestBody: body(names.transfer),
      responses: {
        '200': { description: 'Transferred.', headers: { ETag: header('The from record\'s strong ETag; send it back in If-Match.', { type: 'string' }), ...(spec.idempotency ? { 'Idempotency-Replayed': replayed } : {}) }, content: json(ref(names.transferred)) },
        '400': badRequest,
        '403': failure(['forbidden_origin: a cross-origin write', ...declared.members ? ['membership_required: the caller is not a member'] : []].join('; ') + '.'),
        '404': failure('not_found: the from record is not in the caller\'s scope, or the to record does not exist.'),
        '409': failure('insufficient_balance: the from record would be left below the floor; transfer_limit: a balance would break its property\'s schema or leave the safe integers; transfer_conflict: a record holds no whole balance.'),
        '412': failure('precondition_failed: the from record changed since that ETag.'),
        '413': failure('record_too_large: the body or a resulting record exceeds maxRecordBytes.'),
        '415': failure('Send Content-Type: application/json.'),
        '422': failure(`invalid_transfer: the body is not {from, to, amount} with two different record ids and a positive whole amount${spec.idempotency ? '; or idempotency_key_reused' : ''}.`),
        '503': unavailable,
      },
    },
  };
  if (!spec.readOnly) for (const [transition, declared] of Object.entries(spec.transitions)) {
    if (declared.mount !== undefined) continue;
    paths[`${mount}/{id}/${transition}`] = { parameters: [idParameter], post: transitionOperation(name, transition, declared, spec, recordAnswer) };
  }
  return paths;
}
/** A declared transition: POST with no body, If-Match and (when enabled) Idempotency-Key. */
function transitionOperation(name: string, transition: string, declared: NormalizedSpec['transitions'][string], spec: NormalizedSpec, recordAnswer: (status: string, description: string) => Json): Json {
  const from = Object.entries(declared.from).map(([field, value]) => `${field} = ${JSON.stringify(value)}`).join(', ');
  return {
    summary: `Run the ${transition} transition on a ${name} record`,
    description: `Moves a record whose ${from} to the declared values, in one transaction. It takes no body.`,
    parameters: [ifMatch, ...spec.idempotency ? [idempotencyKey] : []],
    responses: {
      ...recordAnswer('200', 'Transitioned.'),
      '400': badRequest,
      '403': failure(['forbidden_origin: a cross-origin write', ...declared.members ? ['membership_required: the caller is not a member'] : [], ...declared.by === 'others' ? ['own_record_refused: the caller owns the record'] : []].join('; ') + '.'),
      '404': notFound, '409': failure(`transition_conflict: the record is not in the from state${spec.intervals ? '; or interval_conflict: the record as the transition leaves it would overlap another record\'s interval (see error.conflict)' : ''}.`), '412': failure('precondition_failed: the record changed since that ETag.'),
      ...(spec.idempotency ? { '422': failure('idempotency_key_reused.') } : {}), '503': unavailable,
    },
  };
}

/**
 * The store's `describe()`: the OpenAPI paths and schemas of the store mount `mount` (a collection, readers,
 * `by: others` transition or short-link mount) from the declared configuration, or `undefined` for a mount the
 * configuration does not name (core keeps it opaque). A configuration the store refuses throws, as activation would.
 */
export function describeStore(request: ExtensionDescribeRequest): ExtensionOpenApi | undefined {
  const config = request.config as { collections?: Record<string, CollectionSpec>; shortLinks?: Record<string, { mount: string; collection: string; destination: string }> };
  const collections = Object.entries(config.collections ?? {}).map(([name, spec]) => ({ name, spec: normalize(name, spec, request.schemas) }));
  const mount = request.mount, schemas: Json = { StoreError: errorSchema };
  for (const { name, spec } of collections) {
    const built = collectionSchemas(name, spec);
    const owned = (): ExtensionOpenApi => { Object.assign(schemas, built.schemas); return { paths: {}, schemas }; };
    if (spec.mount === mount) { const out = owned(); out.paths = collectionPaths(mount, name, spec, built.names); return out; }
    if (spec.readers?.mount === mount) {
      const out = owned(), item = spec.readers.showOwner ? built.names.reader : built.names.record, list = spec.readers.showOwner ? built.names.readerList : built.names.list;
      const gate = failure('membership_required: the caller is not a member of the readers\' membership collection.');
      const listed = { parameters: listParameters(spec), responses: { '200': { description: 'One page of every owner\'s records.', content: json(ref(list)) }, '400': failure('invalid_query: an undeclared, repeated or invalid list parameter.'), '403': gate, '503': unavailable } };
      const read = { responses: { '200': { description: 'The record.', headers: { ETag: etag, 'Allow-Transitions': allowTransitions }, content: json(ref(item)) }, '403': gate, '404': notFound, '503': unavailable } };
      out.paths = {
        [mount]: { summary: `Every owner's ${name} records, read-only`, get: { summary: `List every owner's ${name}`, ...listed }, head: { summary: `List every owner's ${name} (headers only)`, ...listed } },
        [`${mount}/{id}`]: { parameters: [idParameter], get: { summary: `Read any owner's ${name} record`, ...read }, head: { summary: `Read any owner's ${name} record (headers only)`, ...read } },
      };
      return out;
    }
    for (const [transition, declared] of Object.entries(spec.transitions)) if (declared.mount === mount) {
      const out = owned();
      const recordAnswer = (status: string, description: string): Json => ({ [status]: { description, headers: { ETag: etag, 'Allow-Transitions': allowTransitions, ...(spec.idempotency ? { 'Idempotency-Replayed': replayed } : {}) }, content: json(ref(built.names.record)) } });
      out.paths = { [`${mount}/{id}`]: { parameters: [idParameter], post: transitionOperation(name, transition, declared, spec, recordAnswer) } };
      return out;
    }
  }
  for (const [name, link] of Object.entries(config.shortLinks ?? {})) if (link.mount === mount) {
    const found = collections.find(entry => entry.name === link.collection);
    const key = found?.spec.key === undefined ? { type: 'string' } : valueSchema(found.spec.records.properties[found.spec.key]!);
    const redirect = (counted: boolean): Json => ({
      summary: `Follow the ${name} short link${counted ? ' (counts a click)' : ''}`,
      responses: { '302': { description: 'Redirect to the record\'s stored destination.', headers: { Location: header('An absolute HTTP(S) URL.', { type: 'string', format: 'uri' }) } }, '404': notFound, '503': unavailable },
    });
    return { paths: { [`${mount}/{key}`]: { parameters: [{ name: 'key', in: 'path', required: true, description: `A ${link.collection} record's ${found?.spec.key ?? 'key'}.`, schema: key }], get: redirect(true), head: redirect(false) } }, schemas };
  }
  return undefined;
}
