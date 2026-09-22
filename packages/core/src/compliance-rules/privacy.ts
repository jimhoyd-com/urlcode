import { monitoring, active } from './shared.ts';
import type { ComplianceRule, ProjectRule, RouteRule } from '../compliance.ts';

export const profile = 'privacy';

// These rules check the host settings the operator declares for the
// deployment under review (`host.requestLog`), because the runtime's log
// guarantees are settings of the serving process, not of the project. An
// undeclared setting is reported as unknown rather than assumed.
const requestLogMinimal: ProjectRule = {
  id: 'privacy/request-log-minimal', title: 'Request log records stay minimal', standard: monitoring, severity: 'medium', appliesTo: 'project',
  check({ host }) {
    if (host.requestLog === 'minimal') return [];
    if (host.requestLog === null) return [{ severity: 'info', message: 'The deployment request log level was not declared, so the check cannot confirm it is minimal', remediation: 'Declare the deployment setting: --request-log minimal|detailed on audit, or host.requestLog in runCompliance' }];
    return [{ message: 'The deployment logs with --request-log detailed, which adds the method and matched route pattern to every request record', remediation: 'Use the default minimal log unless per-route error rates are required; detailed records still carry no path, query, header or body' }];
  },
};

const detailedParameters: RouteRule = {
  id: 'privacy/detailed-log-parameters', title: 'No detailed logging on parameterised routes', standard: monitoring, severity: 'low', appliesTo: 'route',
  check({ route, config, host }) {
    if (host.requestLog !== 'detailed' || !active(route) || !((config.parameters?.length ?? 0) > 0)) return [];
    return [{ message: `${route.path} takes parameters and the deployment logs detailed records; each record names the pattern and method (never parameter values)`, remediation: 'Keep --request-log minimal on deployments serving parameterised routes, or accept that per-pattern latency and error rates are recorded' }];
  },
};

export const rules: readonly ComplianceRule[] = Object.freeze([requestLogMinimal, detailedParameters]);
