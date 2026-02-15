import { canonicalizeRequest } from './canonicalizer.js';
import { parameterizePath } from './api-extractor.js';
import type { StructuredRecord } from './har-extractor.js';
import type { RequestSample } from './param-discoverer.js';
import { getLogger } from '../core/logger.js';

const log = getLogger();

// ─── Public API ──────────────────────────────────────────────────────

export interface DeduplicatedSample extends RequestSample {
  isDuplicate: boolean;
  canonicalKey: string;
}

export function deduplicate(
  sessions: RequestSample[][],
): DeduplicatedSample[] {
  const seen = new Map<string, DeduplicatedSample>();
  const results: DeduplicatedSample[] = [];

  for (const session of sessions) {
    for (const sample of session) {
      const key = buildCanonicalKey(sample.record);

      if (seen.has(key)) {
        // Duplicate — keep for parameter discovery but mark it
        results.push({
          ...sample,
          isDuplicate: true,
          canonicalKey: key,
        });
      } else {
        const deduped: DeduplicatedSample = {
          ...sample,
          isDuplicate: false,
          canonicalKey: key,
        };
        seen.set(key, deduped);
        results.push(deduped);
      }
    }
  }

  const totalSamples = results.length;
  const uniqueSamples = seen.size;
  const duplicates = totalSamples - uniqueSamples;

  log.debug(
    { totalSamples, uniqueSamples, duplicates },
    'Deduplicated request samples',
  );

  return results;
}

// ─── Internal ────────────────────────────────────────────────────────

function buildCanonicalKey(record: StructuredRecord): string {
  const canonical = canonicalizeRequest(record.request);
  const method = canonical.method;

  // Extract and parameterize path
  let path: string;
  try {
    path = parameterizePath(new URL(canonical.canonicalUrl).pathname);
  } catch {
    path = canonical.canonicalUrl;
  }

  // Build body structure fingerprint (just keys, not values)
  const bodyFingerprint = buildBodyFingerprint(canonical.canonicalBody);

  return `${method}|${path}|${bodyFingerprint}`;
}

function buildBodyFingerprint(body?: string): string {
  if (!body) return '';

  try {
    const parsed = JSON.parse(body);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      // Sort keys and create a fingerprint of the structure
      const keys = Object.keys(parsed).sort();
      return keys.join(',');
    }
  } catch {
    // not JSON
  }

  return '';
}
