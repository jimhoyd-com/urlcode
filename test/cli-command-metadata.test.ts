import test from 'node:test';
import assert from 'node:assert/strict';
import { aliasOriginCommands, commandOptions, hostFileCommands, policyCommands } from '../packages/core/src/cli-command-metadata.ts';
import { addressInUseMessage, argumentError } from '../packages/core/src/cli-errors.ts';

test('CLI command metadata keeps external-code and policy commands explicit', () => {
  assert(hostFileCommands.includes('mcp'));
  assert(hostFileCommands.includes('serve'));
  assert(policyCommands.includes('serve'));
  assert(!(policyCommands as readonly string[]).includes('mcp'));
  assert(hostFileCommands.includes('extensions'));
  for (const option of ['host-file', 'policy', 'site', 'strict', 'ack', 'help', 'version']) assert(Object.hasOwn(commandOptions, option), option);
  // The removed release and manifest flags stay removed; --project has no fixed default (the CLI picks app/ or .).
  for (const option of ['bundle-release', 'bundle-release-path', 'artifact-release', 'manifest', 'no-manifest', 'pin']) assert(!Object.hasOwn(commandOptions, option), option);
  assert(!('default' in commandOptions.project));
  // Operator alias origins are a repeatable operator flag, accepted only where the project activates locally.
  assert.equal(commandOptions['alias-origin'].multiple, true);
  // The shared passkey RP ID is a single operator value on the same commands (#729).
  assert.equal(commandOptions['passkey-rp-id'].type, 'string');
  assert(!('multiple' in commandOptions['passkey-rp-id']));
  for (const command of ['serve', 'dev', 'validate', 'test']) assert((aliasOriginCommands as readonly string[]).includes(command), command);
  assert(!(aliasOriginCommands as readonly string[]).includes('add'), 'add keeps its unrelated --alias short-code flag');
});

test('CLI diagnostic helpers only echo validated option and socket facts', () => {
  assert.match(addressInUseMessage({ address: '127.0.0.1', port: 3000 }), /Port 3000 on 127\.0\.0\.1/);
  assert.match(addressInUseMessage({ address: 'untrusted text', port: 0 }), /^The port/);
  const unknown = argumentError('ERR_PARSE_ARGS_UNKNOWN_OPTION', "Unknown option '--projet'", Object.keys(commandOptions));
  assert.match(unknown?.message ?? '', /did you mean --project/);
  assert.deepEqual(unknown?.details, { code: 'unknown-option' });
  assert.equal(argumentError('ERR_PARSE_ARGS_UNKNOWN_OPTION', "Unknown option '--secret=token'", Object.keys(commandOptions))?.message, 'Unknown option; use --help');
});
