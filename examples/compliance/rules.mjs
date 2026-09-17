// Operator compliance rules for `urlcode audit --compliance-rules`.
// Runnable against the cookbook from the runtime checkout:
//
//   node src/cli.js audit --project examples/cookbook \
//     --compliance baseline --compliance-rules "$PWD/examples/compliance/rules.mjs" --compliance-warn
//
// The file must sit outside the audited project (it is trusted host code, the
// same rule as --policy). It exports `rules` to add, `disable` to drop
// built-in rules by id, and `override` to change fields of an existing rule.
// Every check reads only the context runCompliance hands it: the parsed YAML
// (`document`, `routes`), the runtime's test plan (`plan`), the effective
// policies per route (`policies`, `effective`), the declared `origin` and the
// declared `host` settings.

// Which redirect hosts this operator considers their own.
const allowedHosts = ['example.com', 'www.example.com'];

export const rules = [
  {
    id: 'acme/redirect-hosts',
    title: 'Redirects only leave for approved hosts',
    standard: { name: 'ACME link policy', reference: 'https://example.com/policies/links', section: 'Outbound redirects' },
    severity: 'high',
    appliesTo: 'route',
    check({ route, config }) {
      const url = config.redirect?.url;
      if (route.state !== 'active' || typeof url !== 'string') return [];
      // Templates such as https://host/{id} still start with a fixed host.
      let host;
      try { host = new URL(url.replace(/\{[^}]*\}/g, 'x')).hostname; } catch { return [{ message: `${route.path} redirect target could not be parsed`, remediation: 'Use an absolute https URL' }]; }
      if (allowedHosts.includes(host)) return [];
      return [{ message: `${route.path} redirects to ${host}, which is not an approved host`, remediation: `Redirect only to ${allowedHosts.join(', ')} or extend the allow list in rules.mjs` }];
    },
  },
  {
    id: 'acme/described-routes',
    title: 'Every active route carries a description',
    standard: { name: 'ACME YAML conventions', reference: 'https://example.com/policies/yaml' },
    severity: 'low',
    appliesTo: 'route',
    check({ route, config }) {
      if (route.state !== 'active' || typeof config.description === 'string') return [];
      return [{ message: `${route.path} has no description`, remediation: 'Add a one-line description so audits and reviews can name the route by purpose' }];
    },
  },
  {
    id: 'acme/declared-origin',
    title: 'The audit declares the public origin',
    standard: { name: 'ACME deployment checklist', reference: 'https://example.com/policies/deploy' },
    severity: 'info',
    appliesTo: 'project',
    check({ origin }) {
      if (origin) return [];
      return [{ message: 'No --origin was declared, so origin-dependent rules cannot confirm https', remediation: 'Pass --origin https://your.host to audit' }];
    },
  },
];

// The cookbook keeps an expired route on purpose to show a 410.
export const disable = ['rfc9110/expired-routes'];

// This operator treats a missing security profile as blocking.
export const override = {
  'oshp/security-headers': { severity: 'high' },
};
