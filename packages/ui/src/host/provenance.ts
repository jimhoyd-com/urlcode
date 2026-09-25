/**
 * Template namespace provenance. A `contributes.ui.templates` entry claims a namespace (`name`) and template names
 * under it; `composeHost` stamps each contribution with its contributor's registered name (`from`). ui accepts a
 * namespace only from the extension of the same name, and only templates (and view model pins) named
 * `<name>/<template>`, so one extension can never ship, replace or pin another's templates. Operator-supplied
 * `ui({extensions})` from host.mjs is the operator's own choice and is not checked here.
 */
import type { ExtensionTemplates } from '../kit.ts';

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
/** A bounded, printable rendering of a claimed name for an error message. */
const shown = (value: unknown): string => typeof value === 'string' ? JSON.stringify(value.slice(0, 80)) : 'no name';

/** Throws unless `namespace` belongs to `from`: its `name` is `from`, and every template and view model key is `from/...`. */
export function assertTemplateProvenance(namespace: unknown, from: string): ExtensionTemplates {
    if (!isRecord(namespace)) throw new Error(`Extension "${from}" contributes an invalid ui template namespace`);
    if (namespace.name !== from)
        throw new Error(`ui template namespace ${shown(namespace.name)} is contributed by extension "${from}": an extension contributes ui templates only under its own name`);
    const prefix = `${from}/`;
    for (const field of ['templates', 'viewModels'] as const) {
        const entries = namespace[field];
        if (entries === undefined) continue;
        if (!isRecord(entries)) throw new Error(`Extension "${from}" contributes invalid ui ${field}`);
        for (const key of Object.keys(entries))
            if (!key.startsWith(prefix))
                throw new Error(`ui template ${shown(key)} is contributed by extension "${from}" outside its namespace: name it ${from}/<template>`);
    }
    return namespace as unknown as ExtensionTemplates;
}
