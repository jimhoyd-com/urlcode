import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { join, posix } from 'node:path';
import { packageDataPath } from './addon-manifest.ts';
import type { AddonManifest, ArtifactDocument, ArtifactMediaType } from './addon-manifest.ts';
import { lockPackages, pinnedArtifact, untrustedContentNotice } from './addon-install.ts';
import { parseYaml } from './config.ts';
import { isCode, isRecord } from './object-guards.ts';

/**
 * `urlcode artifacts inspect` and MCP `inspect_extension_artifact` (#844): the offline facts about the standard
 * documents an installed, pin-verified artifact lists. Reading never imports package code, runs a script, fetches a
 * reference, follows a symlink or leaves the package directory, and every limit below is enforced, not advisory.
 */
export const artifactInspectionLimits = {
  /** Largest single document or referenced file read. */
  maxDocumentBytes: 1024 * 1024,
  /** Most files read in one inspection: listed documents plus files reached through a relative `$ref`. */
  maxFiles: 64,
  /** Most bytes read across those files. */
  maxTotalBytes: 8 * 1024 * 1024,
  /** Most `$ref` occurrences examined across those files. */
  maxRefs: 1024,
  /** Longest chain of references followed from one reference. */
  maxRefDepth: 32,
  /** Deepest object/array nesting walked inside one document. */
  maxNesting: 256,
} as const;

export type DocumentKind = 'openapi' | 'json-schema' | 'markdown' | 'json' | 'yaml';
export type DiagnosticCode = 'remote-ref' | 'unsupported-ref' | 'unresolved-ref' | 'path-escape' | 'symlink' | 'ref-cycle' | 'limit' | 'invalid-document';
export interface InspectionDiagnostic {
  code: DiagnosticCode;
  severity: 'error' | 'warning';
  /** The package file the diagnostic is about. */
  path: string;
  /** JSON pointer, in that file, of the object carrying the `$ref`. */
  at?: string;
  /** The reference exactly as written (untrusted; truncated to 512 characters). */
  ref?: string;
  message: string;
}
/** A reference resolved inside the package: `target` is `<package path>#<JSON pointer>`. */
export interface ResolvedRef { at: string; ref: string; target: string }
export interface InspectedFile {
  path: string;
  /** The media type the descriptor declares; null for a file reached only through a reference. */
  mediaType: ArtifactMediaType | null;
  kind: DocumentKind | null;
  /** The OpenAPI (`openapi` or `swagger`) version, or the JSON Schema `$schema` dialect; null when not declared. */
  version: string | null;
  sha256: string | null;
  bytes: number | null;
  refs: ResolvedRef[];
  diagnostics: InspectionDiagnostic[];
}
export interface ArtifactInspection {
  format: 1;
  notice: string;
  artifact: {
    name: string; package: string; version: string | null;
    /** True for an operator-installed package outside core's catalog (#844). */
    independent: boolean;
    integrity: string | null; resolved: string | null;
    /**
     * `catalog-pin`: core's own addons.json pins it; `development`: a development manifest links it unpinned;
     * `local-tarball`: npm's lock integrity, re-checked against the local tarball it came from; `lock-integrity`:
     * npm's lock integrity, recorded when npm fetched it and not re-checked offline.
     */
    verification: 'catalog-pin' | 'development' | 'local-tarball' | 'lock-integrity';
  };
  limits: typeof artifactInspectionLimits;
  documents: InspectedFile[];
  /** Package files that no document lists but a relative `$ref` reaches. */
  referencedFiles: InspectedFile[];
}

