/**
 * Schema inference — native Rust acceleration with TS fallback.
 *
 * JSON contract:
 *   Input:  JSON array of sample values
 *   Output: JsonSchema object
 */

import type { JsonSchema } from '../capture/schema-inferrer.js';
import { inferSchema as tsInferSchema } from '../capture/schema-inferrer.js';
import { getNativeModule } from './index.js';
import { getLogger } from '../core/logger.js';

const log = getLogger();
let _nativeFailureLogged = false;

export function inferSchemaNative(samples: unknown[]): JsonSchema {
  const native = getNativeModule();

  if (native?.inferSchema) {
    try {
      const input = JSON.stringify(samples);
      const resultJson: string = native.inferSchema(input);
      return JSON.parse(resultJson) as JsonSchema;
    } catch (err) {
      if (!_nativeFailureLogged) {
        log.debug({ err }, 'Native schema-inference unavailable, using TS fallback');
        _nativeFailureLogged = true;
      }
    }
  }

  return tsInferSchema(samples);
}
