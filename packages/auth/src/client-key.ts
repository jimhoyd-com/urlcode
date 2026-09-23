import {isIP} from 'node:net';

/** Bits of an IPv6 client address that identify one client for auth budgets. */
export const clientKeyIpv6Prefix=64;

function ipv6Bytes(address:string):Uint8Array {
  const zone=address.indexOf('%');
  let value=zone<0?address:address.slice(0,zone);
  const dotted=value.match(/^(.*:)(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if(dotted){const [a,b,c,d]=dotted.slice(2).map(Number) as [number,number,number,number];value=dotted[1]+((a<<8)|b).toString(16)+':'+((c<<8)|d).toString(16);}
  const [head='',tail='']=value.split('::'),left=head?head.split(':'):[],right=value.includes('::')&&tail?tail.split(':'):[];
  const groups=[...left,...Array(8-left.length-right.length).fill('0'),...right].map(group=>parseInt(group||'0',16));
  const bytes=new Uint8Array(16);
  groups.forEach((group,index)=>{bytes[index*2]=group>>8;bytes[index*2+1]=group&255;});
  return bytes;
}

/**
 * Rate-limit identity for a client address, used for every per-client auth budget (the
 * per-client password budget and the abuse-policy `client` and `signupClient` limits).
 * IPv4, including IPv4-mapped IPv6 (`::ffff:a.b.c.d` or its hex form), keys by address; IPv6
 * keys by its /64 network, so rotating addresses inside one allocation earns no fresh budget.
 * This mirrors core's `clientKey` (packages/core/src/client-address.ts) rather than importing
 * it, so the package keeps working on every core its peer range allows; both implementations
 * are pinned to the shared vectors in test/client-key-vectors.json.
 */
export function clientKey(address:unknown):string|undefined {
  if(typeof address!=='string'||!address)return undefined;
  let value=address;
  if(value.startsWith('['))value=value.slice(1,value.indexOf(']'));
  else if(/^\d+\.\d+\.\d+\.\d+:\d+$/.test(value))value=value.slice(0,value.indexOf(':'));
  const kind=isIP(value);
  if(kind===4)return value;
  if(kind!==6)return undefined;
  const bytes=ipv6Bytes(value.toLowerCase());
  if(bytes.subarray(0,10).every(byte=>byte===0)&&bytes[10]===0xff&&bytes[11]===0xff)return Array.from(bytes.subarray(12)).join('.');
  const groups:string[]=[];
  for(let index=0;index<clientKeyIpv6Prefix/8;index+=2)groups.push(((bytes[index]!<<8)|bytes[index+1]!).toString(16));
  return groups.join(':')+'::/'+clientKeyIpv6Prefix;
}
