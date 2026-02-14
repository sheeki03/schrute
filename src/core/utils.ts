import { getLogger } from './logger.js';
import type { SealedFetchRequest, SealedFetchResponse } from '../skill/types.js';

const log = getLogger();

// ─── extractPathParams ──────────────────────────────────────────────
// Canonical implementation (was duplicated in compiler.ts, validator.ts,
// generator.ts, request-builder.ts).

export function extractPathParams(template: string): string[] {
  const matches = template.match(/\{(\w+)\}/g);
  if (!matches) return [];
  return matches.map((m) => m.slice(1, -1));
}

// ─── defaultFetch ───────────────────────────────────────────────────
// Canonical implementation (was duplicated in compiler.ts, validator.ts).

export async function defaultFetch(req: SealedFetchRequest): Promise<SealedFetchResponse> {
  const response = await fetch(req.url, {
    method: req.method,
    headers: req.headers,
    body: req.body,
  });

  const body = await response.text();
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });

  return {
    status: response.status,
    headers,
    body,
  };
}

// ─── withTimeout ────────────────────────────────────────────────────
// Canonical implementation (was duplicated in compiler.ts, executor.ts,
// redactor.ts). This version accepts a Promise directly (the most common
// usage pattern). redactor.ts previously accepted a thunk; callers should
// wrap with withTimeout(fn(), ms) instead.

export function withTimeout<T>(promise: Promise<T>, ms: number, label?: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(label ? `${label} timed out after ${ms}ms` : `Execution timed out after ${ms}ms`));
    }, ms);

    promise
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch((err) => {
        clearTimeout(timer);
        reject(err);
      });
  });
}

// ─── normalizeOrigin ────────────────────────────────────────────────
// Canonical implementation (was duplicated in graphql-scanner.ts,
// openapi-scanner.ts).

export function normalizeOrigin(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.origin;
  } catch {
    log.debug({ url }, 'normalizeOrigin: URL parse failed, using raw input with trailing slashes stripped');
    return url.replace(/\/+$/, '');
  }
}

// ─── typeOf ─────────────────────────────────────────────────────────
// Canonical implementation (was duplicated in api-extractor.ts,
// response-parser.ts).

export function typeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

// ─── ERROR_SIGNATURE_PATTERNS ───────────────────────────────────────
// Canonical error signature detection patterns (were duplicated in
// validator.ts and response-parser.ts). Both files detect the same
// underlying error conditions in HTTP response bodies.

export const ERROR_SIGNATURE_PATTERNS: ReadonlyArray<{ name: string; check: (body: string) => boolean }> = [
  {
    name: 'json_error_field',
    check: (body) => {
      try {
        const parsed = JSON.parse(body);
        return parsed != null && typeof parsed === 'object' && ('error' in parsed || 'errors' in parsed);
      } catch {
        return false;
      }
    },
  },
  {
    name: 'please_refresh',
    check: (body) => /please\s+refresh/i.test(body),
  },
  {
    name: 'session_expired',
    check: (body) => /session\s+expired/i.test(body),
  },
  {
    name: 'redirect_to_login',
    check: (body) => {
      // Detect meta-refresh or JS redirect to login pages
      return /(?:window\.location|location\.href|<meta\s+http-equiv="refresh").*(?:login|signin|sign-in|auth)/i.test(body);
    },
  },
];
