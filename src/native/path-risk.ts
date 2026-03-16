/**
 * Path risk checker — native Rust acceleration with TS fallback.
 *
 * JSON contract:
 *   Input:  { method, path }
 *   Output: { blocked: boolean, reason?: string }
 */

import type { PathRiskResult } from '../skill/path-risk.js';
import { checkPathRisk as tsCheckPathRisk } from '../skill/path-risk.js';
import { getNativeModule } from './index.js';
import { getLogger } from '../core/logger.js';

const log = getLogger();
let _nativeFailureLogged = false;

export function checkPathRiskNative(method: string, path: string): PathRiskResult {
  const native = getNativeModule();

  if (native?.checkPathRisk) {
    try {
      const input = JSON.stringify({ method, path });
      const resultJson: string = native.checkPathRisk(input);
      return JSON.parse(resultJson) as PathRiskResult;
    } catch (err) {
      if (!_nativeFailureLogged) {
        log.info({ err }, 'Native path-risk unavailable, using TS fallback');
        _nativeFailureLogged = true;
      }
    }
  }

  return tsCheckPathRisk(method, path);
}
