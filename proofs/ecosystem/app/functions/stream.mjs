// `stream: true`: the Response body is handed to the host unread and written as it is produced.
export default function stream(request, { signal }) {
  async function* lines() {
    for (let step = 1; step <= 3 && !signal.aborted; step++) {
      yield `chunk ${step}\n`;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }
  return new Response(ReadableStream.from(lines()), { headers: { 'content-type': 'text/plain; charset=utf-8' } });
}
