/**
 * Redactor — native Rust acceleration with TS fallback.
 *
 * JSON contract:
 *   Input:  { value: any, salt: string, mode: "agent-safe" | "developer-debug" }
 *   Output: { redacted: any }
 *
 * For headers:
 *   Input:  { headers: Record<string,string>, salt: string }
 *   Output: Record<string,string>
 */

import type { RedactionMode } from '../skill/types.js';
import { redactForOutput, redactHeaders as tsRedactHeaders } from '../storage/redactor.js';
import { getNativeModule } from './index.js';
import { getLogger } from '../core/logger.js';

const log = getLogger();
let _nativeFailureLogged = false;

export function redactNative(
  value: unknown,
  salt: string,
  mode: RedactionMode = 'agent-safe',
): unknown | null {
  const native = getNativeModule();

  if (native?.redact) {
    try {
      const input = JSON.stringify({ value, salt, mode });
      const resultJson: string = native.redact(input);
      const parsed = JSON.parse(resultJson);
      return parsed.redacted;
    } catch (err) {
      if (!_nativeFailureLogged) {
        log.debug({ err }, 'Native redactor unavailable, using TS fallback');
        _nativeFailureLogged = true;
      }
    }
  }

  // Return null to signal caller should use async TS fallback
  return null;
}

export function redactHeadersNative(
  headers: Record<string, string>,
  salt: string,
): Record<string, string> | null {
  const native = getNativeModule();

  if (native?.redactHeaders) {
    try {
      const input = JSON.stringify({ headers, salt });
      const resultJson: string = native.redactHeaders(input);
      return JSON.parse(resultJson) as Record<string, string>;
    } catch (err) {
      if (!_nativeFailureLogged) {
        log.debug({ err }, 'Native redactor unavailable, using TS fallback');
        _nativeFailureLogged = true;
      }
    }
  }

  // Return null to signal caller should use async TS fallback
  return null;
}
