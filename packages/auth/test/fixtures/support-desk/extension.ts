// A synthetic support desk: the second consumer of AuthExports v1 (admin is the first). It is mounted behind an auth
// policy (`auth: {permission: auth.cases.read}`), reads the signed-in account auth resolved, lists cases and adds a case
// note through `auth.administration`, embeds auth's CSRF token in its form, and sends a stale write to auth's step-up
// page. It never reads a cookie, a session token or a key: every auth import is a type.
import { defineExtension, jsonResponse, readFields, wantsJson } from '@jimhoyd/urlcode/extensions';
import type { ExtensionRequest, HandlerResult } from '@jimhoyd/urlcode/extensions';
import type { AuthExports } from '../../../src/index.ts';

const schema = { type: 'object', additionalProperties: false, properties: {} };
export default defineExtension({
    name: 'support-desk',
    description: 'Synthetic support desk that consumes AuthExports',
    requires: ['auth', 'ui', 'audit'],
    schema,
    host(ctx) {
        const auth = ctx.get<AuthExports>('auth');
        if (auth?.version !== 1) throw new Error('support-desk needs auth exports version 1');
        return { registration: { name: 'support-desk', version: '1', projectSha256: ctx.projectSha256, targets: ['node'], schema,
            activate(_config, context) {
                const mount = context.mounts[0]!;
                if (!context.principalMounts?.includes(mount)) throw new Error(`${mount}/* must carry an auth policy`);
                return {
                    async handle(request: ExtensionRequest): Promise<HandlerResult> {
                        const account = auth.account(request);
                        if (!account || account.impersonated) return jsonResponse(404, { error: 'Not found' });
                        const path = request.path.slice(mount.length);
                        try {
                            if (request.method === 'GET' && path === '/cases') {
                                const { cases } = await auth.administration.cases.list(account.actor, { limit: 20 });
                                const csrf = auth.csrf.token(request);
                                if (wantsJson(request)) return jsonResponse(200, { cases: cases.map(item => ({ id: item.id, notes: item.notes?.length ?? 0 })), csrf });
                                return { status: 200, headers: [['content-type', 'text/html; charset=utf-8']], body: `<form method="post" action="${mount}/cases/note"><input type="hidden" name="${auth.csrf.field}" value="${csrf}"><input name="caseId"><input name="note"><button>Add note</button></form>` };
                            }
                            if (request.method === 'POST' && path === '/cases/note') {
                                // A stale proof goes to auth's step-up page and returns here afterwards.
                                if (!account.fresh) return { status: 303, headers: [['location', auth.urls.stepUp(mount + '/cases')]], body: '' };
                                const fields = readFields(request, { fields: ['csrf', 'caseId', 'note'] });
                                const updated = await auth.administration.cases.note(account.actor, { caseId: fields.caseId ?? '', note: fields.note ?? '' });
                                return jsonResponse(200, { notes: updated.notes?.length ?? 0 });
                            }
                            return jsonResponse(404, { error: 'Not found' });
                        }
                        catch (error) {
                            const status = error instanceof Error && 'status' in error && typeof error.status === 'number' && error.status >= 400 && error.status < 600 ? error.status : 500;
                            return jsonResponse(status, { error: error instanceof Error && 'code' in error ? String(error.code) : 'failed' });
                        }
                    },
                };
            } } };
    },
});
