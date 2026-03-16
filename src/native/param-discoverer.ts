/**
 * Parameter discoverer — native Rust acceleration with TS fallback.
 *
 * JSON contract:
 *   Input:  { samples: Array<{ headers, queryParams, body?, declaredInputs? }> }
 *   Output: ParameterEvidence[]
 */

import type { ParameterEvidence } from '../skill/types.js';
import type { RequestSample } from '../capture/param-discoverer.js';
import { discoverParams as tsDiscoverParams } from '../capture/param-discoverer.js';
import { getNativeModule } from './index.js';
import { getLogger } from '../core/logger.js';

const log = getLogger();
let _nativeFailureLogged = false;

export function discoverParamsNative(recordings: RequestSample[]): ParameterEvidence[] {
  const native = getNativeModule();

  if (native?.discoverParams) {
    try {
      const samples = recordings.map(r => ({
        headers: r.record.request.headers,
        queryParams: r.record.request.queryParams,
        body: r.record.request.body,
        declaredInputs: r.declaredInputs,
      }));
      const input = JSON.stringify({ samples });
      const resultJson: string = native.discoverParams(input);
      return JSON.parse(resultJson) as ParameterEvidence[];
    } catch (err) {
      if (!_nativeFailureLogged) {
        log.info({ err }, 'Native param-discoverer unavailable, using TS fallback');
        _nativeFailureLogged = true;
      }
    }
  }

  return tsDiscoverParams(recordings);
}
