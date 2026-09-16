// Bound buffered operational output when the log collector cannot keep up.
// Dropped records are counted and reported when output becomes writable again.
export function createJsonLogger(stream = process.stdout, maxBufferBytes = 1048576) {
  let dropped = 0;
  return event => {
    if (stream.destroyed || stream.writableLength >= maxBufferBytes) { dropped++; return; }
    if (dropped) {
      stream.write(JSON.stringify({ event:'logs_dropped',count:dropped }) + '\n');
      dropped = 0;
    }
    stream.write(JSON.stringify(event) + '\n');
  };
}
