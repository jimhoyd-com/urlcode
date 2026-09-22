// Bound buffered operational output when the log collector cannot keep up.
// Dropped records are counted and reported when output becomes writable again.
export function createJsonLogger(stream: LogSink = process.stdout, maxBufferBytes = 1048576): JsonLogger {
  let state=sinkStates.get(stream);
  if(!state){const created={failed:false};state=created;sinkStates.set(stream,created);stream.on?.('error',()=>{created.failed=true;});}
  const sink=state;
  let dropped = 0;
  return event => {
    if (sink.failed || stream.destroyed || stream.writableLength >= maxBufferBytes) { dropped++; return; }
    try {
      if (dropped) {
        stream.write(JSON.stringify({ event:'logs_dropped',count:dropped }) + '\n');
        dropped = 0;
      }
      stream.write(JSON.stringify(event) + '\n');
    } catch {sink.failed=true;dropped++;}
  };
}
type JsonLogger = (event: object) => void;
/** What the logger needs from its sink: the members of a Writable it touches. process.stdout satisfies it. */
interface LogSink { write(chunk: string): unknown; writableLength: number; destroyed?: boolean; on?(event: 'error', listener: () => void): unknown }
const sinkStates = new WeakMap<LogSink, { failed: boolean }>();
