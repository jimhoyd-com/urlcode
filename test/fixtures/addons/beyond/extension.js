// An independent extension (#844) built for URLCode extension contract 2, which this core does not implement. Shaped
// like defineExtension's result without importing core, so only core's own checks (add, list --strict, validate and
// composeHost) stand between it and activation.
const schema = { type: 'object' };
const definition = {
  name: 'beyond', description: 'Independent fixture extension built for a later URLCode extension contract', contract: 2, requires: [], targets: ['node'], schema,
  scaffold: () => ({ config: {}, routes: {} }),
  host: ctx => ({ registration: { name: 'beyond', version: '1', projectSha256: ctx.projectSha256, targets: ['node'], schema,
    activate: () => ({ handle: () => ({ status: 200, headers: [], body: 'beyond' }) }) } }),
};
const entry = options => Object.freeze({ definition, options: options ?? {} });
entry.definition = definition;
export default entry;
