export interface DeploymentCheckOptions { origin: string; authMount: string; allowDevelopment?: boolean; allowTurnstile?: boolean; }
export interface DeploymentCheckResult { passed: boolean; checks: { name: string; passed: boolean }[]; liveProviders: 'unverified'; }
/** Anonymous, read-only checks. No credentials, redirects, mail sends or account mutations. */
export async function verifyDeployment(options: DeploymentCheckOptions, transport: typeof fetch = fetch): Promise<DeploymentCheckResult> {
    const origin = new URL(options.origin);
    if (origin.origin !== options.origin || origin.username || origin.password || !(origin.protocol === 'https:' || options.allowDevelopment === true && origin.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname))) throw new Error('Canonical HTTPS origin required');
    if (!/^\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/.test(options.authMount) || options.authMount.length > 256) throw new Error('Explicit auth mount required');
    const checks: DeploymentCheckResult['checks'] = [];
    for (const [path, expected] of [['/login', 200], ['/account', 401]] as const) {
        const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 5000);
        const prefix = path === '/login' ? 'login' : 'anonymous-account';
        try {
            const response = await transport(options.origin + options.authMount + path, { method: 'GET', headers: { accept: 'text/html' }, credentials: 'omit', redirect: 'manual', signal: controller.signal });
            const add = (name: string, passed: boolean) => checks.push({ name: prefix + '.' + name, passed });
            add('status', response.status === expected);
            add('no-store', /(?:^|,)\s*no-store\s*(?:,|$)/i.test(response.headers.get('cache-control') ?? ''));
            add('private-referrer', ['no-referrer', 'strict-origin'].includes(response.headers.get('referrer-policy') ?? ''));
            add('nosniff', response.headers.get('x-content-type-options') === 'nosniff');
            const directives = (response.headers.get('content-security-policy') ?? '').split(';').map(item => item.trim().split(/\s+/)).filter(item => item[0]);
            const csp = new Map(directives.map(([name, ...values]) => [name!, values.join(' ')]));
            const sources = (name: string) => (csp.get(name) ?? '').split(/\s+/).filter(Boolean);
            const challengeSource = (source: string) => options.allowTurnstile === true && source === 'https://challenges.cloudflare.com';
            add('content-security-policy', csp.size === directives.length && csp.get('default-src') === "'none'" && csp.get('base-uri') === "'none'" && csp.get('frame-ancestors') === "'none'" && csp.get('form-action') === "'self'" && sources('script-src').every(source => /^'nonce-[A-Za-z0-9+/]{16,}={0,2}'$/.test(source) || challengeSource(source)) && sources('frame-src').every(source => source === "'none'" || challengeSource(source)) && sources('connect-src').every(source => source === "'none'" || source === "'self'" || challengeSource(source)));
            const cookies = response.headers.getSetCookie();
            add('cookie-policy', cookies.every(cookie => {
                const [pair, ...attributes] = cookie.split(';').map(value => value.trim());
                const attrs = new Map(attributes.map(value => { const at = value.indexOf('='); return at < 0 ? [value.toLowerCase(), ''] : [value.slice(0, at).toLowerCase(), value.slice(at + 1)]; }));
                return pair?.startsWith('__Host-') === true && !pair.startsWith('__Host-urlcode-session=') && attrs.has('secure') && attrs.has('httponly') && attrs.get('path') === '/' && !attrs.has('domain') && ['Strict', 'Lax'].includes(attrs.get('samesite') ?? '');
            }));
            // Cancel without reading account markup, debug bodies or unexpected proxy output.
            await response.body?.cancel();
        } catch { checks.push({ name: prefix + '.reachable', passed: false }); }
        finally { clearTimeout(timer); }
    }
    return { passed: checks.every(check => check.passed), checks, liveProviders: 'unverified' };
}
