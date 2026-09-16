#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { createRuntime } from './runtime.js';
import { startServer } from './server.js';
import { initProject, addRedirect } from './authoring.js';
import { runProjectTests } from './project-tests.js';
import { loadOperatorPolicy, prepareFunctionSnapshot, requestedPermissions } from './policy.js';
import { loadDocument } from './config.js';
import { ConfigError } from './errors.js';

const usage = `URLCode 0.1.0-alpha.2 — local/self-hosted runtime
  urlcode init <directory> [--template redirects|dynamic]
  urlcode validate [--project directory] [--local]
  urlcode dev [--project directory] [--port 3000] [--host 127.0.0.1]
  urlcode serve [--project directory] [--port 3000] [--host 127.0.0.1] [--origin https://links.example]
  urlcode add <destination-url> [--alias short-code] [--project directory]
  urlcode test [--project directory]
  urlcode permissions [--project directory]  # inspect requested bindings; grants nothing
  urlcode doctor
Dev loads .env.local and watches; serve does neither. Functions run in WASM isolation; external bindings require --policy outside the project.
`;
const print = value => process.stdout.write(typeof value === 'string' ? value : JSON.stringify(value) + '\n');
try {
  const { values, positionals } = parseArgs({ allowPositionals:true, options: {
    project:{ type:'string', default:'.' }, template:{ type:'string', default:'redirects' },
    port:{ type:'string', default:'3000' }, host:{ type:'string', default:'127.0.0.1' },
    policy:{ type:'string' }, origin:{ type:'string' }, alias:{ type:'string' }, local:{ type:'boolean' }, help:{ type:'boolean', short:'h' },
  } });
  const [command, arg, ...extra] = positionals;
  if (values.help || !command) print(usage);
  else {
    if (extra.length || (!['init','add'].includes(command) && arg)) throw new ConfigError('Unexpected positional arguments');
    const permissions = await loadOperatorPolicy(values.policy,values.project);
    switch (command) {
      case 'permissions': {
        const loaded = await loadDocument(values.project);
        print(requestedPermissions(loaded,await prepareFunctionSnapshot(loaded))); break;
      }
      case 'init':
        if (!arg) throw new ConfigError('Provide a new project directory');
        await initProject(arg, values.template); print({ event:'created', template:values.template }); break;
      case 'validate': {
        const runtime = await createRuntime(values.project, { local:values.local, permissions });
        print({ event:'valid', routes:runtime.count, version:runtime.version }); await runtime.close(); break;
      }
      case 'add':
        if (!arg) throw new ConfigError('Provide an HTTP(S) destination URL');
        print({ event:'added', path:await addRedirect(values.project,arg,values.alias) }); break;
      case 'test': {
        const result = await runProjectTests(values.project, { log:print, permissions });
        print(result); if (result.failed) process.exitCode = 1; break;
      }
      case 'doctor':
        print({ node:process.version, platform:process.platform, architecture:process.arch, runtime:'node-process', functionSandbox:'quickjs-wasm', network:false, filesystem:false, providers:[], license:'undecided' }); break;
      case 'dev': case 'serve': {
        const port = Number(values.port);
        if (!/^\d+$/.test(values.port) || !Number.isInteger(port) || port < 0 || port > 65535) throw new ConfigError('Invalid port');
        if (command === 'serve' && values.local) throw new ConfigError('serve never reads local dotenv files');
        const app = await startServer({ project:values.project, host:values.host, port,
          local:command === 'dev', watch:command === 'dev', origin:values.origin, permissions });
        print({ event:'listening', address:app.address.address, port:app.address.port, mode:command });
        let stopping = false;
        const stop = async () => { if (stopping) return; stopping = true; await app.close(); };
        process.once('SIGINT',stop); process.once('SIGTERM',stop);
        break;
      }
      default: throw new ConfigError('Unknown command; use --help');
    }
  }
} catch (error) {
  const message = error instanceof ConfigError ? error.message : ({ EEXIST:'Destination or edit lock already exists', ENOENT:'Required file or directory not found', EADDRINUSE:'Port is already in use', EACCES:'Permission denied' }[error.code] || 'Operation failed; check project files, module dependencies and command options');
  process.stderr.write(JSON.stringify({ event:'error', message }) + '\n'); process.exitCode = 1;
}
