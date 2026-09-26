// npm 10's pack still invokes prepare with --ignore-scripts. Honor that flag
// here so packing a built checkout never deletes dist/ under concurrent tests.
// Explicit `npm run build` continues to rebuild regardless of this setting.
if (process.env.npm_config_ignore_scripts !== 'true') await import('./build.ts');
