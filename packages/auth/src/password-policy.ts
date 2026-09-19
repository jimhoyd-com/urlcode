import { createHash } from 'node:crypto';
import { AuthError } from './auth-core.ts';
export interface PasswordBreachOptions {
    fetch?: typeof fetch;
    timeoutMs?: number;
}
/** Opt-in operator transport. SHA-1 is the range lookup protocol, never password storage.
 * https://haveibeenpwned.com/API/v3#PwnedPasswords */
export function createPasswordBreachChecker(options: PasswordBreachOptions = {}): (password: string) => Promise<void> {
    const transport = options.fetch ?? fetch, timeout = options.timeoutMs ?? 3000;
    let active = 0;
    if (!Number.isSafeInteger(timeout) || timeout < 10 || timeout > 10000)
        throw new Error('Invalid breach-check deadline');
    return async (password) => {
        if (typeof password !== 'string' || !password || Buffer.byteLength(password) > 1024)
            throw new AuthError(400, 'password_length_invalid');
        if (active >= 4)
            throw new AuthError(503, 'password_check_unavailable');
        const digest = createHash('sha1').update(password, 'utf8').digest('hex').toUpperCase();
        const controller = new AbortController();
        let timer: ReturnType<typeof setTimeout> | undefined;
        active++;
        const work = (async () => {
            const response = await transport('https://api.pwnedpasswords.com/range/' + digest.slice(0, 5), { method: 'GET', redirect: 'error', headers: { 'Add-Padding': 'true', 'User-Agent': 'URLCode-auth', 'Accept': 'text/plain' }, signal: controller.signal });
            if (response.status !== 200 || !response.body) {
                await response.body?.cancel();
                throw new Error('Unavailable');
            }
            const reader = response.body.getReader(), chunks: Uint8Array[] = [];
            let bytes = 0;
            try {
                while (true) {
                    const chunk = await reader.read();
                    if (chunk.done)
                        break;
                    bytes += chunk.value.byteLength;
                    if (bytes > 1048576)
                        throw new Error('Oversized response');
                    chunks.push(chunk.value);
                }
            }
            finally {
                await reader.cancel().catch(() => { });
                reader.releaseLock();
            }
            const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
            const lines = text.trim().split(/\r?\n/);
            if (!text.trim() || lines.length > 20000)
                throw new Error('Invalid response');
            let breached = false;
            for (const line of lines) {
                const entry = /^([A-F0-9]{35}):([0-9]{1,12})$/.exec(line);
                if (!entry)
                    throw new Error('Invalid response');
                if (entry[1] === digest.slice(5) && Number(entry[2]) > 0)
                    breached = true;
            }
            return breached;
        })().finally(() => { active--; });
        try {
            const breached = await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('Timeout')); }, timeout); })]);
            if (breached)
                throw new AuthError(400, 'password_compromised');
        }
        catch (error) {
            if (error instanceof AuthError)
                throw error;
            throw new AuthError(503, 'password_check_unavailable');
        }
        finally {
            if (timer)
                clearTimeout(timer);
            controller.abort();
        }
    };
}
