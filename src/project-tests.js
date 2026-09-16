import { realpath } from 'node:fs/promises';
import { Agent } from 'node:http';
import { startServer } from './server.js';
import { readCases, hit } from './readiness.js';

export async function runProjectTests(project, { log = () => {}, permissions, linkStore } = {}) {
  const root = await realpath(project), cases = await readCases(root);
  const app = await startServer({ project, port: 0, local: true, log, permissions, linkStore });
  const agent = new Agent({keepAlive:true,maxSockets:1}); let failed = 0;
  try {
    for (const [i,test] of cases.entries()) {
      const result=await hit(app,test,agent);
      if(!result.pass)failed++;
      log({event:'test',case:i+1,pass:result.pass,status:result.status});
    }
  } finally {agent.destroy();await app.close();}
  return {total:cases.length,failed};
}
