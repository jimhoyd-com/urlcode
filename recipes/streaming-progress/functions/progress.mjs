// A trusted function (the default) on a `stream: true` route: the runtime sends each
// line to the client as soon as it is yielded, instead of waiting for the last one.
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

export default function progress(request, { args, signal }) {
  async function* lines() {
    for (let step = 1; step <= args.steps; step++) {
      // The signal aborts when the client leaves or an operator stream limit ends
      // the stream; stop working instead of producing lines nobody reads.
      if (signal.aborted) return;
      yield `step ${step} of ${args.steps}\n`;
      await pause(100);
    }
    yield 'done\n';
  }
  return new Response(ReadableStream.from(lines()), {
    headers: { 'content-type': 'text/plain; charset=utf-8' },
  });
}
