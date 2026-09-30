import { parseArgs } from 'node:util';

// Commands that load trusted host code outside the project (registers
// extensions/plugins), and commands that read an operator binding policy
// outside the project. `cli.ts` shares these lists with its help footnotes so
// a command cannot accidentally advertise a privilege it rejects (or vice versa).
export const hostFileCommands = ['serve','dev','validate','test','routes','audit','explain','context','plan-feature','review','report','studio','extensions','mcp','openapi'] as const;
// The inspection commands and the MCP server take it too: a verified policy pins their host to its reviewed revision,
// their emitted commands repeat it, and the MCP runners forward it (#834). None of them creates or changes a grant.
export const policyCommands = ['dev','serve','validate','test','routes','audit','verify-deployment','report','studio','explain','context','plan-feature','review','bootstrap','mcp','openapi'] as const;
// Read-only commands that may load the host file without a revision pin: their registrations are composed unpinned
// and cannot activate, so reading them never needs approval while serving always does (#910).
export const inspectionHostCommands = ['explain','context','plan-feature','review','report','studio','extensions','mcp','openapi'] as const;
// Commands that replay requests: they activate the extensions on a fresh, empty temporary data directory, never the site's live data
// (RIM-EXT-HERMETIC-001). `dev`, `serve`, `validate` and `routes` use the site's data, so a pinned validate checks what
// serve will use; a local review (`--local-review` with no pin) of validate or routes is hermetic too (#954).
export const hermeticHostCommands = ['test','audit'] as const;
// Non-serving commands that accept `--local-review` (#932): with no operator pin (no --policy, URLCODE_POLICY or
// PROJECT_SHA256) the host is pinned to the project's current revision for that one run, no policy is read, so no grant
// exists, the origin defaults to loopback, and the extensions activate on a fresh temporary data directory as in a
// hermetic run, never the site's data (#954). With an operator pin the flag changes nothing. serve and dev never accept
// it: serving always needs the reviewed pin.
export const localReviewCommands = ['validate','test','routes','audit'] as const;
// Read-only commands that need no pin at all accept `--local-review` too, and ignore it (#958), so the flag the
// generated check scripts pass works on every check.
export const pinFreeReviewCommands = ['explain','context','plan-feature','review','report','openapi'] as const;
/** The origin a local review uses when none is given: loopback, never a public site. */
export const localReviewOrigin = 'http://localhost';
/** What a `local_review` event says (the CLI checks and the MCP server's in-process `run_tests`). */
export const localReviewNote = 'Pinned to the current project revision for this run only. No operator policy was read, so no binding or egress grant applies, and extensions use a fresh temporary data directory, never the site\'s data/. serve and dev still need the reviewed pin (--policy or PROJECT_SHA256); with it, validate checks the data they will use.';
// Commands that activate the project locally and so accept the operator's `--alias-origin`.
export const aliasOriginCommands = ['dev','serve','validate','test','routes','audit'] as const;

/** The one CLI-wide allowlist passed to Node's argument parser. */
export const commandOptions = {
  json:{ type:'boolean' }, yaml:{ type:'boolean' },
  project:{ type:'string' }, 'host-file':{type:'string'}, with:{type:'string'}, ack:{type:'string', multiple:true}, example:{type:'boolean'}, site:{type:'string'}, strict:{type:'boolean'}, to:{type:'string'}, check:{type:'boolean'},
  port:{ type:'string' }, open:{ type:'boolean' }, 'no-open':{ type:'boolean' }, host:{ type:'string', default:'127.0.0.1' },
  'expect-routes':{type:'string'}, target:{type:'string'},
  workers:{type:'string'}, 'function-timeout-ms':{type:'string'}, 'max-response-bytes':{type:'string'}, 'max-body-bytes':{type:'string'},
  'max-in-flight':{type:'string'}, 'max-in-flight-health':{type:'string'}, 'request-log':{type:'string'}, 'trust-request-id':{type:'boolean'}, 'trusted-proxies':{type:'string'}, metrics:{type:'boolean'},
  'health-details':{type:'boolean'}, 'close-timeout-ms':{type:'string'}, 'drain-delay-ms':{type:'string'},
  'headers-timeout-ms':{type:'string'}, 'request-timeout-ms':{type:'string'}, 'keep-alive-timeout-ms':{type:'string'},
  'max-streams':{type:'string'}, 'stream-idle-timeout-ms':{type:'string'}, 'stream-max-duration-ms':{type:'string'}, 'stream-max-bytes':{type:'string'},
  release:{type:'string'}, 'git-commit':{type:'string'}, 'timeout-ms':{type:'string'}, 'fail-on':{type:'string'}, 'expect-metrics':{type:'boolean'},
  budget:{type:'string'}, task:{type:'string'}, capabilities:{type:'string'}, create:{type:'boolean'}, adopt:{type:'boolean'}, 'no-mcp':{type:'boolean'}, stats:{type:'boolean'}, out:{type:'string'}, 'dry-run':{type:'boolean'}, compare:{type:'string'}, format:{type:'string'}, compliance:{type:'string'}, 'compliance-rules':{type:'string'}, 'compliance-ignore':{type:'string'}, 'compliance-warn':{type:'boolean'}, policy:{ type:'string' }, origin:{ type:'string' }, 'alias-origin':{ type:'string', multiple:true }, alias:{ type:'string' }, local:{ type:'boolean' }, 'local-review':{ type:'boolean' }, verbose:{ type:'boolean' }, 'allow-authoring':{ type:'boolean' }, materialize:{ type:'boolean' }, into:{ type:'string' }, 'allow-app':{ type:'boolean' }, 'debug-errors':{ type:'boolean' }, 'signal-sink':{ type:'string' }, help:{ type:'boolean', short:'h' }, global:{ type:'boolean' }, version:{ type:'boolean', short:'v' },
} as const;

export type CliValues = ReturnType<typeof parseArgs<{ options: typeof commandOptions; allowPositionals: true }>>['values'];
