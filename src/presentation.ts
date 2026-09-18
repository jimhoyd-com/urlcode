/** Plain-text catalogues and constrained theme values. Renderers must HTML-escape text(). */
export type PluralMessage = Partial<Record<Intl.LDMLPluralRule, string>> & {
    other: string;
};
export type Catalogue = Record<string, string | PluralMessage>;
export const baseCatalogue: Readonly<Catalogue> = Object.freeze({'nav.skip':'Skip to content','action.next':'Next page','action.previous':'Previous page','message.empty':'Nothing to show','theme.label':'Appearance','theme.system':'System','theme.light':'Light','theme.dark':'Dark','theme.toggleLight':'Switch to light mode','theme.toggleDark':'Switch to dark mode'});
export interface ThemeVariables {
    '--ui-background'?: string;
    '--ui-foreground'?: string;
    '--ui-accent'?: string;
    '--ui-border'?: string;
    '--ui-radius'?: string;
}
export interface PresentationOptions {
    defaults?: Catalogue;
    catalogues?: Record<string, Catalogue>;
    defaultLocale?: string;
    theme?: ThemeVariables;
    logo?: string;
    favicon?: string;
}
export interface LocalePreferences {
    accountLocale?: string;
    queryLocale?: string;
    acceptLanguage?: string;
}
export interface PresentationContext {
    readonly locale: string;
    readonly lang: string;
    readonly dir: 'ltr' | 'rtl';
    readonly cssVariables: string;
    readonly logo?: string;
    readonly favicon?: string;
    /** Whether a key exists in the effective catalogue. */
    has(key: string): boolean;
    formatDate(value: Date | string | number, style?: 'date' | 'time' | 'datetime'): string;
    formatNumber(value: number): string;
    textSource(sourceEnglish: string): string;
    text(key: string, values?: Readonly<Record<string, string | number>>): string;
}
export interface Presentation {
    readonly locales: readonly string[];
    readonly defaultLocale: string;
    /** The effective English catalogue: base, defaults and registered sources. */
    readonly english: Readonly<Catalogue>;
    resolve(preferences?: LocalePreferences): PresentationContext;
    /** Keys a language lacks, and keys whose placeholders differ from English. */
    coverage(locale: string): { missing: string[]; mismatched: string[] };
}
const pluralKeys = new Set(['zero', 'one', 'two', 'few', 'many', 'other']);
function canonical(value: string): string {
    if (typeof value !== 'string' || value.length > 64 || !/^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/.test(value))
        throw new Error('Invalid catalogue locale');
    try {
        return Intl.getCanonicalLocales(value)[0]!;
    }
    catch {
        throw new Error('Invalid catalogue locale');
    }
}
function asset(value: string | undefined): string | undefined {
    if (value === undefined)
        return;
    // No query, fragment, scheme, escaped separator, traversal, HTML or CSS syntax.
    if (typeof value !== 'string' || value.length > 512 || !/^\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_.-]+)*$/.test(value) || value.split('/').some(part => part === '.' || part === '..'))
        throw new Error('Presentation assets require a safe local path');
    return value;
}
function themeCss(theme: ThemeVariables = {}): string {
    if (!theme || typeof theme !== 'object' || Array.isArray(theme) || Object.keys(theme).length > 5)
        throw new Error('Invalid presentation theme');
    return Object.entries(theme).map(([name, value]) => {
        if (typeof value !== 'string')
            throw new Error('Invalid theme value');
        if (name === '--ui-radius') {
            if (!/^(?:0|(?:[0-9]|[12][0-9]|3[0-2])px)$/.test(value))
                throw new Error('Invalid theme radius');
        }
        else if (!['--ui-background', '--ui-foreground', '--ui-accent', '--ui-border'].includes(name) || !/^#[0-9a-fA-F]{6}$/.test(value))
            throw new Error('Theme colors must be six-digit hex');
        return `${name}:${value}`;
    }).sort().join(';');
}
function copyCatalogue(input: Catalogue): Catalogue {
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length > 512)
        throw new Error('Catalogue exceeds key limit');
    const output: Catalogue = Object.create(null) as Catalogue;
    let bytes = 0;
    const message = (value: unknown): string => {
        if (typeof value !== 'string' || value.length > 2048 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value))
            throw new Error('Invalid catalogue message');
        bytes += new TextEncoder().encode(value).length;
        if (bytes > 65536)
            throw new Error('Catalogue exceeds byte limit');
        for (const match of value.matchAll(/\{([^{}]*)\}/g))
            if (!/^[a-zA-Z][a-zA-Z0-9_]{0,31}$/.test(match[1]!))
                throw new Error('Invalid catalogue placeholder');
        return value;
    };
    for (const [key, value] of Object.entries(input)) {
        if (!/^[a-z][a-zA-Z0-9]*(?:\.[a-zA-Z][a-zA-Z0-9]*)+$/.test(key) || key.length > 128)
            throw new Error('Invalid catalogue key');
        if (typeof value === 'string')
            output[key] = message(value);
        else {
            if (!value || typeof value !== 'object' || Array.isArray(value) || !Object.hasOwn(value, 'other') || Object.keys(value).some(form => !pluralKeys.has(form)))
                throw new Error('Plural catalogue requires valid categories and other');
            const forms: Record<string, string> = Object.create(null) as Record<string, string>;
            for (const [form, text] of Object.entries(value))
                forms[form] = message(text);
            output[key] = Object.freeze(forms) as PluralMessage;
        }
    }
    return Object.freeze(output);
}
const rtlLanguages = new Set(['ar', 'arc', 'dv', 'fa', 'he', 'ks', 'ku', 'nqo', 'ps', 'sd', 'syr', 'ug', 'ur', 'yi']);
const rtlScripts = new Set(['Arab', 'Hebr', 'Thaa', 'Nkoo', 'Adlm', 'Rohg', 'Syrc']);
export function createPresentation(options: PresentationOptions = {}): Presentation {
    const englishCatalogue = copyCatalogue({...baseCatalogue,...options.defaults});
    const englishKeys = new Map(Object.entries(englishCatalogue).filter((entry): entry is [
    string,
    string
] => typeof entry[1] === 'string').map(([key, value]) => [value, key]));

    const catalogues = new Map<string, Catalogue>([['en', copyCatalogue(englishCatalogue)]]);
    if (options.catalogues && (!options.catalogues || typeof options.catalogues !== 'object' || Array.isArray(options.catalogues) || Object.keys(options.catalogues).length > 16))
        throw new Error('Too many catalogues');
    const supplied = new Set<string>(), translations = new Map<string, Catalogue>();
    for (const [requested, input] of Object.entries(options.catalogues ?? {})) {
        const locale = canonical(requested);
        if (supplied.has(locale))
            throw new Error('Duplicate catalogue locale');
        supplied.add(locale);
        const translation = copyCatalogue(input);
        translations.set(locale, translation);
        catalogues.set(locale, copyCatalogue({ ...englishCatalogue, ...translation }));
    }
    const slots = (entry: string | PluralMessage): string => [...new Set((typeof entry === 'string' ? [entry] : Object.values(entry)).flatMap(text => [...text.matchAll(/\{([a-zA-Z][a-zA-Z0-9_]{0,31})\}/g)].map(match => match[1]!)))].sort().join(',');
    const defaultLocale = canonical(options.defaultLocale ?? 'en');
    if (!catalogues.has(defaultLocale))
        throw new Error('Default locale has no catalogue');
    const cssVariables = themeCss(options.theme), logo = asset(options.logo), favicon = asset(options.favicon), locales = Object.freeze([...catalogues.keys()]);
    function match(value: string | undefined): string | undefined {
        if (!value)
            return;
        let requested: string;
        try {
            requested = canonical(value);
        }
        catch {
            return;
        }
        while (requested) {
            if (catalogues.has(requested))
                return requested;
            const index = requested.lastIndexOf('-');
            if (index < 0)
                break;
            requested = requested.slice(0, index);
        }
        const language = new Intl.Locale(value).language;
        return locales.find(locale => new Intl.Locale(locale).language === language);
    }
    return Object.freeze({ locales, defaultLocale, english: englishCatalogue, coverage(locale: string) {
            const translation = translations.get(canonical(locale));
            if (!translation)
                return { missing: Object.keys(englishCatalogue).sort(), mismatched: [] };
            const missing: string[] = [], mismatched: string[] = [];
            for (const key of Object.keys(englishCatalogue)) {
                if (!Object.hasOwn(translation, key)) missing.push(key);
                else if (slots(englishCatalogue[key]!) !== slots(translation[key]!)) mismatched.push(key);
            }
            return { missing: missing.sort(), mismatched: mismatched.sort() };
        }, resolve(preferences: LocalePreferences = {}): PresentationContext {
            let locale = match(preferences.accountLocale) || match(preferences.queryLocale);
            if (!locale && typeof preferences.acceptLanguage === 'string' && preferences.acceptLanguage.length <= 2048) {
                const ranges = preferences.acceptLanguage.split(',').slice(0, 32).map((part, index) => { const parsed = /^\s*([A-Za-z0-9-]+|\*)\s*(?:;\s*q=(0(?:\.\d{0,3})?|1(?:\.0{0,3})?))?\s*$/.exec(part); return parsed ? { value: parsed[1]!, quality: Number(parsed[2] ?? 1), index } : undefined; }).filter((range): range is {
                    value: string;
                    quality: number;
                    index: number;
                } => Boolean(range && range.quality > 0)).sort((a, b) => b.quality - a.quality || a.index - b.index);
                for (const range of ranges) {
                    locale = range.value === '*' ? defaultLocale : match(range.value);
                    if (locale)
                        break;
                }
            }
            locale ??= defaultLocale;
            const selected = locale, info = new Intl.Locale(selected).maximize(), dir: 'rtl' | 'ltr' = info.script ? rtlScripts.has(info.script) ? 'rtl' : 'ltr' : rtlLanguages.has(info.language) ? 'rtl' : 'ltr', plural = new Intl.PluralRules(selected), numbers = new Intl.NumberFormat(selected), catalogue = catalogues.get(selected)!;
            const formats = { date: new Intl.DateTimeFormat(selected, { dateStyle: 'medium', timeZone: 'UTC' }), time: new Intl.DateTimeFormat(selected, { timeStyle: 'short', timeZone: 'UTC' }), datetime: new Intl.DateTimeFormat(selected, { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }) };
            return Object.freeze({ locale: selected, lang: selected, dir, cssVariables, ...(logo ? { logo } : {}), ...(favicon ? { favicon } : {}),
                has: (key: string): boolean => typeof key === 'string' && Object.hasOwn(catalogue, key),
                formatDate(value: Date | string | number, style: 'date' | 'time' | 'datetime' = 'datetime'): string {
                    const date = value instanceof Date ? value : new Date(value);
                    if (Number.isNaN(date.getTime()))
                        throw new Error('Invalid date');
                    return formats[style].format(date);
                },
                formatNumber(value: number): string {
                    if (typeof value !== 'number' || !Number.isFinite(value))
                        throw new Error('Invalid number');
                    return numbers.format(value);
                },
                textSource(sourceEnglish: string): string {
                    if (typeof sourceEnglish !== 'string' || sourceEnglish.length > 2048)
                        throw new Error('Invalid source text');
                    const key = englishKeys.get(sourceEnglish);
                    return key ? this.text(key) : sourceEnglish;
                }, text(key: string, values: Readonly<Record<string, string | number>> = {}): string {
                    if (!Object.hasOwn(catalogue, key))
                        throw new Error('Unknown catalogue key');
                    if (!values || typeof values !== 'object' || Array.isArray(values) || Object.keys(values).length > 16)
                        throw new Error('Too many catalogue values');
                    for (const [name, value] of Object.entries(values))
                        if (!/^[a-zA-Z][a-zA-Z0-9_]{0,31}$/.test(name) || !(typeof value === 'string' && value.length <= 1024 || typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 1e12))
                            throw new Error('Invalid catalogue value');
                    const entry = catalogue[key]!;
                    let template: string;
                    if (typeof entry === 'string')
                        template = entry;
                    else {
                        if (typeof values.count !== 'number')
                            throw new Error('Plural message requires a numeric count');
                        template = entry[plural.select(values.count)] ?? entry.other;
                    }
                    const output = template.replace(/\{([a-zA-Z][a-zA-Z0-9_]{0,31})\}/g, (_whole, name: string) => {
                        if (!Object.hasOwn(values, name))
                            throw new Error('Missing catalogue value');
                        const value = values[name]!;
                        return typeof value === 'number' ? numbers.format(value) : value;
                    });
                    if (output.length > 8192)
                        throw new Error('Catalogue output exceeds limit');
                    return output;
                } });
        } });
}
