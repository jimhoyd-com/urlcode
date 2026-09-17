/** Registration data is descriptive, never authority. Roles, grants and session state are separate service operations. */
export type MetadataValue = string | number | boolean;
export interface MetadataField {
    type: 'string' | 'number' | 'boolean';
    scope: 'public' | 'private' | 'unsafe';
    required?: boolean;
    default?: MetadataValue;
    enum?: MetadataValue[];
    maxLength?: number;
    minimum?: number;
    maximum?: number;
}
export interface RegistrationOptions {
    termsVersion?: string;
    metadata?: Record<string, MetadataField>;
    locales?: string[];
}
export interface RegistrationInput {
    displayName?: string;
    locale?: string;
    metadata?: Record<string, MetadataValue>;
    termsAccepted?: boolean;
}
export interface RegistrationProfile {
    displayName?: string;
    locale?: string;
    metadata: Record<string, MetadataValue>;
    terms?: {
        version: string;
        acceptedAt: number;
    };
}
export interface RegistrationPolicy {
    publicSchema(): RegistrationOptions;
    validate(input: RegistrationInput, context: {
        now: number;
        existing?: RegistrationProfile;
        operator?: boolean;
    }): RegistrationProfile;
    /** Public and unsafe metadata remain untrusted user content. Private metadata never leaves this projection. */
    publicProfile(profile: RegistrationProfile): RegistrationProfile;
}
const forbidden = new Set(['__proto__', 'prototype', 'constructor', 'role', 'roles', 'permission', 'permissions', 'session', 'sessions', 'sessionid', 'token', 'password', 'passwordhash', 'secret', 'secrets', 'emailverified', 'status', 'administrator', 'id', 'userid', 'accountid', 'authenticatedat', 'totp', 'totpsecret', 'recoverycodes', 'claims', 'auth', 'security']);
function object(value: unknown): value is Record<string, unknown> { return Boolean(value && typeof value === 'object' && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)); }
function locale(value: unknown): string {
    if (typeof value !== 'string' || value.length > 64 || !/^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/.test(value))
        throw new Error('Invalid profile locale');
    try {
        return Intl.getCanonicalLocales(value)[0]!;
    }
    catch {
        throw new Error('Invalid profile locale');
    }
}
function validValue(value: unknown, field: MetadataField): value is MetadataValue {
    if (typeof value !== field.type)
        return false;
    if (typeof value === 'string' && (value.length > (field.maxLength ?? 1024) || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)))
        return false;
    if (typeof value === 'number' && (!Number.isFinite(value) || Math.abs(value) > 1e12 || field.minimum !== undefined && value < field.minimum || field.maximum !== undefined && value > field.maximum))
        return false;
    return !field.enum || field.enum.includes(value as MetadataValue);
}
export function createRegistrationPolicy(options: RegistrationOptions = {}): RegistrationPolicy {
    if (!object(options) || Object.keys(options).some(key => !['termsVersion', 'metadata', 'locales'].includes(key)))
        throw new Error('Unknown registration option');
    const terms = options.termsVersion;
    if (terms !== undefined && (typeof terms !== 'string' || !terms || terms.length > 128 || /[\x00-\x1f\x7f]/.test(terms)))
        throw new Error('Invalid terms version');
    if (options.locales !== undefined && (!Array.isArray(options.locales) || !options.locales.length || options.locales.length > 32))
        throw new Error('Invalid profile locales');
    const locales = options.locales?.map(locale);
    if (locales && new Set(locales).size !== locales.length)
        throw new Error('Duplicate profile locale');
    const source = options.metadata ?? {};
    if (!object(source) || Object.keys(source).length > 32)
        throw new Error('Invalid metadata schema');
    const fields: Record<string, MetadataField> = Object.create(null) as Record<string, MetadataField>;
    for (const [name, input] of Object.entries(source)) {
        if (!/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(name) || forbidden.has(name.replaceAll('_', '').toLowerCase()))
            throw new Error('Reserved or invalid metadata field');
        if (!object(input) || Object.keys(input).some(key => !['type', 'scope', 'required', 'default', 'enum', 'maxLength', 'minimum', 'maximum'].includes(key)) || !['string', 'number', 'boolean'].includes(String(input.type)) || !['public', 'private', 'unsafe'].includes(String(input.scope)))
            throw new Error('Invalid metadata field schema');
        const field = structuredClone(input) as unknown as MetadataField;
        if (field.required !== undefined && typeof field.required !== 'boolean')
            throw new Error('Invalid required flag');
        if (field.maxLength !== undefined && (field.type !== 'string' || !Number.isInteger(field.maxLength) || field.maxLength < 1 || field.maxLength > 4096))
            throw new Error('Invalid string bound');
        for (const bound of [field.minimum, field.maximum])
            if (bound !== undefined && (field.type !== 'number' || !Number.isFinite(bound) || Math.abs(bound) > 1e12))
                throw new Error('Invalid numeric bound');
        if (field.minimum !== undefined && field.maximum !== undefined && field.minimum > field.maximum)
            throw new Error('Inverted numeric bounds');
        if (field.enum !== undefined && (!Array.isArray(field.enum) || !field.enum.length || field.enum.length > 64 || field.enum.some(value => !validValue(value, { type: field.type, scope: field.scope, ...(field.maxLength !== undefined ? { maxLength: field.maxLength } : {}), ...(field.minimum !== undefined ? { minimum: field.minimum } : {}), ...(field.maximum !== undefined ? { maximum: field.maximum } : {}) }))))
            throw new Error('Invalid metadata enum');
        if (Object.hasOwn(field, 'default') && !validValue(field.default, field))
            throw new Error('Invalid metadata default');
        if (field.enum)
            Object.freeze(field.enum);
        fields[name] = Object.freeze(field);
    }
    Object.freeze(fields);
    const validate = (input: RegistrationInput, context: {
        now: number;
        existing?: RegistrationProfile;
        operator?: boolean;
    }): RegistrationProfile => {
        if (!object(input) || Object.keys(input).some(key => !['displayName', 'locale', 'metadata', 'termsAccepted'].includes(key)))
            throw new Error('Unknown profile field');
        if (!Number.isSafeInteger(context.now) || context.now < 0)
            throw new Error('Invalid acceptance time');
        const existing = context.existing;
        const result: RegistrationProfile = { metadata: Object.create(null) as Record<string, MetadataValue> };
        const name = input.displayName ?? existing?.displayName;
        if (name !== undefined) {
            if (typeof name !== 'string' || [...name].length > 100 || /[\x00-\x1f\x7f]/.test(name))
                throw new Error('Invalid display name');
            result.displayName = name;
        }
        const language = input.locale ?? existing?.locale;
        if (language !== undefined) {
            const normalized = locale(language);
            if (locales && !locales.includes(normalized))
                throw new Error('Profile locale is not enabled');
            result.locale = normalized;
        }
        if (input.metadata !== undefined && !object(input.metadata))
            throw new Error('Invalid metadata values');
        for (const [name, value] of Object.entries(existing?.metadata ?? {})) {
            const field = fields[name];
            if (!field || !validValue(value, field))
                throw new Error('Stored metadata does not match schema');
            result.metadata[name] = value;
        }
        for (const [name, value] of Object.entries(input.metadata ?? {})) {
            const field = fields[name];
            if (!field)
                throw new Error('Unknown metadata field');
            if (field.scope === 'private' && context.operator !== true)
                throw new Error('Private metadata requires operator authority');
            if (!validValue(value, field))
                throw new Error('Invalid metadata value');
            result.metadata[name] = value;
        }
        for (const [name, field] of Object.entries(fields)) {
            if (!Object.hasOwn(result.metadata, name) && Object.hasOwn(field, 'default'))
                result.metadata[name] = field.default!;
            if (field.required && !Object.hasOwn(result.metadata, name))
                throw new Error('Required metadata is missing');
        }
        if (JSON.stringify(result.metadata).length > 16384)
            throw new Error('Metadata exceeds total bound');
        if (input.termsAccepted !== undefined && typeof input.termsAccepted !== 'boolean')
            throw new Error('Invalid terms acceptance');
        if (existing?.terms)
            result.terms = { ...existing.terms };
        if (terms) {
            if (input.termsAccepted === true)
                result.terms = { version: terms, acceptedAt: context.now };
            else if (existing?.terms?.version !== terms)
                throw new Error('Current terms acceptance required');
        }
        return result;
    };
    return Object.freeze({ validate, publicSchema(): RegistrationOptions { return structuredClone({ ...(terms ? { termsVersion: terms } : {}), ...(locales ? { locales } : {}), metadata: Object.fromEntries(Object.entries(fields).filter(([, field]) => field.scope !== 'private')) }); }, publicProfile(profile: RegistrationProfile): RegistrationProfile {
            const result: RegistrationProfile = { metadata: Object.create(null) as Record<string, MetadataValue>, ...(profile.displayName !== undefined ? { displayName: profile.displayName } : {}), ...(profile.locale !== undefined ? { locale: profile.locale } : {}), ...(profile.terms ? { terms: { ...profile.terms } } : {}) };
            for (const [name, value] of Object.entries(profile.metadata)) {
                const field = fields[name];
                if (field && field.scope !== 'private' && validValue(value, field))
                    result.metadata[name] = value;
            }
            return result;
        } });
}
/** Quiet refusal is an HTTP integration decision; this helper never creates a fake account or session. */
export function isHoneypotFilled(value: unknown): boolean { return value !== undefined && value !== ''; }
