// Bound buffered operational output when the log collector cannot keep up.
// Dropped records are counted and reported when output becomes writable again.
const sinkStates = new WeakMap();
export function createJsonLogger(stream = process.stdout, maxBufferBytes = 1048576) {
  let state=sinkStates.get(stream);
  if(!state){state={failed:false};sinkStates.set(stream,state);stream.on?.('error',()=>{state.failed=true;});}
  let dropped = 0;
  return event => {
    if (state.failed || stream.destroyed || stream.writableLength >= maxBufferBytes) { dropped++; return; }
    try {
      if (dropped) {
        stream.write(JSON.stringify({ event:'logs_dropped',count:dropped }) + '\n');
        dropped = 0;
      }
      stream.write(JSON.stringify(event) + '\n');
    } catch {state.failed=true;dropped++;}
  };
}
