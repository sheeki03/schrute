/**
 * Noise filter — native Rust acceleration with TS fallback.
 *
 * JSON contract:
 *   Input:  { entries: HarEntry[], overrides?: SiteOverride[] }
 *   Output: { signalIndices: number[], noiseIndices: number[], ambiguousIndices: number[] }
 *
 * The native module returns indices rather than full entries for efficiency.
 */

import type { HarEntry } from '../capture/har-extractor.js';
import type { FilterResult, SiteOverride } from '../capture/noise-filter.js';
import { filterRequests as tsFilterRequests } from '../capture/noise-filter.js';
import { getNativeModule } from './index.js';
import { getLogger } from '../core/logger.js';

const log = getLogger();
let _nativeFailureLogged = false;

export function filterRequestsNative(
  entries: HarEntry[],
  overrides: SiteOverride[] = [],
  siteHost?: string,
): FilterResult {
  // When siteHost is provided, skip native module (not yet supported)
  // and fall through to TS implementation which supports site-aware filtering
  const native = siteHost ? null : getNativeModule();

  if (native?.filterRequests) {
    try {
      const input = JSON.stringify({ entries, overrides });
      const resultJson: string = native.filterRequests(input);
      const parsed = JSON.parse(resultJson) as {
        signalIndices: number[];
        noiseIndices: number[];
        ambiguousIndices: number[];
      };

      // Map indices back to entries
      return {
        signal: parsed.signalIndices.map(i => entries[i]),
        htmlDocument: [],
        noise: parsed.noiseIndices.map(i => entries[i]),
        ambiguous: parsed.ambiguousIndices.map(i => entries[i]),
      };
    } catch (err) {
      if (!_nativeFailureLogged) {
        log.info({ err }, 'Native noise-filter unavailable, using TS fallback');
        _nativeFailureLogged = true;
      }
    }
  }

  return tsFilterRequests(entries, overrides, siteHost);
}
