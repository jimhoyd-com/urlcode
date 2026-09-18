#!/usr/bin/env node
/**
 * urlcode-ui: list, eject, preview, doctor and copy commands for a project's
 * presentation. Reads only what it is pointed at; writes only new files.
 */
import { parseArgs } from 'node:util';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { kitTemplates } from '../partials.ts';
import { createPresentation } from '../presentation.ts';
import { kitCatalogue } from '../catalogue.ts';
import { createKit } from '../kit.ts';
import { loadProjectUi } from './loader.ts';
import type { Theme } from '../theme.ts';
const usage = `urlcode-ui list
urlcode-ui eject <template> --out DIRECTORY            copy a shipped template into a project directory (never overwrites)
urlcode-ui preview <template> [--project DIR --copy DIR --templates DIR --languages en,fr --lang fr --theme JSON]
urlcode-ui doctor --project DIR [--copy DIR --templates DIR --languages en,fr --stylesheet FILE]
urlcode-ui copy --missing LANG --project DIR --copy DIR [--languages en,fr]   print the keys a language still lacks
`;
async function main(): Promise<void> {
    const { values, positionals } = parseArgs({ allowPositionals: true, options: { out: { type: 'string' }, project: { type: 'string' }, copy: { type: 'string' }, templates: { type: 'string' }, languages: { type: 'string' }, lang: { type: 'string' }, theme: { type: 'string' }, stylesheet: { type: 'string' }, missing: { type: 'string' }, help: { type: 'boolean' } } });
    const command = positionals[0];
    if (values.help || !command) { process.stdout.write(usage); return; }
    const config = { ...(values.copy ? { copy: values.copy } : {}), ...(values.templates ? { templates: values.templates } : {}), ...(values.languages ? { languages: values.languages.split(',').map(s => s.trim()).filter(Boolean) } : {}), ...(values.stylesheet ? { stylesheet: values.stylesheet } : {}) };
    const project = values.project ? await loadProjectUi(resolve(values.project), config) : { languages: config.languages ?? ['en'], catalogues: {}, templates: {}, stylesheet: undefined };
    const theme: Theme = values.theme ? JSON.parse(values.theme) as Theme : {};
    const presentation = createPresentation({ defaults: kitCatalogue, catalogues: project.catalogues, ...(project.languages[0] ? { defaultLocale: project.languages[0] } : {}) });
    const kit = createKit({ presentation, theme, templates: project.templates, stylesheet: project.stylesheet });
    switch (command) {
        case 'list':
            for (const name of kit.names) { const info = kit.info(name)!; process.stdout.write(`${name}\t${info.origin}\t${info.viewModel ?? '-'}\n`); }
            return;
        case 'eject': {
            const name = positionals[1];
            if (!name || !values.out || !Object.hasOwn(kitTemplates, name)) throw new Error('eject needs a shipped template name and --out');
            const file = join(resolve(values.out), `${name}.html`);
            await mkdir(dirname(file), { recursive: true });
            await writeFile(file, kitTemplates[name]!.source, { flag: 'wx' });
            process.stdout.write(`${file}\n`);
            return;
        }
        case 'preview': {
            const name = positionals[1];
            if (!name || !kit.template(name)) throw new Error('preview needs a template name');
            const context = presentation.resolve(values.lang ? { queryLocale: values.lang } : {});
            const sample = kitTemplates[name]?.sample ?? {};
            if (name === 'layout') { process.stdout.write(new TextDecoder().decode(kit.wrap(sample.content as never, { title: String(sample.title ?? 'Preview'), context }).body)); return; }
            process.stdout.write(new TextDecoder().decode(kit.page(name, sample, { title: name, context }).body));
            return;
        }
        case 'doctor':
            process.stdout.write(JSON.stringify(kit.report(), null, 2) + '\n');
            return;
        case 'copy': {
            if (!values.missing) throw new Error('copy needs --missing LANG');
            const coverage = presentation.coverage(values.missing);
            const skeleton = Object.fromEntries(coverage.missing.map(key => [key, presentation.english[key]]));
            process.stdout.write(JSON.stringify({ locale: values.missing, missing: coverage.missing.length, mismatched: coverage.mismatched, skeleton }, null, 2) + '\n');
            return;
        }
        default: throw new Error('Unknown command');
    }
}
try { await main(); }
catch (error) { process.stderr.write(`${error instanceof Error ? error.message : 'urlcode-ui failed'}\n${usage}`); process.exitCode = 1; }
