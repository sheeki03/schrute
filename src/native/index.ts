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
import { getLogger } from '../core/logger.js';

const log = getLogger();

/** Native binding function signature (all accept/return JSON strings). */
type NativeBindingFn = (...args: string[]) => string;

/** Known native binding function signatures. */
interface NativeBindings {
  // redactor
  redact?: NativeBindingFn;
  redactHeaders?: NativeBindingFn;
  // param-discoverer
  discoverParams?: NativeBindingFn;
  // canonicalizer
  canonicalizeRequest?: NativeBindingFn;
  // har-parser
  parseHar?: NativeBindingFn;
  // noise-filter
  filterRequests?: NativeBindingFn;
  // audit-chain
  computeEntryHash?: NativeBindingFn;
  signEntryHash?: NativeBindingFn;
  verifyChain?: NativeBindingFn;
  // semantic-diff
  checkSemantic?: NativeBindingFn;
  // volatility
  scoreVolatility?: NativeBindingFn;
  // schema-inference
  inferSchema?: NativeBindingFn;
  // path-risk
  checkPathRisk?: NativeBindingFn;
  // ip-policy
  isPublicIp?: NativeBindingFn;
  normalizeDomainNative?: NativeBindingFn;
  checkDomainAllowlist?: NativeBindingFn;
  // Allow additional bindings not yet typed
  [key: string]: NativeBindingFn | undefined;
}

let nativeModule: NativeBindings | null = null;
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
      } catch (err) {
        log.debug({ err, candidate }, 'Native module candidate not loadable');
      }
    }
  } catch (err) {
    log.info({ err }, 'Native module unavailable — using TypeScript fallback');
  }

  return null;
}

/**
 * Check if native acceleration is available.
 */
export function isNativeAvailable(): boolean {
  return getNativeModule() !== null;
}
