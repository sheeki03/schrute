/**
 * Volatility scoring — native Rust acceleration with TS fallback.
 *
 * JSON contract:
 *   Input:  RequestSample[] (headers, queryParams, bodyFields, graphqlVariables?)
 *   Output: FieldVolatility[]
 */

import type { FieldVolatility } from '../skill/types.js';
import type { RequestSample } from '../replay/volatility.js';
import { scoreVolatility as tsScoreVolatility } from '../replay/volatility.js';
import { getNativeModule } from './index.js';
import { getLogger } from '../core/logger.js';

const log = getLogger();
let _nativeFailureLogged = false;

export function scoreVolatilityNative(samples: RequestSample[]): FieldVolatility[] {
  const native = getNativeModule();

  if (native?.scoreVolatility) {
    try {
      const input = JSON.stringify(samples);
      const resultJson: string = native.scoreVolatility(input);
      return JSON.parse(resultJson) as FieldVolatility[];
    } catch (err) {
      if (!_nativeFailureLogged) {
        log.debug({ err }, 'Native volatility unavailable, using TS fallback');
        _nativeFailureLogged = true;
      }
    }
  }

  return tsScoreVolatility(samples);
}
