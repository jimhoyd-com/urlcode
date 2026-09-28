// An independent extension (#844): a package outside @jimhoyd, found by its urlcode.json descriptor, not its name.
const schema = { type: 'object', additionalProperties: false, properties: { text: { type: 'string' } } };
const definition = {
  name: 'greeting', description: 'Independent fixture extension outside the first-party namespace', requires: [], schema,
  scaffold: () => ({ config: { text: 'hi' }, routes: { '/greeting/*': { extension: 'greeting', methods: ['GET', 'HEAD'] } } }),
  host: ctx => ({ registration: { name: 'greeting', version: '1', projectSha256: ctx.projectSha256, targets: ['node'], schema,
    activate: config => ({ handle: () => ({ status: 200, headers: [['content-type', 'text/plain']], body: config.text }) }) } }),
};
const entry = options => Object.freeze({ definition, options: options ?? {} });
entry.definition = definition;
export default entry;
