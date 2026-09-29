import { ConfigError } from './errors.ts';
import { isRecord, own } from './object-guards.ts';
import { assertBodySchema, bodySchemaDialect } from './body-validation.ts';
import type { BodySchema } from './body-validation.ts';
import type { InspectedFile, InspectionDiagnostic } from './artifact-inspect.ts';

// Named project schemas: the entry urlcode.yaml's top-level `schemas:` map. Each entry is a JSON Schema 2020-12
// document in the request body profile (body-validation.ts), written inline or loaded from a project file with
// `{file: <path>}`. A file is read offline by the bounded reference resolver `urlcode artifacts inspect` uses
// (artifact-inspect.ts): its relative `$ref`s to other project files are followed, nothing is fetched, and a path
// that leaves the project, a symlink, a remote or unresolved reference and every size limit refuse the load. The
// files it reached are then bundled into one self-contained schema whose only references are local `#/$defs/<name>`
// ones, and that schema is admitted against the profile like any inline one. Only the config worker runs this.

/** A schema name: a letter, then letters, digits or `_`; `Urlcode...` is reserved for the runtime's own OpenAPI components. */
export const projectSchemaName = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
/** A schema file: a project-relative JSON or YAML path, without `..`, a leading `/` or a leading dot on any segment. */
const schemaFilePath = /^(?:[A-Za-z0-9][A-Za-z0-9._-]*\/){0,7}[A-Za-z0-9][A-Za-z0-9._-]*\.(?:json|ya?ml)$/;
/** The resolver's limits for schema files, across every file one project's `schemas:` reads. */
export const projectSchemaFileLimits = {
  maxDocumentBytes: 256 * 1024, maxFiles: 64, maxTotalBytes: 2 * 1024 * 1024, maxRefs: 512, maxRefDepth: 16, maxNesting: 64,
} as const;

/** What the loader adds to `LoadedDocument`: each named schema, admitted and self-contained, and each file read with its sha256. */
export interface ProjectSchemas { schemas: Record<string, BodySchema>; files: Record<string, string> }