const escapePointer = (key: string): string => key.replace(/~/g, '~0').replace(/\//g, '~1');
const clip = (text: string): string => text.length > 512 ? `${text.slice(0, 509)}...` : text;
const utf8 = new TextDecoder('utf-8', { fatal: true });
const refKind = (mediaType: ArtifactMediaType | null): boolean => mediaType === null || mediaType === 'application/vnd.oai.openapi' || mediaType === 'application/vnd.oai.openapi+json' || mediaType === 'application/schema+json';

interface Occurrence { file: string; at: string; ref: string; target?: { file: string; pointer: string } }
interface Loaded { record: InspectedFile; data?: unknown; follows: boolean }

/** Whether an RFC 6901 pointer names a value inside parsed JSON/YAML data. */
function pointerExists(data: unknown, pointer: string): boolean {
  if (pointer === '') return true;
  let node = data;
  for (const raw of pointer.slice(1).split('/')) {
    const key = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    if (Array.isArray(node) && /^(?:0|[1-9]\d*)$/.test(key) && Number(key) < node.length) node = node[Number(key)];
    else if (isRecord(node) && !Array.isArray(node) && Object.hasOwn(node, key)) node = node[key];
    else return false;
  }
  return true;
}

/** Every `$ref` string in `data` with the pointer of the object carrying it, in document order, bounded by nesting depth. */
function collectRefs(data: unknown, maxNesting: number): { refs: { at: string; ref: string }[]; tooDeep: boolean } {
  const refs: { at: string; ref: string }[] = [], stack: { value: unknown; at: string; depth: number }[] = [{ value: data, at: '', depth: 0 }];
  let tooDeep = false;
  while (stack.length) {
    const { value, at, depth } = stack.pop()!;
    if (typeof value !== 'object' || value === null) continue;
    if (depth > maxNesting) { tooDeep = true; continue; }
    const children: { value: unknown; at: string; depth: number }[] = [];
    if (Array.isArray(value)) value.forEach((item, index) => children.push({ value: item, at: `${at}/${index}`, depth: depth + 1 }));
    else for (const [key, item] of Object.entries(value)) {
      if (key === '$ref' && typeof item === 'string') refs.push({ at, ref: item });
      else children.push({ value: item, at: `${at}/${escapePointer(key)}`, depth: depth + 1 });
    }
    stack.push(...children.reverse());
  }
  return { refs, tooDeep };
}

/**
 * Inspects the listed `documents` of the package at `directory`, offline. Relative `$ref`s in OpenAPI and JSON Schema
 * documents are resolved against the referring file's location inside the package (a `$id` base is not applied);
 * any reference with a scheme or authority is reported and never fetched.
 */
export async function inspectArtifactDocuments(directory: string, documents: readonly ArtifactDocument[], limits = artifactInspectionLimits): Promise<{ documents: InspectedFile[]; referencedFiles: InspectedFile[] }> {
  const root = await realpath(directory);
  const loaded = new Map<string, Loaded>(), queue: string[] = [];
  let totalBytes = 0, refCount = 0, refLimitReported = false;
  const diagnose = (record: InspectedFile, diagnostic: Omit<InspectionDiagnostic, 'path'>): void => {
    record.diagnostics.push({ ...diagnostic, path: record.path, ...(diagnostic.ref === undefined ? {} : { ref: clip(diagnostic.ref) }) });
  };

  /** Reads one package file, refusing a symlink anywhere on its path, anything but a regular file, and every limit. */
  const load = async (path: string, mediaType: ArtifactMediaType | null, reportTo?: InspectedFile): Promise<Loaded | undefined> => {
    const existing = loaded.get(path);
    if (existing) return existing;
    const record: InspectedFile = { path, mediaType, kind: null, version: null, sha256: null, bytes: null, refs: [], diagnostics: [] };
    const where = reportTo ?? record;
    if (loaded.size >= limits.maxFiles) { diagnose(where, { code: 'limit', severity: 'error', message: `more than ${limits.maxFiles} files would be read; ${path} was not` }); return mediaType ? remember(path, record, false) : undefined; }
    const absolute = join(root, ...path.split('/'));
    let real: string;
    try { real = await realpath(absolute); }
    catch (error) {
      if (!isCode(error, 'ENOENT') && !isCode(error, 'ENOTDIR')) throw error;
      diagnose(where, { code: 'unresolved-ref', severity: 'error', message: `${path} does not exist in the package` });
      return mediaType ? remember(path, record, false) : undefined;
    }
    if (real !== absolute) { diagnose(where, { code: 'symlink', severity: 'error', message: `${path} does not resolve to exactly that path inside the package (a symlink or a case mismatch); it was not read` }); return mediaType ? remember(path, record, false) : undefined; }
    const handle = await open(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    let bytes: Buffer;
    try {
      const info = await handle.stat();
      if (!info.isFile()) { diagnose(where, { code: 'invalid-document', severity: 'error', message: `${path} is not a regular file` }); return mediaType ? remember(path, record, false) : undefined; }
      record.bytes = info.size;
      if (info.size > limits.maxDocumentBytes) { diagnose(where, { code: 'limit', severity: 'error', message: `${path} is ${info.size} bytes, over the ${limits.maxDocumentBytes}-byte document limit; it was not read` }); return remember(path, record, false); }
      if (totalBytes + info.size > limits.maxTotalBytes) { diagnose(where, { code: 'limit', severity: 'error', message: `reading ${path} would pass the ${limits.maxTotalBytes}-byte inspection limit; it was not read` }); return remember(path, record, false); }
      const buffer = Buffer.alloc(info.size);
      const { bytesRead } = info.size ? await handle.read(buffer, 0, info.size, 0) : { bytesRead: 0 };
      bytes = buffer.subarray(0, bytesRead);
    } finally { await handle.close(); }
    totalBytes += bytes.length;
    record.bytes = bytes.length;
    record.sha256 = createHash('sha256').update(bytes).digest('hex');
    return parse(path, record, bytes);
  };
  const remember = (path: string, record: InspectedFile, follows: boolean, data?: unknown): Loaded => {
    const item: Loaded = { record, follows, ...(data === undefined ? {} : { data }) };
    loaded.set(path, item);
    return item;
  };
  const parse = (path: string, record: InspectedFile, bytes: Buffer): Loaded => {
    let text: string;
    try { text = utf8.decode(bytes); } catch { diagnose(record, { code: 'invalid-document', severity: 'error', message: `${path} is not UTF-8 text` }); return remember(path, record, false); }
    if (record.mediaType === 'text/markdown') { record.kind = 'markdown'; return remember(path, record, false); }
    let data: unknown;
    const json = path.endsWith('.json');
    try { data = json ? JSON.parse(text) : parseYaml(text); }
    catch (error) {
      // JSON.parse quotes the offending text; only the YAML profile's message is free of document content.
      diagnose(record, { code: 'invalid-document', severity: 'error', message: json ? `${path} is not valid JSON` : `${path}: ${error instanceof Error ? error.message : String(error)}` });
      return remember(path, record, false);
    }
    const object = isRecord(data) && !Array.isArray(data) ? data : undefined;
    const openapi = typeof object?.openapi === 'string' ? object.openapi : typeof object?.swagger === 'string' ? object.swagger : undefined;
    const schema = typeof object?.$schema === 'string' ? object.$schema : undefined;
    const declared = record.mediaType;
    if (declared === 'application/vnd.oai.openapi' || declared === 'application/vnd.oai.openapi+json') {
      record.kind = 'openapi';
      if (openapi === undefined) diagnose(record, { code: 'invalid-document', severity: 'error', message: `${path} is declared as OpenAPI but has no openapi (or swagger) version field` });
      else record.version = clip(openapi);
    } else if (declared === 'application/schema+json') {
      record.kind = 'json-schema';
      if (object === undefined && typeof data !== 'boolean') diagnose(record, { code: 'invalid-document', severity: 'error', message: `${path} is declared as JSON Schema but is neither an object nor a boolean` });
      record.version = schema === undefined ? null : clip(schema);
    } else if (declared === null) {
      // A file reached only through a reference: described by what it declares, else by its extension.
      record.kind = openapi !== undefined ? 'openapi' : schema !== undefined ? 'json-schema' : json ? 'json' : 'yaml';
      record.version = openapi !== undefined ? clip(openapi) : schema === undefined ? null : clip(schema);
    } else record.kind = json ? 'json' : 'yaml';
    return remember(path, record, refKind(declared), data);
  };

  const occurrences: Occurrence[] = [];
  const records = new Map<string, InspectedFile>();
  for (const document of documents) {
    const item = await load(document.path, document.mediaType);
    if (item) { records.set(document.path, item.record); if (item.follows) queue.push(document.path); }
  }
  // Breadth first over files: each file's references are classified once; a relative one may add a file to read.
  for (let index = 0; index < queue.length; index++) {
    const file = queue[index]!, item = loaded.get(file)!;
    const { refs, tooDeep } = collectRefs(item.data, limits.maxNesting);
    if (tooDeep) diagnose(item.record, { code: 'limit', severity: 'error', message: `${file} nests deeper than ${limits.maxNesting} levels; deeper references were not examined` });
    for (const { at, ref } of refs) {
      if (refCount >= limits.maxRefs) {
        if (!refLimitReported) diagnose(item.record, { code: 'limit', severity: 'error', message: `more than ${limits.maxRefs} references; the rest were not examined` });
        refLimitReported = true;
        break;
      }
      refCount++;
      const occurrence: Occurrence = { file, at, ref };
      occurrences.push(occurrence);
      const fail = (code: DiagnosticCode, severity: 'error' | 'warning', message: string): void => diagnose(item.record, { code, severity, at, ref, message });
      if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(ref) || ref.startsWith('//')) { fail('remote-ref', 'warning', 'remote reference: listed, never fetched'); continue; }
      const hash = ref.indexOf('#'), pathPart = hash < 0 ? ref : ref.slice(0, hash), fragment = hash < 0 ? '' : ref.slice(hash + 1);
      let pointer: string, relativePath: string;
      try { pointer = decodeURIComponent(fragment); relativePath = decodeURIComponent(pathPart); }
      catch { fail('unresolved-ref', 'error', 'the reference is not a valid URI reference'); continue; }
      if (pointer !== '' && !pointer.startsWith('/')) { fail('unsupported-ref', 'warning', 'a plain-name fragment ($anchor) is not resolved; use a JSON pointer'); continue; }
      let target = file;
      if (relativePath !== '') {
        if (relativePath.includes('\\') || relativePath.includes('\0') || relativePath.startsWith('/')) { fail('path-escape', 'error', 'the reference leaves the package directory; it was not read'); continue; }
        const joined = posix.normalize(posix.join(posix.dirname(file), relativePath));
        if (joined === '..' || joined.startsWith('../')) { fail('path-escape', 'error', 'the reference leaves the package directory; it was not read'); continue; }
        if (!packageDataPath.test(joined) || !/\.(?:json|ya?ml)$/.test(joined)) { fail('unresolved-ref', 'error', `${joined} is not a JSON or YAML file path inside the package`); continue; }
        const before = item.record.diagnostics.length;
        const reached = await load(joined, null, item.record);
        if (reached?.data === undefined) {
          // `load` already explained a refusal on this file; a file read earlier without data explains itself.
          const added = item.record.diagnostics.slice(before);
          for (const diagnostic of added) Object.assign(diagnostic, { at, ref: clip(ref) });
          if (!added.length) fail('unresolved-ref', 'error', `${joined} could not be read as JSON or YAML`);
          // A file that was read but did not parse keeps its digest and its own diagnostic in `referencedFiles`.
          if (reached?.record.sha256 && !records.has(joined)) records.set(joined, reached.record);
          continue;
        }
        if (!records.has(joined)) { records.set(joined, reached.record); if (!queue.includes(joined)) queue.push(joined); }
        target = joined;
      }
      if (!pointerExists(loaded.get(target)!.data, pointer)) { fail('unresolved-ref', 'error', `${target}#${pointer} does not exist`); continue; }
      occurrence.target = { file: target, pointer };
      item.record.refs.push({ at, ref: clip(ref), target: `${target}#${pointer}` });
    }
  }

  // Cycles and chain depth: a reference target (file#pointer) leads on to every resolved reference inside its subtree.
  const resolved = occurrences.filter(item => item.target);
  const inside = (pointer: string, at: string): boolean => pointer === '' || at === pointer || at.startsWith(`${pointer}/`);
  const onward = (file: string, pointer: string): Occurrence[] => resolved.filter(item => item.file === file && inside(pointer, item.at));
  const done = new Set<string>(), cycles = new Set<string>();
  let depthReported = false;
  const walk = (file: string, pointer: string, stack: string[]): void => {
    const key = `${file}#${pointer}`;
    const repeat = stack.indexOf(key);
    if (repeat >= 0) {
      const cycle = [...stack.slice(repeat), key];
      const id = [...new Set(cycle)].sort().join('|');
      if (!cycles.has(id)) { cycles.add(id); diagnose(records.get(file) ?? loaded.get(file)!.record, { code: 'ref-cycle', severity: 'warning', at: pointer, message: `reference cycle ${cycle.join(' -> ')}; legal for a recursive schema, not expanded further` }); }
      return;
    }
    if (done.has(key)) return;
    if (stack.length >= limits.maxRefDepth) {
      if (!depthReported) diagnose(records.get(file) ?? loaded.get(file)!.record, { code: 'limit', severity: 'error', at: pointer, message: `a reference chain is longer than ${limits.maxRefDepth}; it was not followed further` });
      depthReported = true;
      return;
    }
    for (const next of onward(file, pointer)) walk(next.target!.file, next.target!.pointer, [...stack, key]);
    done.add(key);
  };
  for (const occurrence of resolved) walk(occurrence.target!.file, occurrence.target!.pointer, [`${occurrence.file}#${occurrence.at}`]);

  const listed = new Set(documents.map(document => document.path));
  return {
    documents: documents.map(document => records.get(document.path) ?? loaded.get(document.path)!.record),
    referencedFiles: [...records.values()].filter(record => !listed.has(record.path)).sort((a, b) => a.path < b.path ? -1 : 1),
  };
}

/**
 * Inspects the installed artifact `name` in `site`: refused unless it is inert and pin-verified (core's pin, or for an
 * independent package npm's lock integrity and, from a local tarball, that tarball's current hash).
 */
export async function inspectInstalledArtifact(site: string, name: string, options: { manifest?: AddonManifest } = {}): Promise<ArtifactInspection> {
  const artifact = await pinnedArtifact(site, name, options);
  const entry = (await lockPackages(site))[`node_modules/${artifact.package}`];
  const local = typeof entry?.resolved === 'string' && entry.resolved.startsWith('file:');
  const verification: ArtifactInspection['artifact']['verification'] = !artifact.independent ? (entry?.link ? 'development' : 'catalog-pin') : local ? 'local-tarball' : 'lock-integrity';
  const result = await inspectArtifactDocuments(join(site, 'node_modules', artifact.package), artifact.documents);
  return {
    format: 1, notice: untrustedContentNotice,
    artifact: { name, package: artifact.package, version: artifact.version, independent: artifact.independent, integrity: entry?.integrity ?? null, resolved: entry?.resolved ?? null, verification },
    limits: artifactInspectionLimits, ...result,
  };
}
