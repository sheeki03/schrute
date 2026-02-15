import { getLogger } from '../core/logger.js';
import type { FieldVolatility, FieldLocation } from '../skill/types.js';

const log = getLogger();

// ─── Types ──────────────────────────────────────────────────────

export interface RequestSample {
  headers: Record<string, string>;
  queryParams: Record<string, string>;
  bodyFields: Record<string, unknown>;
  graphqlVariables?: Record<string, unknown>;
}

// ─── Score Volatility ───────────────────────────────────────────

export function scoreVolatility(samples: RequestSample[]): FieldVolatility[] {
  if (samples.length === 0) return [];

  const results: FieldVolatility[] = [];

  // Collect values per field across all locations
  const fieldCollections = new Map<string, { location: FieldLocation; values: string[] }>();

  for (const sample of samples) {
    // Headers
    for (const [key, value] of Object.entries(sample.headers)) {
      const fieldKey = `header:${key.toLowerCase()}`;
      let entry = fieldCollections.get(fieldKey);
      if (!entry) {
        entry = { location: 'header', values: [] };
        fieldCollections.set(fieldKey, entry);
      }
      entry.values.push(value);
    }

    // Query params
    for (const [key, value] of Object.entries(sample.queryParams)) {
      const fieldKey = `query:${key}`;
      let entry = fieldCollections.get(fieldKey);
      if (!entry) {
        entry = { location: 'query', values: [] };
        fieldCollections.set(fieldKey, entry);
      }
      entry.values.push(value);
    }

    // Body fields (flatten top-level only)
    for (const [key, value] of Object.entries(sample.bodyFields)) {
      const fieldKey = `body:${key}`;
      let entry = fieldCollections.get(fieldKey);
      if (!entry) {
        entry = { location: 'body', values: [] };
        fieldCollections.set(fieldKey, entry);
      }
      entry.values.push(String(value));
    }

    // GraphQL variables
    if (sample.graphqlVariables) {
      for (const [key, value] of Object.entries(sample.graphqlVariables)) {
        const fieldKey = `graphql_variable:${key}`;
        let entry = fieldCollections.get(fieldKey);
        if (!entry) {
          entry = { location: 'graphql_variable', values: [] };
          fieldCollections.set(fieldKey, entry);
        }
        entry.values.push(String(value));
      }
    }
  }

  // Score each field
  for (const [fieldKey, collection] of fieldCollections) {
    const fieldPath = fieldKey.split(':').slice(1).join(':');
    const { location, values } = collection;

    const entropy = shannonEntropy(values);
    const changeRate = computeChangeRate(values);
    const isStatic = changeRate === 0;
    // Shannon entropy thresholds: >3.0 indicates high randomness (likely nonce/token), >2.0 moderate variability
    const looksLikeNonce = entropy > 3.0 && changeRate >= 0.9;
    const looksLikeToken = !looksLikeNonce && changeRate > 0 && changeRate < 0.9 && entropy > 2.0;

    results.push({
      fieldPath,
      fieldLocation: location,
      entropy,
      changeRate,
      looksLikeNonce,
      looksLikeToken,
      isStatic,
    });
  }

  log.debug(
    { fieldCount: results.length, sampleCount: samples.length },
    'Scored field volatility',
  );

  return results;
}

// ─── Overall Volatility Score ───────────────────────────────────

export function overallVolatilityScore(volatilities: FieldVolatility[]): number {
  if (volatilities.length === 0) return 0;

  // Mean changeRate across all fields
  const sum = volatilities.reduce((acc, v) => acc + v.changeRate, 0);
  return sum / volatilities.length;
}

// ─── Shannon Entropy ────────────────────────────────────────────

function shannonEntropy(values: string[]): number {
  if (values.length === 0) return 0;

  // Character-level entropy across all observed values
  const allChars = values.join('');
  if (allChars.length === 0) return 0;

  const freq = new Map<string, number>();
  for (const ch of allChars) {
    freq.set(ch, (freq.get(ch) ?? 0) + 1);
  }

  let entropy = 0;
  const total = allChars.length;
  for (const count of freq.values()) {
    const p = count / total;
    if (p > 0) {
      entropy -= p * Math.log2(p);
    }
  }

  return entropy;
}

// ─── Change Rate ────────────────────────────────────────────────

function computeChangeRate(values: string[]): number {
  if (values.length <= 1) return 0;

  let changes = 0;
  for (let i = 1; i < values.length; i++) {
    if (values[i] !== values[i - 1]) {
      changes++;
    }
  }

  return changes / (values.length - 1);
}
