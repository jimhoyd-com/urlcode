# Authenticated JSON API

`/api/profile` is a function behind `auth: true`, the route-level short
form that expands to `policies.extensions.auth: {}`. The project declares the
`auth` extension; it never chooses or loads the module that implements it. Authorization happens in trusted operator code before the route's function
runs, and the host strips `Authorization` and `Cookie` before dispatch -- for
trusted and `sandbox: true` routes alike.

This recipe does not activate on its own. Every command needs an operator host
file outside the project, the canonical origin and the project revision the
operator reviewed (see [the review gate](#the-review-gate)):

```sh
export PROJECT_SHA256=<the reviewed revision>
urlcode validate --local --project . --host-file /operator/host.mjs --origin https://api.example.com
urlcode test --project . --host-file /operator/host.mjs --origin https://api.example.com
urlcode audit --project . --expect-routes 1 --host-file /operator/host.mjs --origin https://api.example.com
```

## The host file

A real deployment registers the `urlcode-auth` package. The minimal shape below
accepts one bearer token read from the operator's environment, so the bundled
fixtures pass; it is a protocol example, not deployable authentication. Keep it
outside the project directory: `--host-file` refuses a path inside it.

Like every add-on's host, it never computes the project revision itself.
`composeHost` hands `host()` the revision the operator reviewed, as
`projectSha256`: the verified `--policy` file's revision, otherwise
`PROJECT_SHA256`. Neither present refuses before anything activates.

```js
// /operator/host.mjs — trusted operator code, never part of the project
import {composeHost} from '@jimhoyd/urlcode/host';
import {defineExtension} from '@jimhoyd/urlcode/extensions';
const schema = {type: 'object', properties: {realm: {type: 'string'}}, required: ['realm'], additionalProperties: false};
const policySchema = {type: 'object', properties: {role: {type: 'string'}}, additionalProperties: false};
const token = process.env.API_DEMO_TOKEN; // "demo-token" reproduces tests/requests.json
const demoAuth = defineExtension({
  name: 'auth', description: 'Demo bearer-token check; a protocol example, not authentication.', schema, policySchema,
  host({projectSha256}) { // the reviewed revision, never recomputed from the project
    return {registration: {
      name: 'auth', version: '1', projectSha256, targets: ['node', 'aws', 'vercel'], schema, policySchema,
      activate(config) {
        return {
          handle() { return {status: 404, headers: [], body: 'no auth mount declared'}; },
          authorize(_requirement, request) {
            if (request.headers.get('authorization') === `Bearer ${token}`) return undefined;
            return {status: 401, headers: [['www-authenticate', `Bearer realm="${config.realm}"`]], body: 'sign in'};
          },
        };
      },
    }};
  },
});
export default await composeHost(import.meta.url, [demoAuth()]);
```

## The review gate

`projectSha256` pins the registration to the exact project revision the
operator reviewed. Review the project, then print its revision once and keep
it outside the project:

```sh
urlcode extensions --project .     # prints "Project revision: <sha256>"
```

Supply it to every command, either as `PROJECT_SHA256=<sha256>` or through a
reviewed operator policy, whose `projectSha256` is the same revision:

```sh
urlcode permissions --project . > /operator/api-policy.json   # review, then keep outside the project
urlcode validate --local --project . --policy /operator/api-policy.json --host-file /operator/host.mjs --origin https://api.example.com
```

Editing `urlcode.yaml` or the function changes the revision, so `validate`,
`test`, `audit` and `serve` then refuse with `Extension revision pin mismatch:
auth` (with `--policy`, a `revision-pin-mismatch` naming both revisions) until
the operator reviews the change and supplies the new revision. `urlcode dev`
alone lets a hot reload carry the pin it started with forward to the edited
project, for development only (#777; see
[the revision pin](../../docs/EXTENSIONS.md#the-revision-pin)).

Use `auth: {role: member}` on a route to require a role; the installed
extension validates those keys against its policy schema; the change needs a
new review and pin like any other. See [extensions](../../docs/EXTENSIONS.md).

Edit `functions/profile.mjs` to return real data. Cloudflare refuses extensions;
functions need the self-hosted runtime.
