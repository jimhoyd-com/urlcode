// Preloaded into each npm child by npm-pack-hang.ts (NODE_OPTIONS=--import) for #1130. It appends one line per
// event to NPM_HANG_TRACE with appendFileSync, so the record survives a process that never exits: every stdout/stderr
// write and its callback, the call to process.exit with the handles still open, the 'exit' event, and an unref'd
// heartbeat naming the open handles while the event loop is still turning.
import { appendFileSync } from 'node:fs';
const file = process.env.NPM_HANG_TRACE;
if (file) {
  const started = Date.now();
  const mark = what => { try { appendFileSync(file, `${process.pid} ${Date.now() - started} ${what}\n`); } catch { /* best effort */ } };
  const handles = () => JSON.stringify(process.getActiveResourcesInfo());
  mark(`start pid ${process.pid}`);
  for (const name of ['stdout', 'stderr']) {
    const stream = process[name];
    mark(`${name} ${stream.constructor.name} isTTY=${Boolean(stream.isTTY)}`);
    const write = stream.write.bind(stream);
    stream.write = (chunk, encoding, callback) => {
      const done = typeof encoding === 'function' ? encoding : callback;
      const size = chunk == null ? 0 : chunk.length;
      mark(`${name}.write ${size}${done ? ' with callback' : ''} pending=${stream.writableLength}`);
      const traced = done && ((...args) => { mark(`${name}.write callback ${size}`); return done(...args); });
      return typeof encoding === 'function' ? write(chunk, traced) : write(chunk, encoding, traced);
    };
  }
  const exit = process.exit;
  process.exit = code => { mark(`process.exit(${code}) handles ${handles()}`); return exit.call(process, code); };
  process.on('exit', code => mark(`exit event ${code}`));
  setInterval(() => mark(`alive handles ${handles()}`), 5_000).unref();
}
