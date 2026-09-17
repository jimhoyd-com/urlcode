// Declaration for the one dependency that ships no types (content-disposition
// carries its own). It names only the surface src/assets.ts calls.
declare module 'mime-types' {
  const mime: { lookup(path: string): string | false; contentType(type: string): string | false };
  export default mime;
}
