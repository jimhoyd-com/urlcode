import test from 'node:test';
import assert from 'node:assert/strict';
import { commandOptions, hostFileCommands, policyCommands } from '../packages/core/src/cli-command-metadata.ts';
import { addressInUseMessage, argumentError } from '../packages/core/src/cli-errors.ts';

test('CLI command metadata keeps external-code and policy commands explicit', () => {
  assert(hostFileCommands.includes('mcp'));
  assert(hostFileCommands.includes('serve'));
  assert(policyCommands.includes('serve'));
  assert(!(policyCommands as readonly string[]).includes('mcp'));
  for (const option of ['host-file', 'policy', 'bundle-release', 'artifact-release', 'help', 'version']) assert(Object.hasOwn(commandOptions, option), option);
});

test('CLI diagnostic helpers only echo validated option and socket facts', () => {
  assert.match(addressInUseMessage({ address: '127.0.0.1', port: 3000 }), /Port 3000 on 127\.0\.0\.1/);
  assert.match(addressInUseMessage({ address: 'untrusted text', port: 0 }), /^The port/);
  const unknown = argumentError('ERR_PARSE_ARGS_UNKNOWN_OPTION', "Unknown option '--projet'", Object.keys(commandOptions));
  assert.match(unknown?.message ?? '', /did you mean --project/);
  assert.deepEqual(unknown?.details, { code: 'unknown-option' });
  assert.equal(argumentError('ERR_PARSE_ARGS_UNKNOWN_OPTION', "Unknown option '--secret=token'", Object.keys(commandOptions))?.message, 'Unknown option; use --help');
});
