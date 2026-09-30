// Test-only npm-style tarballs: `packTarball` writes a gzipped ustar archive of a directory under `package/`, the way
// `npm pack` lays one out, and `extractTarball` unpacks one into a directory, the way npm installs a registry package.
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';

function header(name, size) {
  const block = Buffer.alloc(512);
  block.write(name, 0, 100, 'utf8');
  block.write('0000644\0', 100); block.write('0000000\0', 108); block.write('0000000\0', 116);
  block.write(size.toString(8).padStart(11, '0') + '\0', 124); block.write('00000000000\0', 136);
  block.write('        ', 148); block.write('0', 156); block.write('ustar\0', 257); block.write('00', 263);
  let sum = 0; for (const byte of block) sum += byte;
  block.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
  return block;
}
/** A gzipped tarball of every file under `dir`, each stored as `package/<relative path>`. */
export function packTarball(dir) {
  const parts = [];
  const walk = (path, rel) => {
    for (const name of readdirSync(path).sort()) {
      const child = join(path, name), key = rel ? `${rel}/${name}` : name;
      if (statSync(child).isDirectory()) { walk(child, key); continue; }
      const data = readFileSync(child);
      parts.push(header(`package/${key}`, data.length), data, Buffer.alloc((512 - data.length % 512) % 512));
    }
  };
  walk(dir, '');
  return gzipSync(Buffer.concat([...parts, Buffer.alloc(1024)]));
}
/** Unpacks a gzipped ustar tarball into `target`, dropping each entry's first path segment. */
export function extractTarball(gzipped, target) {
  const tar = gunzipSync(gzipped);
  for (let offset = 0; offset + 512 <= tar.length;) {
    const block = tar.subarray(offset, offset + 512);
    if (block.every(byte => byte === 0)) break;
    const name = block.subarray(0, 100).toString('utf8').replace(/\0.*$/s, ''), size = parseInt(block.subarray(124, 136).toString('utf8').replace(/\0.*$/s, '').trim() || '0', 8);
    const type = String.fromCharCode(block[156]);
    if (type === '0' || type === '\0') {
      const path = join(target, ...name.split('/').slice(1));
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, tar.subarray(offset + 512, offset + 512 + size));
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
}
