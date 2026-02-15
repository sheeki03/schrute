import { getLogger } from '../core/logger.js';
import type { SealedFetchRequest, SealedFetchResponse } from '../skill/types.js';

const log = getLogger();

// ─── Types ──────────────────────────────────────────────────────

export interface TlsOptions {
  /** JA3 fingerprint string to mimic */
  ja3?: string;
  /** User-Agent header override */
  userAgent?: string;
  /** Request timeout in milliseconds */
  timeout?: number;
}

interface CycleTlsInstance {
  (url: string, options: Record<string, unknown>): Promise<{
    status: number;
    headers: Record<string, string>;
    body: string;
  }>;
  exit(): Promise<void>;
}

// ─── CycleTLS Lazy Loader ──────────────────────────────────────

let cycleTlsInstance: CycleTlsInstance | null = null;
let cycleTlsAvailable: boolean | null = null;

async function getCycleTls(): Promise<CycleTlsInstance | null> {
  if (cycleTlsAvailable === false) return null;

  if (cycleTlsInstance) return cycleTlsInstance;

  try {
    // Dynamic import — CycleTLS is optional
    // @ts-expect-error -- cycletls is an optional peer dependency
    const mod = await import('cycletls');
    const initCycleTLS = mod.default ?? mod;
    cycleTlsInstance = await initCycleTLS();
    cycleTlsAvailable = true;
    log.info('CycleTLS loaded successfully');
    return cycleTlsInstance;
  } catch {
    cycleTlsAvailable = false;
    log.debug('CycleTLS not available, using native fetch fallback');
    return null;
  }
}

// ─── TLS Fetch ─────────────────────────────────────────────────

/**
 * Fetch with optional TLS fingerprint mimicry via CycleTLS.
 * Falls back to native fetch when CycleTLS is unavailable.
 *
 * Feature-gated: only meaningful when CycleTLS is installed.
 */
export async function tlsFetch(
  req: SealedFetchRequest,
  options?: TlsOptions,
): Promise<SealedFetchResponse> {
  const tls = await getCycleTls();

  if (tls) {
    return cycleTlsFetch(tls, req, options);
  }

  return nativeFetch(req, options);
}

async function cycleTlsFetch(
  tls: CycleTlsInstance,
  req: SealedFetchRequest,
  options?: TlsOptions,
): Promise<SealedFetchResponse> {
  const headers = { ...req.headers };
  if (options?.userAgent) {
    headers['user-agent'] = options.userAgent;
  }

  const timeout = options?.timeout ?? 30000;

  const result = await Promise.race([
    tls(req.url, {
      method: req.method,
      headers,
      body: req.body ?? '',
      ja3: options?.ja3,
      userAgent: options?.userAgent,
      timeout,
    }),
    rejectAfter(timeout),
  ]);

  return {
    status: result.status,
    headers: normalizeHeaders(result.headers),
    body: typeof result.body === 'string' ? result.body : JSON.stringify(result.body),
  };
}

async function nativeFetch(
  req: SealedFetchRequest,
  options?: TlsOptions,
): Promise<SealedFetchResponse> {
  const headers = { ...req.headers };
  if (options?.userAgent) {
    headers['user-agent'] = options.userAgent;
  }

  const controller = new AbortController();
  const timeout = options?.timeout ?? 30000;
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(req.url, {
      method: req.method,
      headers,
      body: req.body ?? undefined,
      signal: controller.signal,
    });

    const body = await response.text();
    const responseHeaders: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      responseHeaders[key] = value;
    });

    return { status: response.status, headers: responseHeaders, body };
  } finally {
    clearTimeout(timer);
  }
}

// ─── Helpers ────────────────────────────────────────────────────

function normalizeHeaders(headers: Record<string, string>): Record<string, string> {
  const normalized: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    normalized[key.toLowerCase()] = value;
  }
  return normalized;
}

function rejectAfter(ms: number): Promise<never> {
  return new Promise((_, reject) => {
    setTimeout(() => reject(new Error(`TLS fetch timed out after ${ms}ms`)), ms);
  });
}

/**
 * Check if CycleTLS is available without triggering a load.
 */
export function isCycleTlsAvailable(): boolean {
  return cycleTlsAvailable === true;
}

/**
 * Clean up the CycleTLS instance. Call on process shutdown.
 */
export async function closeTlsClient(): Promise<void> {
  if (cycleTlsInstance) {
    try {
      await cycleTlsInstance.exit();
    } catch {
      // Instance may already be closed
    }
    cycleTlsInstance = null;
  }
}

/** Reset module state (for testing) */
export function _resetForTest(): void {
  cycleTlsInstance = null;
  cycleTlsAvailable = null;
}
