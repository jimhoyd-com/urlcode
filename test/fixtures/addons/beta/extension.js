const schema = { type: 'object' };
const definition = {
  name: 'beta', description: 'Fixture extension that requires alpha', requires: ['alpha'], schema,
  policySchema: { type: 'object', additionalProperties: false, properties: { level: { type: 'integer' } } },
  scaffold: ({ acknowledgements }) => {
    if (!acknowledgements.includes('beta:risky')) throw Object.assign(new Error('beta is risky'), { acknowledgement: 'beta:risky' });
    return { config: {}, routes: { '/beta': { respond: { text: 'beta' }, policies: { extensions: { beta: { level: 1 } } } } }, acknowledged: ['beta:risky'], routeNotes: ['risky on purpose'] };
  },
  host(ctx) {
    const alpha = ctx.get('alpha');
    globalThis.betaSaw = { alpha, contributions: ctx.contributions('beta') };
    return { registration: { name: 'beta', version: '1', projectSha256: ctx.projectSha256, targets: ['node'], schema, policySchema: definition.policySchema,
      activate: () => ({ handle: () => ({ status: 404 }), authorize: () => undefined }) } };
  },
};
const entry = options => Object.freeze({ definition, options: options ?? {} });
entry.definition = definition;
export default entry;
