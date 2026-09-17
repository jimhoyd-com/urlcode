import { monitoring, linkChannel, active } from './shared.ts';

export const profile = 'privacy';

// These rules check the host settings the operator declares for the
// deployment under review (`host.requestLog`, `host.linkEvents`,
// `host.includeCode`), because the runtime's log guarantees are settings of
// the serving process, not of the project. An undeclared setting is reported
// as unknown rather than assumed.
export const requestLogMinimal = {
  id: 'privacy/request-log-minimal', title: 'Request log records stay minimal', standard: monitoring, severity: 'medium', appliesTo: 'project',
  check({ host }) {
    if (host.requestLog === 'minimal') return [];
    if (host.requestLog === null) return [{ severity: 'info', message: 'The deployment request log level was not declared, so the check cannot confirm it is minimal', remediation: 'Declare the deployment setting: --request-log minimal|detailed on audit, or host.requestLog in runCompliance' }];
    return [{ message: 'The deployment logs with --request-log detailed, which adds the method and matched route pattern to every request record', remediation: 'Use the default minimal log unless per-route error rates are required; detailed records still carry no path, query, header or body' }];
  },
};

export const linkEventsOff = {
  id: 'privacy/link-events-off', title: 'Link events stay off unless declared', standard: linkChannel, severity: 'medium', appliesTo: 'project',
  check({ document, host }) {
    if (document.dynamicLinks !== true || host.linkEvents === false) return [];
    if (host.linkEvents === null) return [{ severity: 'info', message: 'dynamicLinks is enabled and the deployment did not declare whether the link event channel is on', remediation: 'Declare host.linkEvents (and host.includeCode) for the deployment under review' }];
    if (host.includeCode === true) return [{ severity: 'high', message: 'The link event channel is on with includeCode, so every event names the short code a person followed', remediation: 'Leave includeCode off; the channel then redacts the code and reports only route, outcome and timing' }];
    return [{ message: 'The link event channel is on, so per-click records leave the process', remediation: 'Enable linkEvents only for a declared click-collection purpose and keep the collector bounded' }];
  },
};

export const detailedParameters = {
  id: 'privacy/detailed-log-parameters', title: 'No detailed logging on parameterised routes', standard: monitoring, severity: 'low', appliesTo: 'route',
  check({ route, config, host }) {
    if (host.requestLog !== 'detailed' || !active(route) || !(config.parameters?.length > 0)) return [];
    return [{ message: `${route.path} takes parameters and the deployment logs detailed records; each record names the pattern and method (never parameter values)`, remediation: 'Keep --request-log minimal on deployments serving parameterised routes, or accept that per-pattern latency and error rates are recorded' }];
  },
};

export const rules = Object.freeze([requestLogMinimal, linkEventsOff, detailedParameters]);
