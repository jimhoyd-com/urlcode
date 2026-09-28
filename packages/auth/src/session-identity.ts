/** Auth-owned projection in core's client-stripped reserved context namespace. */
export const sessionIdentityHeader = 'x-urlcode-context-auth-session';

/**
 * Read the opaque user id projected by a successful native session authorization.
 * Trust this value only in a URLCode guest request behind the auth extension:
 * URLCode strips inbound reserved headers, and auth writes it after authorization,
 * CSRF and principal assignment succeed. This accessor does not authenticate an
 * arbitrary Request. Bearer authorization does not populate this session channel.
 */
export function sessionUserId(request: { headers: { get(name: string): string | null } }): string | null {
    const value = request.headers.get(sessionIdentityHeader);
    return value !== null && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.exec(value)?.[0] === value ? value : null;
}
