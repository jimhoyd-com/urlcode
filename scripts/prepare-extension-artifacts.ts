import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX_ARCHIVE = 16 * 1024 * 1024;
const MAX_EXPANDED = 32 * 1024 * 1024;
const MAX_FILES = 128;
const MAX_FILE = 2 * 1024 * 1024;
const artifactName = /^[a-z][a-z0-9-]{0,63}$/;
const artifactVersion = /^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$/;
const releaseTag = /^extensions@v[0-9][0-9A-Za-z._-]{0,100}$/;
const hex = /^[a-f0-9]{64}$/;
const allowedFile = /^(?:extension\.json|README\.md|schemas\/[A-Za-z0-9._-]+\.json|config\/[A-Za-z0-9._-]+\.json)$/;

interface SourceArtifact { name: string; version: string; directory: string }
interface Revocation { sha256: string; reason: string }
interface CatalogArtifact { name: string; version: string; asset: string; sha256: string; kind: 'declarative' }
interface PreparedCatalog { format: 1; tag: string; commit: string; artifacts: CatalogArtifact[]; revoked: Revocation[] }
type UnknownRecord = Record<string, unknown>;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
function record(value: unknown): value is UnknownRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function exactKeys(value: UnknownRecord, expected: readonly string[], what: string): void {
  assert(JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort()), `${what} has unknown or missing fields`);
}
function json(bytes: Uint8Array, what: string): unknown {
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new Error(`${what} is not valid UTF-8 JSON`); }
}
function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

interface SourceFile { path: string; bytes: Buffer }
async function sourceFiles(root: string, prefix = ''): Promise<SourceFile[]> {
  const files: SourceFile[] = [];
  const entries = await readdir(join(root, prefix), { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    assert(entry.isDirectory() || entry.isFile(), `Extension artifact source ${path} is a link or special file`);
    if (entry.isDirectory()) {
      assert(prefix === '' && (entry.name === 'schemas' || entry.name === 'config'), `Extension artifact source contains unsupported directory ${path}`);
      files.push(...await sourceFiles(root, path));
    }
    else {
      assert(allowedFile.test(path), `Extension artifact source contains unsupported file ${path}`);
      const bytes = await readFile(join(root, path));
      assert(bytes.byteLength <= MAX_FILE, `Extension artifact source ${path} exceeds the file size limit`);
      if (path.endsWith('.json')) json(bytes, path);
      files.push({ path, bytes });
    }
  }
  return files;
}

function writeOctal(header: Buffer, offset: number, length: number, value: number): void {
  const encoded = value.toString(8).padStart(length - 1, '0') + '\0';
  assert(encoded.length === length, 'Extension artifact tar field overflow');
  header.write(encoded, offset, length, 'ascii');
}
function tar(files: readonly SourceFile[]): Buffer {
  const parts: Buffer[] = [];
  for (const file of files) {
    assert(Buffer.byteLength(file.path, 'utf8') < 100, `Extension artifact path is too long: ${file.path}`);
    const header = Buffer.alloc(512);
    header.write(file.path, 0, 100, 'utf8');
    writeOctal(header, 100, 8, 0o644);
    writeOctal(header, 108, 8, 0);
    writeOctal(header, 116, 8, 0);
    writeOctal(header, 124, 12, file.bytes.byteLength);
    writeOctal(header, 136, 12, 0);
    header.fill(32, 148, 156);
    header[156] = 48;
    header.write('ustar\0', 257, 6, 'ascii');
    header.write('00', 263, 2, 'ascii');
    const checksum = [...header].reduce((sum, byte) => sum + byte, 0);
    const encoded = checksum.toString(8).padStart(6, '0') + '\0 ';
    assert(encoded.length === 8, 'Extension artifact tar checksum overflow');
    header.write(encoded, 148, 8, 'ascii');
    parts.push(header, file.bytes, Buffer.alloc((512 - file.bytes.byteLength % 512) % 512));
  }
  parts.push(Buffer.alloc(1024));
  const archive = Buffer.concat(parts);
  assert(archive.byteLength <= MAX_EXPANDED, 'Extension artifact exceeds the expanded size limit');
  return archive;
}

let crcTable: Uint32Array | undefined;
function crc32(bytes: Uint8Array): number {
  crcTable ??= Uint32Array.from({ length: 256 }, (_, index) => {
    let value = index;
    for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ value >>> 1 : value >>> 1;
    return value >>> 0;
  });
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff]! ^ crc >>> 8;
  return (crc ^ 0xffffffff) >>> 0;
}
/** A deterministic gzip stream using uncompressed DEFLATE blocks. */
function gzip(bytes: Buffer): Buffer {
  const blocks: Buffer[] = [Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xff])];
  for (let offset = 0; offset < bytes.byteLength || offset === 0;) {
    const size = Math.min(0xffff, bytes.byteLength - offset);
    const final = offset + size === bytes.byteLength;
    const header = Buffer.alloc(5);
    header[0] = final ? 1 : 0;
    header.writeUInt16LE(size, 1);
    header.writeUInt16LE((~size) & 0xffff, 3);
    blocks.push(header, bytes.subarray(offset, offset + size));
    offset += size;
    if (final) break;
  }
  const trailer = Buffer.alloc(8);
  trailer.writeUInt32LE(crc32(bytes), 0);
  trailer.writeUInt32LE(bytes.byteLength >>> 0, 4);
  blocks.push(trailer);
  const archive = Buffer.concat(blocks);
  assert(archive.byteLength <= MAX_ARCHIVE, 'Extension artifact exceeds the archive size limit');
  return archive;
}

