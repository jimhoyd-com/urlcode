// Declarations for the recipe, so a TypeScript build script (or the test
// suite) can import it without a cast. The runtime is prerender.mjs.
export interface PrerenderReport { pages: number; bytes: number; output: string }
export function prerender(project: string, output: string, options?: { log?: (event: object) => void }): Promise<PrerenderReport>;
