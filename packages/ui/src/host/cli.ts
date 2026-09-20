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
import { kitCatalogue, mergeCatalogues } from '../catalogue.ts';
import { createKit } from '../kit.ts';
import { loadProjectUi } from './loader.ts';
import { loadExtensionNamespaces, parseSpecifiers } from './namespaces.ts';
import type { Theme } from '../theme.ts';
import type { ViewModel } from '../template.ts';
const usage = `urlcode-ui list
urlcode-ui eject <template> --out DIRECTORY            copy a shipped template into a project directory (never overwrites)
urlcode-ui preview <template> [--project DIR --copy DIR --templates DIR --languages en,fr --lang fr --theme JSON]
urlcode-ui doctor --project DIR [--copy DIR --templates DIR --languages en,fr --stylesheet FILE]
urlcode-ui copy --missing LANG --project DIR --copy DIR [--languages en,fr]   print the keys a language still lacks

Every command takes --extensions PKG,PKG to add the namespaces peer extension
packages ship (--extensions @jimhoyd/urlcode-auth,@jimhoyd/urlcode-admin), so
auth/* and admin/* templates and their copy are listed, ejected, previewed and
checked as the host that registers them sees them. Each package is resolved
from --project with Node package resolution; one that is not installed there is
skipped.
`;
async function main(): Promise<void> {
    const { values, positionals } = parseArgs({ allowPositionals: true, options: { out: { type: 'string' }, project: { type: 'string' }, copy: { type: 'string' }, templates: { type: 'string' }, languages: { type: 'string' }, lang: { type: 'string' }, theme: { type: 'string' }, stylesheet: { type: 'string' }, missing: { type: 'string' }, extensions: { type: 'string' }, help: { type: 'boolean' } } });
    const command = positionals[0];
    if (values.help || !command) { process.stdout.write(usage); return; }
    const config = { ...(values.copy ? { copy: values.copy } : {}), ...(values.templates ? { templates: values.templates } : {}), ...(values.languages ? { languages: values.languages.split(',').map(s => s.trim()).filter(Boolean) } : {}), ...(values.stylesheet ? { stylesheet: values.stylesheet } : {}) };
    const directory = resolve(values.project ?? '.');
    const project = values.project ? await loadProjectUi(directory, config) : { languages: config.languages ?? ['en'], catalogues: {}, templates: {}, stylesheet: undefined };
    const theme: Theme = values.theme ? JSON.parse(values.theme) as Theme : {};
    // The peers' namespaces, registered exactly as a generated host registers them: their copy in the
    // presentation defaults, their templates under their own names. Without them the kit here is the bare
    // kit, which is not what the site renders.
    const peers = await loadExtensionNamespaces(values.extensions ? parseSpecifiers(values.extensions) : [], directory);
    for (const skipped of peers.skipped) process.stderr.write(`skipped ${skipped.specifier}: ${skipped.reason}\n`);
    const presentation = createPresentation({ defaults: mergeCatalogues([kitCatalogue, ...peers.catalogues]), catalogues: project.catalogues, ...(project.languages[0] ? { defaultLocale: project.languages[0] } : {}) });
    const kit = createKit({ presentation, theme, templates: project.templates, extensions: peers.namespaces, stylesheet: project.stylesheet });
    const shipped = (name: string): string | undefined => kitTemplates[name]?.source ?? peers.sources[name];
    const sample = (name: string): ViewModel => kitTemplates[name]?.sample ?? peers.samples[name] ?? {};
    switch (command) {
        case 'list':
            for (const name of kit.names) { const info = kit.info(name)!; process.stdout.write(`${name}\t${info.origin}\t${info.viewModel ?? '-'}\n`); }
            return;
        case 'eject': {
            const name = positionals[1];
            const source = name ? shipped(name) : undefined;
            if (!name || !values.out || source === undefined) throw new Error('eject needs a shipped template name and --out; for an extension template name its package in --extensions');
            const file = join(resolve(values.out), `${name}.html`);
            await mkdir(dirname(file), { recursive: true });
            await writeFile(file, source, { flag: 'wx' });
            process.stdout.write(`${file}\n`);
            return;
        }
        case 'preview': {
            const name = positionals[1];
            if (!name || !kit.template(name)) throw new Error('preview needs a template name');
            const context = presentation.resolve(values.lang ? { queryLocale: values.lang } : {});
            const view = sample(name);
            if (name === 'layout') { process.stdout.write(new TextDecoder().decode(kit.wrap(view.content as never, { title: String(view.title ?? 'Preview'), context }).body)); return; }
            process.stdout.write(new TextDecoder().decode(kit.page(name, view, { title: name, context }).body));
            return;
        }
        case 'doctor':
            // `extensions` names the namespaces this report covers: a report missing a peer describes a
            // different kit from the one the site renders with.
            process.stdout.write(JSON.stringify({ ...kit.report(), extensions: peers.loaded, skipped: peers.skipped }, null, 2) + '\n');
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
