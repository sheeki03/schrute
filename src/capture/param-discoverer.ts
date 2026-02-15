import * as crypto from 'node:crypto';
import type { ParameterEvidence, ParameterClassification } from '../skill/types.js';
import type { StructuredRecord } from './har-extractor.js';
import { getLogger } from '../core/logger.js';

const log = getLogger();

// ─── Types ───────────────────────────────────────────────────────────

export interface RequestSample {
  record: StructuredRecord;
  declaredInputs?: Record<string, string>;
}

interface FieldObservation {
  path: string;
  location: 'header' | 'query' | 'body' | 'graphql_variable';
  values: string[];
}

// ─── PII Detection (simplified, matching redactor patterns) ──────────

const PII_PATTERNS: RegExp[] = [
  /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/,
  /(\+?1[-.\s]?)?(\(?\d{3}\)?[-.\s]?)?\d{3}[-.\s]?\d{4}/,
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
  /eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/,
];

const SENSITIVE_FIELD_NAMES = new Set([
  'password', 'passwd', 'secret', 'token', 'api_key', 'apikey',
  'access_token', 'refresh_token', 'authorization', 'cookie',
  'session', 'credit_card', 'ssn', 'social_security',
]);

function isPii(value: string): boolean {
  return PII_PATTERNS.some(p => p.test(value));
}

function isSensitiveField(fieldPath: string): boolean {
  const lastSegment = fieldPath.split('.').pop()?.toLowerCase() ?? '';
  return SENSITIVE_FIELD_NAMES.has(lastSegment);
}

function redactValue(value: string, fieldPath: string, salt: string): string {
  if (isPii(value)) {
    // Salted HMAC for PII
    const hash = crypto.createHmac('sha256', salt).update(value).digest('hex');
    return `[REDACTED:${hash.slice(0, 12)}]`;
  }

  if (isSensitiveField(fieldPath)) {
    // Masking for sensitive fields
    if (value.length <= 4) return '***';
    return `${value.slice(0, 2)}***${value.slice(-2)}`;
  }

  // Verbatim for safe values
  return value;
}

// ─── Public API ──────────────────────────────────────────────────────

export function discoverParams(recordings: RequestSample[], salt?: string): ParameterEvidence[] {
  if (recordings.length < 2) {
    log.warn('Parameter discovery requires at least 2 recordings');
    return [];
  }

  const effectiveSalt = salt ?? crypto.randomBytes(16).toString('hex');

  // Collect observations across all recordings
  const observations = collectObservations(recordings);

  // Classify each field
  const evidence: ParameterEvidence[] = [];

  for (const [path, obs] of observations) {
    const classification = classifyField(obs, recordings);
    const redactedValues = obs.values.map(v => redactValue(v, path, effectiveSalt));

    // Check correlation with declared inputs
    const correlatesWithInput = checkInputCorrelation(obs, recordings);

    evidence.push({
      fieldPath: path,
      classification,
      observedValues: redactedValues,
      correlatesWithInput,
      volatility: computeVolatility(obs.values),
    });
  }

  log.debug(
    {
      totalFields: evidence.length,
      parameters: evidence.filter(e => e.classification === 'parameter').length,
      ephemeral: evidence.filter(e => e.classification === 'ephemeral').length,
      constant: evidence.filter(e => e.classification === 'constant').length,
    },
    'Discovered parameters',
  );

  return evidence;
}

// ─── Observation Collection ──────────────────────────────────────────

function collectObservations(
  recordings: RequestSample[],
): Map<string, FieldObservation> {
  const observations = new Map<string, FieldObservation>();

  for (const sample of recordings) {
    const { record } = sample;

    // Headers
    for (const [key, value] of Object.entries(record.request.headers)) {
      const path = `header.${key}`;
      addObservation(observations, path, 'header', value);
    }

    // Query params
    for (const [key, value] of Object.entries(record.request.queryParams)) {
      const path = `query.${key}`;
      addObservation(observations, path, 'query', value);
    }

    // Body (JSON)
    if (record.request.body) {
      try {
        const parsed = JSON.parse(record.request.body);
        if (typeof parsed === 'object' && parsed !== null) {
          // Check for GraphQL variables
          if ('variables' in parsed && typeof parsed.variables === 'object' && parsed.variables !== null) {
            collectJsonPaths(parsed.variables, 'graphql_var', observations, 'graphql_variable');
          }
          collectJsonPaths(parsed, 'body', observations, 'body');
        }
      } catch {
        // Non-JSON body, treat as single value
        addObservation(observations, 'body.$raw', 'body', record.request.body);
      }
    }
  }

  return observations;
}

function addObservation(
  observations: Map<string, FieldObservation>,
  path: string,
  location: 'header' | 'query' | 'body' | 'graphql_variable',
  value: string,
): void {
  let obs = observations.get(path);
  if (!obs) {
    obs = { path, location, values: [] };
    observations.set(path, obs);
  }
  obs.values.push(value);
}

function collectJsonPaths(
  obj: unknown,
  prefix: string,
  observations: Map<string, FieldObservation>,
  location: 'body' | 'graphql_variable',
): void {
  if (obj === null || obj === undefined) return;

  if (typeof obj === 'string' || typeof obj === 'number' || typeof obj === 'boolean') {
    addObservation(observations, prefix, location, String(obj));
    return;
  }

  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) {
      collectJsonPaths(obj[i], `${prefix}[${i}]`, observations, location);
    }
    return;
  }

  if (typeof obj === 'object') {
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      collectJsonPaths(value, `${prefix}.${key}`, observations, location);
    }
  }
}

// ─── Classification ──────────────────────────────────────────────────

function classifyField(
  obs: FieldObservation,
  recordings: RequestSample[],
): ParameterClassification {
  const uniqueValues = new Set(obs.values);

  // Constant: same value across all samples
  if (uniqueValues.size === 1) {
    return 'constant';
  }

  // Check correlation with declared inputs
  if (checkInputCorrelation(obs, recordings)) {
    return 'parameter';
  }

  // Fields that vary: check if they look like parameters or ephemeral
  const volatility = computeVolatility(obs.values);

  // High volatility + no input correlation = ephemeral (timestamps, nonces, etc.)
  if (volatility > 0.9 && !checkInputCorrelation(obs, recordings)) {
    return 'ephemeral';
  }

  // Medium volatility with some structure = likely parameter
  if (volatility > 0 && volatility <= 0.9) {
    return 'parameter';
  }

  return 'ephemeral';
}

function checkInputCorrelation(
  obs: FieldObservation,
  recordings: RequestSample[],
): boolean {
  // Check if field values correlate with any declared input
  for (const sample of recordings) {
    if (!sample.declaredInputs) continue;

    for (const inputValue of Object.values(sample.declaredInputs)) {
      // Check if any observed value matches or contains the input value
      if (obs.values.some(v => v === inputValue || v.includes(inputValue))) {
        return true;
      }
    }
  }

  return false;
}

function computeVolatility(values: string[]): number {
  if (values.length <= 1) return 0;

  const unique = new Set(values);
  return unique.size / values.length;
}
