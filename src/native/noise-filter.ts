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
): FilterResult {
  const native = getNativeModule();

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
        noise: parsed.noiseIndices.map(i => entries[i]),
        ambiguous: parsed.ambiguousIndices.map(i => entries[i]),
      };
    } catch (err) {
      if (!_nativeFailureLogged) {
        log.debug({ err }, 'Native noise-filter unavailable, using TS fallback');
        _nativeFailureLogged = true;
      }
    }
  }

  return tsFilterRequests(entries, overrides);
}
