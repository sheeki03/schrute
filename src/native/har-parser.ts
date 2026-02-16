/**
 * HAR parser — native Rust acceleration with TS fallback.
 *
 * JSON contract:
 *   Input:  HAR JSON string (full HAR 1.2 format)
 *   Output: StructuredRecord[] as JSON string
 */

import type { StructuredRecord, HarData } from '../capture/har-extractor.js';
import { extractRequestResponse } from '../capture/har-extractor.js';
import { getNativeModule } from './index.js';
import { getLogger } from '../core/logger.js';

const log = getLogger();
let _nativeFailureLogged = false;

export function parseHarNative(harJson: string): StructuredRecord[] {
  const native = getNativeModule();

  if (native?.parseHar) {
    try {
      const resultJson: string = native.parseHar(harJson);
      return JSON.parse(resultJson) as StructuredRecord[];
    } catch (err) {
      if (!_nativeFailureLogged) {
        log.debug({ err }, 'Native har-parser unavailable, using TS fallback');
        _nativeFailureLogged = true;
      }
    }
  }

  // TS fallback: parse and extract each entry
  const harData: HarData = JSON.parse(harJson);
  return harData.log.entries.map(extractRequestResponse);
}
