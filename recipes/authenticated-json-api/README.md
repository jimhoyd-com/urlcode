# Authenticated JSON API

`/api/profile` is a sandboxed function behind `auth: true`, the route-level short
form that expands to `policies.extensions.auth: {}`. The project declares the
`auth` extension; it never chooses or loads the module that implements it. Authorization happens in trusted operator code before the guest
runs, and the runtime withholds `Authorization` and `Cookie` from the sandbox.

This recipe does not activate on its own. Every command needs an operator host
file outside the project plus the canonical origin:

```sh
urlcode validate --local --project . --host-file /operator/host.mjs --origin https://api.example.com
urlcode test --project . --host-file /operator/host.mjs --origin https://api.example.com
urlcode audit --project . --expect-routes 1 --host-file /operator/host.mjs --origin https://api.example.com
```

## The host file

A real deployment registers the `urlcode-auth` package. The minimal shape below
accepts one bearer token read from the operator's environment, so the bundled
fixtures pass; it is a protocol example, not deployable authentication. Keep it
outside the project directory: `--host-file` refuses a path inside it.

```js
// /operator/host.mjs — trusted operator code, never part of the project
import {inspectExtensionRevision} from '@jimhoyd/urlcode/extensions';
const projectSha256 = await inspectExtensionRevision(process.env.URLCODE_PROJECT);
const token = process.env.API_DEMO_TOKEN; // "demo-token" reproduces tests/requests.json
export default {extensions: [{
  name: 'auth', version: '1', projectSha256, targets: ['node', 'aws', 'vercel'],
  schema: {type: 'object', properties: {realm: {type: 'string'}}, required: ['realm'], additionalProperties: false},
  policySchema: {type: 'object', properties: {role: {type: 'string'}}, additionalProperties: false},
  activate(config) {
    return {
      handle() { return {status: 404, headers: [], body: 'no auth mount declared'}; },
      authorize(_requirement, request) {
        if (request.headers.get('authorization') === `Bearer ${token}`) return undefined;
        return {status: 401, headers: [['www-authenticate', `Bearer realm="${config.realm}"`]], body: 'sign in'};
      },
    };
  },
}]};
```

Use `auth: {role: member}` on a route to require a role; the installed
extension validates those keys against its policy schema. `projectSha256` pins the registration to this exact project revision. Editing
`urlcode.yaml` or the function changes the hash, and activation fails until the
operator reviews the change and pins it again. See [extensions](../../docs/EXTENSIONS.md).

Edit `functions/profile.mjs` to return real data. Cloudflare refuses extensions;
functions need the self-hosted runtime.
