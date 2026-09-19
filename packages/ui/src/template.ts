/**
 * A deliberately small template language: place values, branch, loop, include
 * a partial, look up copy. No expressions, no logic, no code, no raw output.
 * Every placed value is HTML-escaped unless it is Markup the renderer itself
 * produced, so a template cannot introduce script or markup from data.
 *
 *   {{path}}                     escaped value; {{this}} inside each
 *   {{#if path}} … {{else}} … {{/if}}
 *   {{#each path}} … {{/each}}   with {{@index}} {{@first}} {{@last}}
 *   {{> partial}}                the named partial with the current scope
 *   {{t "key"}} {{t "key" count=path}}   copy from the catalogue
 *   {{href path}}                a link target, or "#" when it is not safe
 *   {{date path}} {{number path}}   locale formatting
 *   {{!-- comment --}}           the first comment may declare viewModel: name@1
 */
import { escapeHtml, isMarkup, Markup } from './escape.ts';
import type { PresentationContext } from './presentation.ts';
export type ViewValue = string | number | boolean | null | undefined | Markup | ViewValue[] | { [key: string]: ViewValue };
export type ViewModel = { [key: string]: ViewValue };
export class TemplateError extends Error {
    readonly template: string;
    constructor(template: string, message: string) { super(`${template}: ${message}`); this.template = template; }
}
type Node =
    | { kind: 'text'; text: string }
    | { kind: 'value'; path: string; helper?: 'href' | 'date' | 'number' }
    | { kind: 'copy'; key: string; args: [string, string][] }
    | { kind: 'partial'; name: string }
    | { kind: 'if'; path: string; then: Node[]; otherwise: Node[] }
    | { kind: 'each'; path: string; body: Node[] };
