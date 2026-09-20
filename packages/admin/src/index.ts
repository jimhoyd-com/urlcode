export { adminExtension, adminAuthoring } from './admin.ts';
export type { AdminExtensionOptions } from './admin.ts';
export { initAdministration, scaffold } from './scaffold.ts';
export type { ScaffoldRequest, ScaffoldFile, ScaffoldResult } from './scaffold.ts';
export type { AdminHealthProvider, AdminHealthSnapshot, HealthStatus } from './admin-health.ts';
export { withSupportBanner } from './support-banner.ts';
export type { SupportBannerOptions } from './support-banner.ts';
export { createAdministrationRuntime } from './admin-runtime.ts';
export type { AdministrationRuntimeOptions } from './admin-runtime.ts';

export {createAdminPresentation,adminCatalogue} from './admin-copy.ts';
export { adminTemplates, adminTemplateNames, adminUiTemplates } from './admin-templates.ts';
export type { AdminTemplate } from './admin-templates.ts';
export type { Screen, ScreenOptions, UiHost } from './admin-ui.ts';
