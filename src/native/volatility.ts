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

export function scoreVolatilityNative(samples: RequestSample[]): FieldVolatility[] {
  const native = getNativeModule();

  if (native?.scoreVolatility) {
    try {
      const input = JSON.stringify(samples);
      const resultJson: string = native.scoreVolatility(input);
      return JSON.parse(resultJson) as FieldVolatility[];
    } catch {
      // Fall through to TS fallback
    }
  }

  return tsScoreVolatility(samples);
}
