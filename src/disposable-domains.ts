import { domainToASCII } from 'node:url';
import { disposableDomainData } from './disposable-domain-data.ts';
export const disposableDomainsRevision = 'be0dd1affed11ea9b1ffcd14da81319f9a080609';
const blocked = new Set(disposableDomainData);
/** Exact domain or dot-delimited subdomain match, never substring matching. No DNS/network lookup. */
export function isDisposableEmailDomain(value: string): boolean {
    if (typeof value !== 'string' || value.length > 253 || value.endsWith('.') || /[\s/@\\:]/.test(value)) throw new Error('Invalid email domain');
    const domain = domainToASCII(value.toLowerCase());
    if (!domain || domain.length > 253 || domain.split('.').some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) throw new Error('Invalid email domain');
    const labels = domain.split('.');
    for (let index = 0; index < labels.length - 1; index++) if (blocked.has(labels.slice(index).join('.'))) return true;
    return false;
}
