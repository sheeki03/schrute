/**
 * Request canonicalizer — native Rust acceleration with TS fallback.
 *
 * JSON contract:
 *   Input:  { url, body?, contentType?, method }
 *   Output: { method, canonicalUrl, canonicalBody?, contentType? }
 */

import type { CanonicalizedRequest } from '../capture/canonicalizer.js';
import { canonicalizeRequest } from '../capture/canonicalizer.js';
import type { StructuredRequest } from '../capture/har-extractor.js';
import { getNativeModule } from './index.js';

export function canonicalizeRequestNative(req: StructuredRequest): CanonicalizedRequest {
  const native = getNativeModule();

  if (native?.canonicalizeRequest) {
    try {
      const input = JSON.stringify({
        url: req.url,
        body: req.body,
        contentType: req.contentType,
        method: req.method,
      });
      const resultJson: string = native.canonicalizeRequest(input);
      return JSON.parse(resultJson) as CanonicalizedRequest;
    } catch {
      // Fall through to TS fallback
    }
  }

  return canonicalizeRequest(req);
}
