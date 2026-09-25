import { parseArgs } from 'node:util';

// Commands that load trusted host code outside the project (registers
// extensions/plugins), and commands that read an operator binding policy
// outside the project. `cli.ts` shares these lists with its help footnotes so
// a command cannot accidentally advertise a privilege it rejects (or vice versa).
export const hostFileCommands = ['serve','dev','validate','test','routes','audit','benchmark','explain','context','plan-feature','review','report','extensions','mcp'] as const;
export const policyCommands = ['dev','serve','validate','test','routes','audit','benchmark','verify-deployment','report'] as const;
// Commands that activate the project locally and so accept the operator's `--alias-origin` list and `--passkey-rp-id`.
export const aliasOriginCommands = ['dev','serve','validate','test','routes','audit','benchmark'] as const;

/** The one CLI-wide allowlist passed to Node's argument parser. */
export const commandOptions = {
  json:{ type:'boolean' }, yaml:{ type:'boolean' }, report:{type:'string'}, 'accept-provider-differences':{type:'boolean'},
  project:{ type:'string' }, 'host-file':{type:'string'}, with:{type:'string'}, ack:{type:'string', multiple:true}, example:{type:'boolean'}, site:{type:'string'}, strict:{type:'boolean'}, to:{type:'string'}, check:{type:'boolean'},
  port:{ type:'string' }, host:{ type:'string', default:'127.0.0.1' },
  'expect-routes':{type:'string'}, requests:{type:'string'}, concurrency:{type:'string'}, seconds:{type:'string'}, 'max-p95-ms':{type:'string'}, warmup:{type:'string'}, target:{type:'string'},
  workers:{type:'string'}, 'function-timeout-ms':{type:'string'}, 'max-response-bytes':{type:'string'}, 'max-body-bytes':{type:'string'},
  'max-in-flight':{type:'string'}, 'max-in-flight-health':{type:'string'}, 'request-log':{type:'string'}, 'trust-request-id':{type:'boolean'}, 'trusted-proxies':{type:'string'}, metrics:{type:'boolean'},
  'health-details':{type:'boolean'}, 'close-timeout-ms':{type:'string'}, 'drain-delay-ms':{type:'string'},
  'headers-timeout-ms':{type:'string'}, 'request-timeout-ms':{type:'string'}, 'keep-alive-timeout-ms':{type:'string'},
  release:{type:'string'}, 'git-commit':{type:'string'}, 'timeout-ms':{type:'string'}, 'fail-on':{type:'string'}, 'expect-metrics':{type:'boolean'},
  budget:{type:'string'}, task:{type:'string'}, stats:{type:'boolean'}, out:{type:'string'}, 'dry-run':{type:'boolean'}, compare:{type:'string'}, format:{type:'string'}, compliance:{type:'string'}, 'compliance-rules':{type:'string'}, 'compliance-ignore':{type:'string'}, 'compliance-warn':{type:'boolean'}, policy:{ type:'string' }, origin:{ type:'string' }, 'alias-origin':{ type:'string', multiple:true }, 'passkey-rp-id':{ type:'string' }, alias:{ type:'string' }, local:{ type:'boolean' }, verbose:{ type:'boolean' }, 'allow-authoring':{ type:'boolean' }, 'debug-errors':{ type:'boolean' }, help:{ type:'boolean', short:'h' }, global:{ type:'boolean' }, version:{ type:'boolean', short:'v' },
} as const;

export type CliValues = ReturnType<typeof parseArgs<{ options: typeof commandOptions; allowPositionals: true }>>['values'];
