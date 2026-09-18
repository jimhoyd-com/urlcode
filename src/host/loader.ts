/**
 * Node-only: reads a project's copy catalogues, templates and stylesheet from
 * directories the project's `ui` block names. Paths must resolve inside the
 * project root after symlink resolution; sizes and counts are bounded; the
 * project cannot make the kit read anything else.
 */
import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import type { Catalogue } from '../presentation.ts';
const limits = { files: 256, templateBytes: 262144, catalogueBytes: 262144, stylesheetBytes: 524288 };
export interface ProjectUi {
    languages: string[];
    catalogues: Record<string, Catalogue>;
    templates: Record<string, string>;
    stylesheet: { append?: string; replace?: string } | undefined;
}
export interface UiConfig {
    languages?: string[] | undefined;
    copy?: string | undefined;
    templates?: string | undefined;
    stylesheet?: string | { file: string; replace?: boolean } | undefined;
    theme?: Record<string, unknown> | undefined;
}
function relativePath(value: string, what: string): string {
    if (typeof value !== 'string' || !value || value.length > 256 || value.startsWith('/') || value.includes('\\') || value.includes('\0') || value.split('/').some(part => part === '' || part === '.' || part === '..'))
        throw new Error(`ui ${what} must be a relative path inside the project`);
    return value;
}
async function inside(root: string, path: string): Promise<string> {
    const real = await realpath(resolve(root, path));
    const rootReal = await realpath(root);
    const rel = relative(rootReal, real);
    if (rel.startsWith('..') || rel.split(sep).includes('..') || resolve(rootReal, rel) !== real)
        throw new Error('ui paths must stay inside the project');
    return real;
}
async function readBounded(path: string, max: number): Promise<string> {
    const info = await stat(path);
    if (!info.isFile() || info.size > max)
        throw new Error(`ui file missing or larger than ${max} bytes: ${relative(process.cwd(), path)}`);
    return readFile(path, 'utf8');
}
async function walk(dir: string, base: string, out: string[]): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
        if (entry.isSymbolicLink()) continue;
        const path = join(dir, entry.name);
        if (entry.isDirectory()) await walk(path, base, out);
        else if (entry.isFile()) out.push(relative(base, path).split(sep).join('/'));
        if (out.length > limits.files) throw new Error('ui directory has too many files');
    }
}
/** Loads what the config names. Languages beyond English need `<copy>/<locale>.json`; templates are `<name>.html`. */
export async function loadProjectUi(projectRoot: string, config: UiConfig): Promise<ProjectUi> {
    const root = await realpath(projectRoot);
    const languages = config.languages ?? ['en'];
    if (!Array.isArray(languages) || languages.length === 0 || languages.length > 32 || languages.some(language => typeof language !== 'string' || !/^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/.test(language)))
        throw new Error('ui languages must be a list of language tags');
    const catalogues: Record<string, Catalogue> = {};
    if (config.copy !== undefined) {
        const dir = await inside(root, relativePath(config.copy, 'copy'));
        for (const language of languages) {
            const file = join(dir, `${language}.json`);
            let source: string;
            try { source = await readBounded(file, limits.catalogueBytes); }
            catch (error) { if (language === 'en') continue; throw error; }
            const parsed: unknown = JSON.parse(source);
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`ui catalogue ${language}.json must be an object`);
            catalogues[language] = parsed as Catalogue;
        }
    }
    else if (languages.some(language => language !== 'en'))
        throw new Error('ui languages beyond en need a copy directory');
    const templates: Record<string, string> = {};
    if (config.templates !== undefined) {
        const dir = await inside(root, relativePath(config.templates, 'templates'));
        const files: string[] = [];
        await walk(dir, dir, files);
        for (const file of files.sort()) {
            if (!file.endsWith('.html')) continue;
            const name = file.slice(0, -5);
            if (!/^[a-z][a-z0-9-]*(?:\/[a-z][a-z0-9-]*)*$/.test(name)) throw new Error(`ui template file name is not a template name: ${file}`);
            templates[name] = await readBounded(join(dir, file), limits.templateBytes);
        }
    }
    let stylesheet: ProjectUi['stylesheet'];
    if (config.stylesheet !== undefined) {
        const spec = typeof config.stylesheet === 'string' ? { file: config.stylesheet, replace: false } : config.stylesheet;
        const file = await inside(root, relativePath(spec.file, 'stylesheet'));
        const css = await readBounded(file, limits.stylesheetBytes);
        if (/<\/?script|javascript:|expression\(|@import/i.test(css)) throw new Error('ui stylesheet contains disallowed content');
        stylesheet = spec.replace ? { replace: css } : { append: css };
    }
    return { languages, catalogues, templates, stylesheet };
}