function sourceArtifact(value: unknown): SourceArtifact {
  assert(record(value), 'Invalid extension artifact source entry');
  exactKeys(value, ['name', 'version', 'directory'], 'Extension artifact source entry');
  assert(typeof value.name === 'string' && artifactName.test(value.name), 'Invalid extension artifact source name');
  assert(typeof value.version === 'string' && artifactVersion.test(value.version), 'Invalid extension artifact source version');
  assert(typeof value.directory === 'string' && artifactName.test(value.directory), 'Invalid extension artifact source directory');
  return { name: value.name, version: value.version, directory: value.directory };
}
function revocation(value: unknown): Revocation {
  assert(record(value), 'Invalid extension artifact revocation');
  exactKeys(value, ['sha256', 'reason'], 'Extension artifact revocation');
  assert(typeof value.sha256 === 'string' && hex.test(value.sha256), 'Invalid extension artifact revocation digest');
  assert(typeof value.reason === 'string' && value.reason.length > 0 && value.reason.length < 256, 'Invalid extension artifact revocation reason');
  return { sha256: value.sha256, reason: value.reason };
}

/** Build release assets from reviewed data files without executing extension code. */
export async function prepareExtensionArtifacts(root: string, output: string, tag: string, commit: string): Promise<PreparedCatalog> {
  assert(releaseTag.test(tag), 'Use an immutable extension release tag such as extensions@v1.0.0');
  assert(/^[a-f0-9]{40}$/.test(commit), 'Use the exact 40-character source commit');
  const sourceRoot = resolve(root, 'extension-artifacts');
  const destination = resolve(output);
  const fromSource = relative(sourceRoot, destination);
  assert(fromSource.startsWith('..') || isAbsolute(fromSource), 'Extension artifact output must be outside the source directory');
  await mkdir(destination);
  const raw = json(await readFile(join(sourceRoot, 'source.json')), 'extension-artifacts/source.json');
  assert(record(raw) && raw.format === 1, 'Unsupported extension artifact source format');
  exactKeys(raw, ['format', 'artifacts', 'revoked'], 'Extension artifact source');
  assert(Array.isArray(raw.artifacts) && raw.artifacts.length > 0 && Array.isArray(raw.revoked), 'Extension artifact source is incomplete');
  const sources = raw.artifacts.map(sourceArtifact);
  const revoked = raw.revoked.map(revocation);
  assert(new Set(sources.map(item => item.name)).size === sources.length, 'Extension artifact source repeats a name');
  assert(new Set(sources.map(item => item.directory)).size === sources.length, 'Extension artifact source repeats a directory');
  assert(new Set(revoked.map(item => item.sha256)).size === revoked.length, 'Extension artifact source repeats a revocation');
  const expectedSourceEntries = ['source.json', ...sources.map(item => item.directory)].sort();
  const sourceEntries = await readdir(sourceRoot, { withFileTypes: true });
  for (const entry of sourceEntries) assert(entry.name === 'source.json' ? entry.isFile() : entry.isDirectory(), `Extension artifact source ${entry.name} is a link or has the wrong type`);
  assert(JSON.stringify(sourceEntries.map(entry => entry.name).sort()) === JSON.stringify(expectedSourceEntries), 'Extension artifact source directory has unlisted entries');
  const artifacts: CatalogArtifact[] = [];
  for (const source of sources.sort((left, right) => left.name.localeCompare(right.name))) {
    const files = await sourceFiles(join(sourceRoot, source.directory));
    assert(files.length > 0 && files.length <= MAX_FILES, `Extension artifact ${source.name} has an invalid file count`);
    assert(files.reduce((sum, file) => sum + file.bytes.byteLength, 0) <= MAX_EXPANDED, `Extension artifact ${source.name} exceeds the source size limit`);
    const manifestFile = files.find(file => file.path === 'extension.json');
    assert(manifestFile, `Extension artifact ${source.name} is missing extension.json`);
    const manifest = json(manifestFile.bytes, `${source.name}/extension.json`);
    assert(record(manifest), `Extension artifact ${source.name} manifest must be an object`);
    exactKeys(manifest, ['format', 'kind', 'name', 'version'], `Extension artifact ${source.name} manifest`);
    assert(manifest.format === 1 && manifest.kind === 'declarative' && manifest.name === source.name && manifest.version === source.version, `Extension artifact ${source.name} manifest does not match source.json`);
    const bytes = gzip(tar(files));
    const asset = `${source.name}-${source.version}.tgz`;
    await writeFile(join(destination, asset), bytes, { flag: 'wx' });
    artifacts.push({ name: source.name, version: source.version, asset, sha256: sha256(bytes), kind: 'declarative' });
  }
  const catalog: PreparedCatalog = { format: 1, tag, commit, artifacts, revoked };
  await writeFile(join(destination, 'extensions-catalog.json'), `${JSON.stringify(catalog, null, 2)}\n`, { flag: 'wx' });
  return catalog;
}

function argumentsFrom(values: string[]): { tag: string; commit: string; output: string } {
  assert(values.length === 6, 'Use --tag <extensions@v...> --commit <sha> --output <directory>');
  const options = new Map<string, string>();
  for (let index = 0; index < values.length; index += 2) {
    const flag = values[index]!, value = values[index + 1]!;
    assert(['--tag', '--commit', '--output'].includes(flag) && !options.has(flag), 'Use --tag, --commit and --output exactly once');
    options.set(flag, value);
  }
  return { tag: options.get('--tag')!, commit: options.get('--commit')!, output: options.get('--output')! };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = argumentsFrom(process.argv.slice(2));
  await prepareExtensionArtifacts(process.cwd(), options.output, options.tag, options.commit);
}