export interface CompiledTemplate {
    readonly name: string;
    readonly viewModel: string | undefined;
    readonly partials: readonly string[];
    readonly copyKeys: readonly string[];
    render(view: ViewModel, context: PresentationContext, partials: PartialResolver, depth?: number): Markup;
}
export type PartialResolver = (name: string) => CompiledTemplate | undefined;
const namePattern = /^[a-z][a-z0-9-]*(?:\/[a-z][a-z0-9-]*)*$/;
const pathPattern = /^(?:this|\.|@index|@first|@last|[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)$/;
const keyPattern = /^"([a-z][a-zA-Z0-9]*(?:\.[a-zA-Z][a-zA-Z0-9]*)+)"$/;
const limits = { source: 262144, output: 1048576, depth: 16, iterations: 10000 };
export function compileTemplate(name: string, source: string): CompiledTemplate {
    if (typeof name !== 'string' || !namePattern.test(name) || name.length > 128)
        throw new TemplateError(String(name).slice(0, 64), 'invalid template name');
    if (typeof source !== 'string' || source.length > limits.source)
        throw new TemplateError(name, 'template source missing or too large');
    if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(source))
        throw new TemplateError(name, 'template contains control characters');
    let viewModel: string | undefined;
    const partials = new Set<string>(), copyKeys = new Set<string>();
    const root: Node[] = [];
    const stack: { node: Node[]; kind: 'if' | 'each'; owner: Extract<Node, { kind: 'if' | 'each' }> }[] = [];
    let current = root, last = 0;
    const fail = (message: string): never => { throw new TemplateError(name, message); };
    for (const match of source.matchAll(/\{\{(!--[\s\S]*?--|![^}]*|[^{}]*)\}\}/g)) {
        const text = source.slice(last, match.index);
        if (text)
            current.push({ kind: 'text', text });
        last = match.index + match[0].length;
        const raw = match[1]!;
        if (raw.startsWith('!')) {
            const comment = raw.startsWith('!--') ? raw.slice(3, -2) : raw.slice(1);
            const declared = /viewModel:\s*([a-z][a-z0-9-]*(?:\/[a-z][a-z0-9-]*)*@[0-9]{1,4})/.exec(comment);
            if (declared && viewModel === undefined)
                viewModel = declared[1]!;
            continue;
        }
        const expression = raw.trim();
        if (!expression || expression.length > 256)
            fail('empty or oversized expression');
        if (expression.startsWith('#if ')) {
            const path = expression.slice(4).trim();
            if (!pathPattern.test(path)) fail(`invalid path in #if: ${path.slice(0, 32)}`);
            const node: Node = { kind: 'if', path, then: [], otherwise: [] };
            current.push(node); stack.push({ node: current, kind: 'if', owner: node }); current = node.then;
            if (stack.length > limits.depth) fail('nesting too deep');
        }
        else if (expression === 'else') {
            const top = stack[stack.length - 1];
            if (!top || top.kind !== 'if' || current === (top.owner as Extract<Node, { kind: 'if' }>).otherwise) fail('else outside #if');
            current = (top!.owner as Extract<Node, { kind: 'if' }>).otherwise;
        }
        else if (expression === '/if') {
            const top = stack.pop();
            if (!top || top.kind !== 'if') fail('/if without #if');
            current = top!.node;
        }
        else if (expression.startsWith('#each ')) {
            const path = expression.slice(6).trim();
            if (!pathPattern.test(path)) fail(`invalid path in #each: ${path.slice(0, 32)}`);
            const node: Node = { kind: 'each', path, body: [] };
            current.push(node); stack.push({ node: current, kind: 'each', owner: node }); current = node.body;
            if (stack.length > limits.depth) fail('nesting too deep');
        }
        else if (expression === '/each') {
            const top = stack.pop();
            if (!top || top.kind !== 'each') fail('/each without #each');
            current = top!.node;
        }
        else if (expression.startsWith('>')) {
            const partial = expression.slice(1).trim();
            if (!namePattern.test(partial)) fail(`invalid partial name: ${partial.slice(0, 32)}`);
            partials.add(partial); current.push({ kind: 'partial', name: partial });
        }
        else if (expression.startsWith('t ')) {
            const parts = expression.slice(2).trim().split(/\s+/);
            const key = keyPattern.exec(parts[0] ?? '')?.[1];
            if (!key) fail('copy key must be a quoted catalogue key');
            const args: [string, string][] = [];
            for (const part of parts.slice(1)) {
                const arg = /^([a-zA-Z][a-zA-Z0-9_]{0,31})=([A-Za-z_][A-Za-z0-9_.]*|this|\.|@index)$/.exec(part);
                if (!arg) fail(`invalid copy argument: ${part.slice(0, 32)}`);
                args.push([arg![1]!, arg![2]!]);
            }
            copyKeys.add(key!); current.push({ kind: 'copy', key: key!, args });
        }
        else if (/^(href|date|number) /.test(expression)) {
            const [helper, path] = expression.split(/\s+/, 2) as ['href' | 'date' | 'number', string];
            if (!path || !pathPattern.test(path)) fail(`invalid path in ${helper}`);
            current.push({ kind: 'value', path, helper });
        }
        else if (pathPattern.test(expression))
            current.push({ kind: 'value', path: expression });
        else
            fail(`unsupported expression: ${expression.slice(0, 32)}`);
    }
    if (stack.length) fail(`unclosed #${stack[stack.length - 1]!.kind}`);
    const tail = source.slice(last);
    if (tail) root.push({ kind: 'text', text: tail });
    const compiled: CompiledTemplate = {
        name, viewModel, partials: Object.freeze([...partials]), copyKeys: Object.freeze([...copyKeys]),
        render(view: ViewModel, context: PresentationContext, resolve: PartialResolver, depth = 0): Markup {
            if (depth > limits.depth) throw new TemplateError(name, 'partials nested too deep');
            const out: string[] = [];
            let size = 0;
            const emit = (text: string) => { size += text.length; if (size > limits.output) throw new TemplateError(name, 'output exceeds limit'); out.push(text); };
            renderNodes(name, root, [{ value: view }], { context, resolve, emit, depth, iterations: 0 });
            return new Markup(out.join(''));
        },
    };
    return Object.freeze(compiled);
}
interface Scope { value: ViewValue; index?: number; first?: boolean; last?: boolean }
interface RenderState { context: PresentationContext; resolve: PartialResolver; emit: (text: string) => void; depth: number; iterations: number }
function lookup(template: string, path: string, frames: Scope[]): ViewValue {
    const top = frames[frames.length - 1]!;
    if (path === 'this' || path === '.') return top.value;
    if (path === '@index') return top.index ?? null;
    if (path === '@first') return top.first ?? false;
    if (path === '@last') return top.last ?? false;
    const segments = path.split('.');
    for (let i = frames.length - 1; i >= 0; i--) {
        let value: ViewValue = frames[i]!.value;
        if (!value || typeof value !== 'object' || isMarkup(value) || Array.isArray(value) || !Object.hasOwn(value, segments[0]!))
            continue;
        for (const segment of segments) {
            if (!value || typeof value !== 'object' || isMarkup(value) || Array.isArray(value) || !Object.hasOwn(value, segment))
                throw new TemplateError(template, `missing view value: ${path}`);
            value = (value as { [key: string]: ViewValue })[segment];
        }
        return value;
    }
    throw new TemplateError(template, `missing view value: ${path}`);
}
const truthy = (value: ViewValue): boolean => Array.isArray(value) ? value.length > 0 : isMarkup(value) ? value.html.length > 0 : typeof value === 'object' && value !== null ? true : Boolean(value);
export function safeHref(value: unknown): string {
    if (typeof value !== 'string' || value.length > 2048 || /[\x00-\x20\x7f"'<>\\]/.test(value))
        return '#';
    if (/^(?:\/(?!\/)|#|\?)/.test(value))
        return value;
    if (/^https?:\/\/[^/?#]+/i.test(value))
        return value;
    return '#';
}
function renderNodes(template: string, nodes: Node[], scopes: Scope[], state: RenderState): void {
    for (const node of nodes) {
        switch (node.kind) {
            case 'text': state.emit(node.text); break;
            case 'value': {
                const value = lookup(template, node.path, scopes);
                if (node.helper === 'href') { state.emit(escapeHtml(safeHref(value))); break; }
                if (node.helper === 'date') {
                    if (typeof value !== 'string' && typeof value !== 'number') throw new TemplateError(template, `date needs a string or number: ${node.path}`);
                    state.emit(escapeHtml(state.context.formatDate(value))); break;
                }
                if (node.helper === 'number') {
                    if (typeof value !== 'number') throw new TemplateError(template, `number needs a number: ${node.path}`);
                    state.emit(escapeHtml(state.context.formatNumber(value))); break;
                }
                if (value === undefined) throw new TemplateError(template, `undefined view value: ${node.path}`);
                if (value === null || value === false) break;
                if (isMarkup(value)) { state.emit(value.html); break; }
                if (typeof value === 'object') throw new TemplateError(template, `object placed as text: ${node.path}`);
                state.emit(escapeHtml(value === true ? '' : value));
                break;
            }
            case 'copy': {
                const values: Record<string, string | number> = {};
                for (const [argument, path] of node.args) {
                    const value = lookup(template, path, scopes);
                    if (typeof value !== 'string' && typeof value !== 'number') throw new TemplateError(template, `copy argument ${argument} must be text or a number`);
                    values[argument] = value;
                }
                state.emit(escapeHtml(state.context.text(node.key, values)));
                break;
            }
            case 'partial': {
                if (state.depth >= limits.depth) throw new TemplateError(template, 'partials nested too deep');
                const partial = state.resolve(node.name);
                if (!partial) throw new TemplateError(template, `unknown partial: ${node.name}`);
                const top = scopes[scopes.length - 1]!.value;
                if (!top || typeof top !== 'object' || Array.isArray(top) || isMarkup(top)) throw new TemplateError(template, `partial ${node.name} needs an object scope`);
                state.emit(partial.render(top as ViewModel, state.context, state.resolve, state.depth + 1).html);
                break;
            }
            case 'if': renderNodes(template, truthy(lookup(template, node.path, scopes)) ? node.then : node.otherwise, scopes, state); break;
            case 'each': {
                const list = lookup(template, node.path, scopes);
                if (!Array.isArray(list)) throw new TemplateError(template, `each needs a list: ${node.path}`);
                list.forEach((item, index) => {
                    if (++state.iterations > limits.iterations) throw new TemplateError(template, 'too many iterations');
                    renderNodes(template, node.body, [...scopes, { value: item, index, first: index === 0, last: index === list.length - 1 }], state);
                });
                break;
            }
        }
    }
}
