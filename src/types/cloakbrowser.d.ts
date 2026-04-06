// Only chromium is used by this project. Add other exports as needed.
/**
 * Ambient type declaration for the cloakbrowser BYO package.
 * cloakbrowser is not bundled — users install it themselves.
 * This stub allows the dynamic import() in engine.ts to compile.
 */
declare module 'cloakbrowser' {
  import type { BrowserType } from 'playwright';
  export const chromium: BrowserType;
}
