import { oshp, rfc9111, rfc9110, rfc6585, rfc9309, breach, management, active, functionLike, hasSecrets, yamlHeader, handlerCacheControl, directive, emittedSecurityHeaders } from './shared.ts';
import type { ComplianceRule, ProjectRule, RouteRule } from '../compliance.ts';

export const profile = 'baseline';

export const securityHeaders: RouteRule = {
  id: 'oshp/security-headers', title: 'Every active route carries a security headers profile', standard: oshp, severity: 'medium', appliesTo: 'route',
  check({ route, effective }) {
    if (!active(route) || effective.security) return [];
    return [{ message: `${route.path} has no policies.security, so responses carry none of the OSHP headers`, remediation: 'Declare policies.security (headers: oshp) at the project level or on the route' }];
  },
};

export const hstsOrigin: ProjectRule = {
  id: 'oshp/hsts-origin', title: 'HSTS is only reachable on an https origin', standard: { ...oshp, section: 'Strict-Transport-Security' }, severity: 'low', appliesTo: 'project',
  check({ plan, policies, origin }) {
    const emitting = plan.inventory.filter(route => active(route) && emittedSecurityHeaders(policies[route.path], plan.policies?.[route.path]).has('strict-transport-security'));
    if (!emitting.length || (origin && origin.startsWith('https:'))) return [];
    return [{
      message: origin ? `${emitting.length} route(s) declare Strict-Transport-Security but the declared origin ${origin} is not https, so the runtime never emits it` : `${emitting.length} route(s) declare Strict-Transport-Security but no public origin was declared, so whether it is emitted is unknown`,
      remediation: 'Serve behind TLS and declare it with --origin https://your.host (or URLCODE_ORIGIN); the runtime emits HSTS only on an https origin',
    }];
  },
};

export const secretsCompression: RouteRule = {
  id: 'breach/secrets-compression', title: 'Routes bound to secrets are never compressed', standard: breach, severity: 'high', appliesTo: 'route',
  check({ route, config, effective }) {
    if (!hasSecrets(config) || effective.compression?.allowWithSecrets !== true) return [];
    return [{ message: `${route.path} binds secrets and sets policies.compression.allowWithSecrets, so a compressed response can leak secret-derived bytes through length`, remediation: 'Remove allowWithSecrets (the runtime then skips compression on the route) or set policies.compression: false on the route' }];
  },
};

export const secretsNoStore: RouteRule = {
  id: 'rfc9111/secrets-no-store', title: 'Routes bound to secrets declare no-store or private caching', standard: { ...rfc9111, section: '5.2.2.5 no-store, 5.2.2.7 private' }, severity: 'medium', appliesTo: 'route',
  check({ route, config, effective }) {
    if (!hasSecrets(config)) return [];
    const problems: string[] = [];
    const strategy = effective.cache?.strategy;
    if (strategy && !['no-store','private'].includes(strategy)) problems.push(`policies.cache.strategy ${strategy}`);
    const yaml = yamlHeader(config, 'cache-control');
    if (yaml !== undefined && !directive(yaml, 'no-store') && !directive(yaml, 'private')) problems.push(`response header Cache-Control "${yaml}"`);
    const handler = handlerCacheControl(config);
    if (handler?.declared && !directive(handler.value, 'no-store') && !directive(handler.value, 'private')) problems.push(`handler cacheControl "${handler.value}"`);
    if (!problems.length) return [];
    return [{ message: `${route.path} binds secrets but declares ${problems.join(' and ')}, which lets a shared cache store a secret-derived response`, remediation: 'Use policies.cache strategy no-store or private, or a Cache-Control with no-store or private, on routes that bind secrets' }];
  },
};

export const cacheControlDeclared: RouteRule = {
  id: 'rfc9111/cache-control-declared', title: 'Every declared response states its Cache-Control', standard: rfc9111, severity: 'low', appliesTo: 'route',
  check({ route, config, effective }) {
    if (!active(route) || effective.cache) return [];
    if ((route.handler === 'respond' || route.handler === 'redirect') && yamlHeader(config, 'cache-control') === undefined) {
      return [{ message: `${route.path} (${route.handler}) declares no Cache-Control, so the runtime's default no-store applies`, remediation: 'State the intent: response.headers Cache-Control, or a policies.cache strategy' }];
    }
    const handler = handlerCacheControl(config);
    if (handler && !handler.declared) return [{ message: `${route.path} (${route.handler}) declares no cacheControl, so the asset handler's default no-cache applies`, remediation: `Set ${route.handler}.cacheControl or a policies.cache strategy` }];
    return [];
  },
};

export const throttleFunctions: RouteRule = {
  id: 'rfc6585/throttle-functions', title: 'Function and middleware routes declare a request budget', standard: rfc6585, severity: 'medium', appliesTo: 'route',
  check({ route, effective }) {
    if (!active(route) || !functionLike(route) || effective.throttle) return [];
    return [{ message: `${route.path} runs guest code without policies.throttle, so one client can occupy the function pool`, remediation: 'Declare policies.throttle (quota, window, partition) on the route or the project' }];
  },
};

export const robots: ProjectRule = {
  id: 'rfc9309/robots', title: 'Crawlers are addressed by an agents policy or a robots.txt route', standard: rfc9309, severity: 'low', appliesTo: 'project',
  check({ plan, policies, routes }) {
    const agents = plan.inventory.some(route => active(route) && policies[route.path]?.agents);
    const robotsRoute = plan.inventory.find(route => route.path === '/robots.txt');
    if (agents || (robotsRoute && active(robotsRoute) && routes['/robots.txt']?.respond)) return [];
    return [{ message: 'No active route declares policies.agents and no /robots.txt respond route exists, so crawlers get no instruction', remediation: 'Add a /robots.txt respond route (RFC 9309) or declare policies.agents with a deny list' }];
  },
};

export const expiredRoutes: ProjectRule = {
  id: 'rfc9110/expired-routes', title: 'Expired routes still present in YAML', standard: { ...rfc9110, section: '15.5.11 410 Gone' }, severity: 'info', appliesTo: 'project',
  check({ plan }) {
    const expired = plan.inventory.filter(route => route.state === 'expired').map(route => route.path);
    if (!expired.length) return [];
    return [{ message: `${expired.length} route(s) are past their expires and answer 410: ${expired.join(', ')}`, remediation: 'Remove routes whose 410 window has served its purpose, or keep them deliberately' }];
  },
};

export const managementPrivate: ProjectRule = {
  id: 'ops/management-private', title: 'Management and probe listeners stay private', standard: management, severity: 'info', appliesTo: 'project',
  check({ document }) {
    if (document.dynamicLinks !== true) return [];
    return [{ message: 'dynamicLinks is enabled; the link management API and the /_urlcode probes are meant for a private bind', remediation: 'Run `urlcode links api` on a private interface with an operator auth file, and keep /_urlcode/health and /_urlcode/ready internal' }];
  },
};

export const rules: readonly ComplianceRule[] = Object.freeze([securityHeaders, hstsOrigin, secretsCompression, secretsNoStore, cacheControlDeclared, throttleFunctions, robots, expiredRoutes, managementPrivate]);
