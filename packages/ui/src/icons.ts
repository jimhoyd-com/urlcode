// Package-owned line drawings. Never accept caller-provided SVG or path data.
const drawings = {
 'arrow-right':'<path d="M5 12h14m-6-6 6 6-6 6"/>',
 'arrow-left':'<path d="M19 12H5m6-6-6 6 6 6"/>',
 user:'<circle cx="12" cy="8" r="4"/><path d="M4 21v-2a8 8 0 0 1 16 0v2"/>',
 users:'<circle cx="9" cy="8" r="3"/><path d="M2 21v-2a7 7 0 0 1 14 0v2M16 5a3 3 0 0 1 0 6m3 4a6 6 0 0 1 3 5"/>',
 lock:'<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V6a4 4 0 0 1 8 0v4m-4 5v2"/>',
 key:'<circle cx="8" cy="8" r="5"/><path d="m12 12 9 9m-4-4 3-3m-6 0 3-3"/>',
 shield:'<path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3Z"/>',
 monitor:'<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M12 17v4m-5 0h10"/>',
 sun:'<circle cx="12" cy="12" r="4"/><path d="M12 1v2m0 18v2M1 12h2m18 0h2M4 4l1.5 1.5m13 13L20 20M4 20l1.5-1.5m13-13L20 4"/>',
 moon:'<path d="M20 15A9 9 0 0 1 9 4a9 9 0 1 0 11 11Z"/>',
 'log-out':'<path d="M9 3H4v18h5m0-9h13m-5-5 5 5-5 5"/>',
 download:'<path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5"/>',
 search:'<circle cx="10" cy="10" r="7"/><path d="m15 15 6 6"/>',
 settings:'<path d="M4 6h16M4 12h16M4 18h16"/><circle cx="8" cy="6" r="2"/><circle cx="16" cy="12" r="2"/><circle cx="10" cy="18" r="2"/>',
 activity:'<path d="M2 12h5l3-8 4 16 3-8h5"/>',
 list:'<path d="M9 5h12M9 12h12M9 19h12M3 5h1M3 12h1M3 19h1"/>',
 home:'<path d="m3 10 9-7 9 7v11h-6v-7H9v7H3V10Z"/>',
 mail:'<rect x="2" y="4" width="20" height="16" rx="2"/><path d="m3 5 9 8 9-8"/>',
 check:'<path d="m5 12 4 4L19 6"/>',
 'circle-alert':'<circle cx="12" cy="12" r="9"/><path d="M12 7v6m0 4h.01"/>',
} as const;
export type IconName = keyof typeof drawings;
/** Decorative only: callers keep a visible text label alongside every icon. */
export function icon(name: IconName): string {
 if (!Object.hasOwn(drawings,name)) throw new Error('Unknown icon');
 const directional = name === 'arrow-right' || name === 'arrow-left';
 return `<svg class="ui-icon${directional?' ui-icon-directional':''}" xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${drawings[name]}</svg>`;
}