const escapePointer = (key: string): string => key.replace(/~/g, '~0').replace(/\//g, '~1');
const unescapePointer = (key: string): string => key.replace(/~1/g, '/').replace(/~0/g, '~');
const clip = (text: string, cap = 200): string => { const clean = text.replace(/[\u0000-\u001f\u007f]/g, '?'); return clean.length > cap ? `${clean.slice(0, cap)}...` : clean; };

/** Fixed wording for each resolver refusal; the reference text itself is never echoed (it may be a URL with credentials). */
function refusal(diagnostic: InspectionDiagnostic): string {
  switch (diagnostic.code) {
    case 'remote-ref': return 'a remote reference is refused: schema references are resolved offline, inside the project, and never fetched';
    case 'path-escape': return 'the reference leaves the project directory';
    case 'symlink': return 'the path is a symlink (or its case differs); schema files are read only at their exact project path';
    case 'unresolved-ref': if (diagnostic.at === undefined) return 'the file does not exist in the project';
      return 'the reference does not resolve to a JSON or YAML file in the project, or names a location that does not exist';
    case 'unsupported-ref': return 'a plain-name ($anchor) fragment is not resolved; use a JSON pointer such as other.json#/$defs/<name>';
    case 'ref-cycle': return 'the references form a cycle; recursive schemas are not supported';
    // The resolver's own words for these name only the package path and a fixed reason.
    case 'limit': case 'invalid-document': return clip(diagnostic.message, 300);
  }
}

/**
 * Checks, loads and admits the entry document's `schemas:` map. `root` is the project directory (holding
 * urlcode.yaml); `declared` is the map as written. Throws a ConfigError naming `/schemas/<name>` for the first
 * problem.
 */
export async function loadProjectSchemas(root: string, declared: Record<string, unknown>): Promise<ProjectSchemas> {
  const schemas: Record<string, BodySchema> = {}, files: Record<string, string> = {};
  const fail = (name: string, problem: string): never => { throw new ConfigError(`schemas.${name}: ${problem}`, { code: 'invalid-schema', pointer: `/schemas/${escapePointer(name)}` }); };
  const fromFiles: [string, string][] = [];
  for (const [name, entry] of Object.entries(declared)) {
    if (!projectSchemaName.test(name)) fail(clip(name, 64), 'a schema name is a letter followed by at most 63 letters, digits or _');
    if (name.startsWith('Urlcode')) fail(name, 'names starting with Urlcode are reserved for the runtime\'s own OpenAPI components');
    if (isRecord(entry) && own(entry, 'file')) {
      if (Object.keys(entry).length !== 1) fail(name, 'a file reference takes only file (the schema itself is the file\'s content)');
      if (typeof entry.file !== 'string' || !schemaFilePath.test(entry.file)) fail(name, 'file must be a project-relative .json, .yaml or .yml path without .. segments or a leading / or .');
      fromFiles.push([name, entry.file as string]);
    } else schemas[name] = admit(name, entry, undefined);
  }
  if (fromFiles.length) {
    // Loaded only when a project names a schema file: the resolver belongs to artifact inspection.
    const { inspectArtifactDocuments } = await import('./artifact-inspect.ts');
    const parsed = new Map<string, unknown>();
    const paths = [...new Set(fromFiles.map(([, file]) => file))];
    const inspected = await inspectArtifactDocuments(root, paths.map(path => ({ path, mediaType: 'application/schema+json' as const })), projectSchemaFileLimits, parsed);
    const records = new Map<string, InspectedFile>([...inspected.documents, ...inspected.referencedFiles].map(record => [record.path, record]));
    for (const [name, file] of fromFiles) {
      const reached = reachable(file, records);
      for (const record of reached) {
        const diagnostic = record.diagnostics[0];
        // A limit or an unreadable document is stated with its own path; any other refusal is located at the reference.
        if (diagnostic) fail(name, diagnostic.code === 'limit' || diagnostic.code === 'invalid-document' ? refusal(diagnostic) : `${clip(diagnostic.path)}${diagnostic.at === undefined ? '' : `#${clip(diagnostic.at)}`}: ${refusal(diagnostic)}`);
        if (!parsed.has(record.path)) fail(name, `${clip(record.path)} could not be read`);
      }
      let bundled: unknown;
      try { bundled = bundle(file, records, parsed); } catch (error) { fail(name, `${clip(file)}: ${(error as Error).message}`); }
      schemas[name] = admit(name, bundled, file);
      for (const record of reached) files[record.path] = record.sha256!;
    }
  }
  return { schemas, files };
}

/** Admits one schema against the body profile, restating a refusal as this named schema's. */
function admit(name: string, schema: unknown, file: string | undefined): BodySchema {
  try { assertBodySchema(schema); }
  catch (error) {
    const problem = (error as Error).message.replace(/^Body schema /, '');
    throw new ConfigError(`schemas.${name}${file === undefined ? '' : ` (${clip(file)}, bundled: /$defs entries named <file>.<name> came from referenced files)`} ${problem}`, { code: 'invalid-schema', pointer: `/schemas/${escapePointer(name)}` }, { cause: error });
  }
  return schema;
}

/** The files a schema file reads: itself and, transitively, every file one of its resolved references reaches. */
function reachable(file: string, records: Map<string, InspectedFile>): InspectedFile[] {
  const seen = new Set<string>([file]), out: InspectedFile[] = [];
  const queue = [file];
  for (let index = 0; index < queue.length; index++) {
    const record = records.get(queue[index]!);
    if (!record) continue;
    out.push(record);
    for (const ref of record.refs) {
      const target = ref.target.slice(0, ref.target.indexOf('#'));
      if (!seen.has(target)) { seen.add(target); queue.push(target); }
    }
  }
  return out;
}

function at(data: unknown, pointer: string): unknown {
  let node = data;
  if (pointer === '') return node;
  for (const raw of pointer.slice(1).split('/')) {
    const key = unescapePointer(raw);
    node = Array.isArray(node) ? node[Number(key)] : isRecord(node) ? node[key] : undefined;
  }
  return node;
}
const inside = (pointer: string, location: string): boolean => pointer === '' || location === pointer || location.startsWith(`${pointer}/`);
const defPointer = /^\/\$defs\/([^/]+)$/;

/**
 * One self-contained schema from the file `file`: its own root and `$defs` as written, plus each location another file
 * contributes through a reference, hoisted into `$defs` (a whole file as `<stem>`, one of its `$defs` entries as
 * `<stem>.<name>`) with the reference rewritten to `#/$defs/<that name>`. Only what the root reaches is copied. A
 * reference must name a whole file or one of its `$defs` entries; inside the root file, one of its own `$defs` entries.
 */
function bundle(file: string, records: Map<string, InspectedFile>, parsed: Map<string, unknown>): BodySchema {
  const copies = new Map<string, unknown>();
  const copy = (path: string): unknown => { if (!copies.has(path)) copies.set(path, structuredClone(parsed.get(path))); return copies.get(path); };
  const root = copy(file);
  if (!isRecord(root)) throw new Error('a schema file must hold a JSON Schema object');
  const rootDefs = own(root, '$defs') && isRecord(root.$defs) ? root.$defs : {};
  const used = new Set(Object.keys(rootDefs)), names = new Map<string, string>(), hoisted: { name: string; path: string; pointer: string }[] = [];
  const stem = (path: string): string => {
    const base = path.slice(path.lastIndexOf('/') + 1).replace(/\.(?:json|ya?ml)$/, '').replace(/[^A-Za-z0-9_.-]/g, '_');
    return /^[A-Za-z_]/.test(base) ? base : `_${base}`;
  };
  const nameFor = (path: string, pointer: string): string => {
    const key = `${path}#${pointer}`, known = names.get(key);
    if (known !== undefined) return known;
    const def = defPointer.exec(pointer)?.[1];
    if (path === file) {
      if (def !== undefined && own(rootDefs, unescapePointer(def))) return unescapePointer(def);
      throw new Error(pointer === '' ? 'a reference back to the schema\'s own root is recursive; recursive schemas are not supported' : 'a reference inside a schema must name one of its own /$defs/<name> entries');
    }
    if (pointer !== '' && def === undefined) throw new Error(`a reference to ${clip(path)} must name the whole file or one of its /$defs/<name> entries`);
    const base = (def === undefined ? stem(path) : `${stem(path)}.${unescapePointer(def).replace(/[^A-Za-z0-9_.-]/g, '_')}`).slice(0, 60);
    let name = base;
    for (let n = 2; used.has(name); n++) name = `${base}_${n}`;
    used.add(name); names.set(key, name); hoisted.push({ name, path, pointer });
    return name;
  };
  // Breadth first from the root: each included location's references are rewritten, and a location they name that
  // is not included yet is hoisted and visited in turn. A hoisted file's own $defs are not copied with it.
  const visit = (path: string, pointer: string): void => {
    const data = copy(path);
    for (const ref of records.get(path)?.refs ?? []) {
      if (!inside(pointer, ref.at) || (path !== file && pointer === '' && ref.at.startsWith('/$defs/'))) continue;
      const hash = ref.target.indexOf('#'), target = ref.target.slice(0, hash), targetPointer = ref.target.slice(hash + 1);
      const node = at(data, ref.at);
      if (isRecord(node)) node.$ref = `#/$defs/${nameFor(target, targetPointer)}`;
    }
  };
  visit(file, '');
  for (let index = 0; index < hoisted.length; index++) visit(hoisted[index]!.path, hoisted[index]!.pointer);
  const defs: Record<string, unknown> = { ...rootDefs };
  for (const { name, path, pointer } of hoisted) {
    const value = structuredClone(at(copy(path), pointer));
    if (pointer === '' && isRecord(value)) {
      if (own(value, '$schema') && value.$schema !== bodySchemaDialect) throw new Error(`${clip(path)} names a $schema dialect other than ${bodySchemaDialect}`);
      delete value.$schema; delete value.$defs;
    }
    defs[name] = value;
  }
  const out: Record<string, unknown> = { ...root };
  delete out.$defs;
  if (Object.keys(defs).length) out.$defs = defs;
  return out as BodySchema;
}
