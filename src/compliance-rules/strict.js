import { rules as baseline } from './baseline.js';
import { oshp, rfc9110, rfc6585, agentLists, active, functionLike, yamlHeader, yamlHeaderBytes, emittedSecurityHeaders, securityHeaderBytes } from './shared.js';

export const profile = 'strict';

// The runtime caps a response at 16 KiB of headers; the security policy
// bounds its own static headers at half of that so the handler keeps room.
export const headerBudgetBytes = 8192;

export const csp = {
  id: 'oshp/csp', title: 'Every active route emits a Content-Security-Policy', standard: { ...oshp, section: 'Content-Security-Policy' }, severity: 'medium', appliesTo: 'route',
  check({ route, config, effective, policy }) {
    if (!active(route) || emittedSecurityHeaders(effective, policy).has('content-security-policy') || yamlHeader(config, 'content-security-policy') !== undefined) return [];
    return [{ message: `${route.path} emits no Content-Security-Policy (profile ${effective.security?.headers ?? 'none'})`, remediation: 'Use the oshp profile, or set Content-Security-Policy through policies.security.set or response.headers' }];
  },
};

export const throttleAll = {
  id: 'rfc6585/throttle-all', title: 'Every active route declares a request budget', standard: rfc6585, severity: 'medium', appliesTo: 'route',
  check({ route, effective }) {
    if (!active(route) || functionLike(route) || effective.throttle) return [];
    return [{ message: `${route.path} has no policies.throttle`, remediation: 'Declare policies.throttle at the project level so every route carries a budget' }];
  },
};

export const listsPinned = {
  id: 'agents/lists-pinned', title: 'Agent deny and allow lists are pinned to a revision', standard: agentLists, severity: 'low', appliesTo: 'route',
  check({ route, effective, policy }) {
    if (!active(route) || !effective.agents) return [];
    const unpinned = [];
    for (const side of ['deny','allow']) {
      const used = policy.agents?.[side];
      if (Array.isArray(used)) { for (const list of used) if (!list.revision || list.revision === 'project') unpinned.push(list.name); }
      else for (const entry of effective.agents[side] ?? []) if (typeof entry === 'string' && entry.endsWith('.json')) unpinned.push(entry);
    }
    if (!unpinned.length) return [];
    return [{ message: `${route.path} uses project list file(s) without an upstream revision: ${unpinned.join(', ')}`, remediation: 'Prefer the bundled lists (ai-crawlers, crawlers, seo, monitoring), which the audit reports with their pinned upstream revision, or record the revision your list was built from' }];
  },
};

export const redirectHttps = {
  id: 'rfc9110/redirect-https', title: 'Redirect targets are https', standard: { ...rfc9110, section: '15.4 Redirection 3xx' }, severity: 'medium', appliesTo: 'route',
  check({ route, config }) {
    const url = config.redirect?.url;
    if (!active(route) || typeof url !== 'string' || !/^http:/i.test(url)) return [];
    return [{ message: `${route.path} redirects to a plain http URL`, remediation: 'Point the redirect at an https URL so the hop after this runtime stays encrypted' }];
  },
};

export const headerBudget = {
  id: 'http/header-budget', title: 'Declared response headers stay under the static budget', standard: { ...rfc9110, section: '5.4 Field Limits' }, severity: 'low', appliesTo: 'route',
  check({ route, config, effective, policy }) {
    if (!active(route)) return [];
    const bytes = yamlHeaderBytes(config) + securityHeaderBytes(effective, policy);
    if (bytes <= headerBudgetBytes) return [];
    return [{ message: `${route.path} declares ${bytes} bytes of static response headers, over the ${headerBudgetBytes}-byte budget that leaves room for handler headers under the runtime's 16 KiB cap`, remediation: 'Trim response.headers or the security set/profile so static headers use at most half of the 16 KiB response header limit' }];
  },
};

export const rules = Object.freeze([...baseline, csp, throttleAll, listsPinned, redirectHttps, headerBudget]);
