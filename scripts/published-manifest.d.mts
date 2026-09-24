export declare const unpublishedScripts: readonly string[];
export declare function publishedManifest(text: string): string;
export declare function withPublishedManifest<T>(directory: string, pack: () => T | Promise<T>): Promise<T>;
