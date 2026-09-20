/**
 * A deliberately small DOM for running the shipped client scripts under node:test:
 * only what `crud-script.ts` uses (createElement, attributes, listeners, text and
 * form values, focus). It is not a general DOM; a script that reaches for anything
 * else fails loudly here instead of passing by accident.
 */
export type Listener = (event: { type: string; preventDefault(): void }) => void;
export class FakeElement {
    readonly tagName: string;
    className = '';
    value = '';
    checked = false;
    disabled = false;
    hidden = false;
    type = '';
    selectionStart: number | null = null;
    selectionEnd: number | null = null;
    children: FakeElement[] = [];
    private own = '';
    private readonly attributes = new Map<string, string>();
    private readonly listeners = new Map<string, Listener[]>();
    readonly owner: FakeDocument;
    constructor(owner: FakeDocument, tagName: string) { this.owner = owner; this.tagName = tagName.toUpperCase(); }
    get textContent(): string { return this.own + this.children.map(child => child.textContent).join(''); }
    set textContent(value: string) { this.children = []; this.own = String(value); }
    setAttribute(name: string, value: string): void { this.attributes.set(name, String(value)); if (name === 'hidden') this.hidden = true; }
    getAttribute(name: string): string | null { return this.attributes.get(name) ?? null; }
    appendChild(child: FakeElement): FakeElement { this.children.push(child); return child; }
    replaceChildren(...nodes: FakeElement[]): void { this.children = [...nodes]; this.own = ''; }
    addEventListener(type: string, listener: Listener): void { this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]); }
    focus(): void { this.owner.activeElement = this; }
    setSelectionRange(start: number, end: number): void { this.selectionStart = start; this.selectionEnd = end; }
    dispatch(type: string): { defaultPrevented: boolean } {
        let defaultPrevented = false;
        for (const listener of this.listeners.get(type) ?? []) listener({ type, preventDefault() { defaultPrevented = true; } });
        return { defaultPrevented };
    }
    /** Test helper: every descendant (and this element) matching the predicate, in document order. */
    findAll(predicate: (element: FakeElement) => boolean): FakeElement[] {
        return [...(predicate(this) ? [this] : []), ...this.children.flatMap(child => child.findAll(predicate))];
    }
    find(predicate: (element: FakeElement) => boolean): FakeElement {
        const found = this.findAll(predicate)[0];
        if (!found) throw new Error('no matching element');
        return found;
    }
    button(label: string): FakeElement { return this.find(element => element.tagName === 'BUTTON' && element.textContent === label); }
    keyed(key: string): FakeElement { return this.find(element => element.getAttribute('data-ui-key') === key); }
}
export class FakeDocument {
    activeElement: FakeElement | null = null;
    readonly roots: FakeElement[] = [];
    createElement(tag: string): FakeElement { return new FakeElement(this, tag); }
    querySelectorAll(selector: string): FakeElement[] {
        if (selector !== '[data-ui-crud]') throw new Error(`fake DOM does not support ${selector}`);
        return this.roots;
    }
}
export interface FetchCall { method: string; url: string; body: unknown }
/** A queue of canned answers; each call is recorded. A function answer may return a promise to hold a request in flight. */
export function fakeFetch(answers: (Response | ((call: FetchCall) => Response | Promise<Response>))[]): { fetch: typeof fetch; calls: FetchCall[] } {
    const calls: FetchCall[] = [];
    const fetcher = (async (input: string, init?: RequestInit) => {
        const call = { method: init?.method ?? 'GET', url: String(input), body: init?.body === undefined ? undefined : JSON.parse(String(init.body)) as unknown };
        calls.push(call);
        const next = answers.shift();
        if (!next) throw new Error(`unexpected request ${call.method} ${call.url}`);
        return typeof next === 'function' ? next(call) : next;
    }) as unknown as typeof fetch;
    return { fetch: fetcher, calls };
}
export const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
export const settle = async (): Promise<void> => { for (let turn = 0; turn < 8; turn++) await new Promise<void>(resolve => setImmediate(resolve)); };
