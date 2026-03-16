import { createHash } from 'node:crypto';
import { getLogger } from './logger.js';
import type { SealedFetchRequest, SealedFetchResponse } from '../skill/types.js';

const log = getLogger();

// ─── extractPathParams ──────────────────────────────────────────────

/**
 * Extract named path parameters from a URL path template.
 *
 * @param template - URL path template containing `{paramName}` placeholders
 * @returns Array of parameter names found in the template
 */
export function extractPathParams(template: string): string[] {
  const matches = template.match(/\{(\w+)\}/g);
  if (!matches) return [];
  return matches.map((m) => m.slice(1, -1));
}

// ─── defaultFetch ───────────────────────────────────────────────────

/**
 * Execute an HTTP request using the global `fetch` API and return a normalized response.
 *
 * @param req - Sealed fetch request containing url, method, headers, and optional body
 * @returns Normalized response with status, headers, and body as text
 */
export async function defaultFetch(req: SealedFetchRequest): Promise<SealedFetchResponse> {
  const response = await fetch(req.url, {
    method: req.method,
    headers: req.headers,
    body: req.body,
    redirect: 'manual',
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

/**
 * Race a promise against a timeout, rejecting if the timeout fires first.
 *
 * @param promise - The promise to race against the timeout
 * @param ms - Timeout duration in milliseconds
 * @param label - Optional label included in the timeout error message
 * @returns The resolved value of the promise, or rejects with a timeout error
 */
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

/**
 * Extract the origin (scheme + host + port) from a URL string.
 * Falls back to stripping trailing slashes if the URL cannot be parsed.
 *
 * @param url - The URL to normalize
 * @returns The origin portion of the URL
 */
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

/**
 * Return a refined type string for a value, distinguishing `null` and `array`
 * from the generic `typeof` result.
 *
 * @param value - Any value to inspect
 * @returns `'null'`, `'array'`, or the result of `typeof value`
 */
export function typeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

// ─── ERROR_SIGNATURE_PATTERNS ───────────────────────────────────────

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

// ─── sanitizeSiteId ──────────────────────────────────────────────
// Sanitize user-provided siteId values for safe filesystem usage.

const WINDOWS_RESERVED = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i;

export function sanitizeSiteId(input: string): string {
  const lowered = input.toLowerCase();
  let s = lowered
    .replace(/[\x00-\x1f\x7f]/g, '')       // strip control chars
    .replace(/[/\\:*?"<>|]/g, '-')           // replace path-unsafe chars
    .replace(/\.{2,}/g, '.')                 // collapse consecutive dots
    .replace(/^\.+|\.+$/g, '')               // strip leading/trailing dots
    .trim();

  if (s.length === 0) throw new Error('siteId cannot be empty after sanitization');

  const hadUnsafeChars = s !== lowered;
  const needsTruncation = s.length > 93;
  if (needsTruncation) s = s.slice(0, 93);

  if (hadUnsafeChars || needsTruncation) {
    const hash = createHash('sha256').update(lowered).digest('hex').slice(0, 6);
    s = `${s}-${hash}`;
  }

  if (WINDOWS_RESERVED.test(s)) s = `_${s}`;

  return s;
}
