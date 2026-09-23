// Verify the sender's HMAC-SHA256 signature over the raw body with the granted
// key, then acknowledge. The runtime has already enforced the method, content
// type, size, JSON syntax, the body schema (an object with a string id) and
// both header patterns, so the signature is the only check left for code.
// This route runs trusted (the default), which is what makes node:crypto
// available here.
import {Buffer} from 'node:buffer';
import {createHmac, timingSafeEqual} from 'node:crypto';

export default async function receive(request, {inputs, secrets}) {
  const body = await request.text();
  const expected = createHmac('sha256', secrets.WEBHOOK_SECRET).update(body).digest();
  // The parameter pattern guarantees "sha256=" followed by 64 hex digits.
  const presented = Buffer.from(inputs.header['x-webhook-signature'].slice('sha256='.length), 'hex');
  if (!timingSafeEqual(expected, presented)) {
    return Response.json({error: 'signature does not match'}, {status: 401});
  }
  const {id} = JSON.parse(body);
  return Response.json({received: true, event: inputs.header['x-webhook-event'], id}, {status: 202});
}
