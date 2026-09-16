import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir, cpus, totalmem } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { startServer } from '../src/server.js';
import http from 'node:http';

const count = Number(process.argv[2] || 1000);
if (![1000,10000,100000].includes(count)) throw new Error('Dataset must be 1000, 10000 or 100000');
const root = await mkdtemp(join(tmpdir(),'urlcode-bench-'));
const agent = new http.Agent({ keepAlive:true,maxSockets:16 });
let app;
try {
  const lines = ['version: "1"','routes:'];
  for (let i = 0; i < count; i++) lines.push(`  /r${i}:`, '    redirect:', `      url: https://example.com/items/${i}`);
  await writeFile(join(root,'urlcode.yaml'),lines.join('\n') + '\n');
  const start = performance.now();
  app = await startServer({ project:root,port:0,log:()=>{} });
  const startupMs = performance.now() - start;
  const memory = process.memoryUsage();
  function hit(i) {
    return new Promise((resolve,reject) => {
      const started = performance.now();
      const req = http.get({ host:'127.0.0.1',port:app.address.port,path:`/r${i % count}`,agent,timeout:5000 }, res => {
        res.resume(); res.on('error',reject); res.on('end',() => {
          if (res.statusCode !== 302 || res.headers.location !== `https://example.com/items/${i % count}`) reject(new Error('Incorrect response'));
          else resolve(performance.now() - started);
        });
      });
      req.on('error',reject); req.on('timeout',() => req.destroy(new Error('Timeout')));
    });
  }
  for (let i=0;i<100;i++) await hit(i);
  const times = []; let next = 0; const requests = 5000;
  const began = performance.now();
  await Promise.all(Array.from({ length:16 },async () => { while (next < requests) times.push(await hit(next++)); }));
  const elapsed = performance.now() - began;
  times.sort((a,b)=>a-b);
  console.log(JSON.stringify({ node:process.version,platform:process.platform,arch:process.arch,cpu:cpus()[0]?.model,
    systemMemoryGiB:Math.round(totalmem()/2**30),routes:count,requests,concurrency:16,startupMs:Math.round(startupMs),
    rssMiB:Math.round(memory.rss/2**20),heapUsedMiB:Math.round(memory.heapUsed/2**20),
    requestsPerSecond:Math.round(requests/elapsed*1000),p50Ms:times[Math.floor(times.length*.5)],p95Ms:times[Math.floor(times.length*.95)] }));
} finally { agent.destroy(); await app?.close(); await rm(root,{ recursive:true,force:true }); }
