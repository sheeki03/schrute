/**
 * Native module dynamic loader.
 *
 * Attempts to load the compiled Rust napi-rs binary.
 * If unavailable (not compiled, wrong platform, etc.), returns null.
 * All individual binding modules use this to determine whether to
 * invoke the native path or fall back to pure TypeScript.
 */

import { createRequire } from 'node:module';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let nativeModule: Record<string, (...args: any[]) => any> | null = null;
let loadAttempted = false;

export function getNativeModule(): typeof nativeModule {
  if (loadAttempted) return nativeModule;
  loadAttempted = true;

  try {
    const require = createRequire(import.meta.url);
    // napi-rs produces index.node in the native/ build dir
    const candidates = [
      join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'native', 'index.node'),
      join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'native', 'oneagent-native.node'),
    ];

    for (const candidate of candidates) {
      try {
        nativeModule = require(candidate);
        return nativeModule;
      } catch {
        // Try next candidate
      }
    }
  } catch {
    // Native module not available — TS fallback will be used
  }

  return null;
}

/**
 * Check if native acceleration is available.
 */
export function isNativeAvailable(): boolean {
  return getNativeModule() !== null;
}
