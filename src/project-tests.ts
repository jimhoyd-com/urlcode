import { realpath } from 'node:fs/promises';
import { Agent } from 'node:http';
import { startServer } from './server.ts';
import type { ServerOptions } from './server.ts';
import { readCases, hit } from './readiness.ts';
import type { LogFn } from './types.ts';

export interface ProjectTestOptions { extensions?: ServerOptions['extensions']; plugins?: ServerOptions['plugins']; log?: LogFn | undefined; permissions?: ServerOptions['permissions']; origin?: string | undefined }
export interface ProjectTestResult { total: number; failed: number }

export async function runProjectTests(project: string, { log = () => {}, permissions, origin, extensions, plugins }: ProjectTestOptions = {}): Promise<ProjectTestResult> {
  const root = await realpath(project), cases = await readCases(root);
  const app = await startServer({ project, port: 0, local: true, log, permissions, origin, extensions, plugins });
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
