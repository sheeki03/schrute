/**
 * Transport abstraction layer for direct HTTP execution.
 *
 * Each TransportProvider satisfies the following contract:
 *   1. Suppress redirects — return 3xx + `location` header as-is
 *   2. Lowercase all response header keys
 *   3. Fail-closed on body size — throw when body exceeds `maxResponseBytes`
 *   4. pinnedIp — connect to the specified IP with SNI on original hostname; if unsupported, MUST fall back to native transport
 */

import * as https from 'node:https';
import * as http from 'node:http';
import { createRequire } from 'node:module';
import { getLogger } from '../core/logger.js';
import { getConfig } from '../core/config.js';
import type { SealedFetchResponse } from '../skill/types.js';
import {
  isCycleTlsAvailable,
  closeTlsClient,
  tlsFetch,
} from './tls-client.js';

const log = getLogger();

// ─── Types ──────────────────────────────────────────────────────

export type TransportName = 'native' | 'cycletls' | 'wreq';

export interface TransportProvider {
  name: TransportName;
  available(): boolean | Promise<boolean>;
  fetch(req: TransportRequest, options: TransportOptions): Promise<SealedFetchResponse>;
  cleanup?(): Promise<void>;
}

export interface TransportRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

export interface TransportOptions {
  maxResponseBytes: number;
  timeoutMs: number;
  pinnedIp?: string;
}

// ─── Header Normalisation ──────────────────────────────────────

function lowercaseHeaders(headers: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    result[key.toLowerCase()] = value;
  }
  return result;
}

// ─── Native Fetch Transport ────────────────────────────────────

/**
 * Fetch using node:https/node:http with pinned IP and correct TLS SNI.
 *
 * Connects to `pinnedIp` while setting `servername` to the original hostname
 * so TLS certificate validation succeeds.
 */
function pinnedIpFetch(
  request: TransportRequest,
  pinnedIp: string,
  maxResponseBytes: number,
  timeoutMs: number,
): Promise<SealedFetchResponse> {
  return new Promise<SealedFetchResponse>((resolve, reject) => {
    const parsed = new URL(request.url);
    const isHttps = parsed.protocol === 'https:';
    const originalHost = parsed.hostname;
    const port = parsed.port
      ? Number(parsed.port)
      : (isHttps ? 443 : 80);
    const path = parsed.pathname + parsed.search;

    const reqHeaders: Record<string, string> = { ...request.headers };
    // Ensure Host header is set for correct virtual-host routing
    if (!reqHeaders['Host'] && !reqHeaders['host']) {
      reqHeaders['Host'] = parsed.port ? `${parsed.hostname}:${parsed.port}` : parsed.hostname;
    }

    const baseOptions: http.RequestOptions = {
      hostname: pinnedIp,
      port,
      path,
      method: request.method,
      headers: reqHeaders,
    };

    // For HTTPS: set servername for correct TLS SNI and cert validation.
    const options = isHttps
      ? { ...baseOptions, servername: originalHost, rejectUnauthorized: true } as https.RequestOptions
      : baseOptions;

    const transport = isHttps ? https : http;
    const effectiveTimeout = timeoutMs || 30_000;

    const req = transport.request(options, (res) => {
      const chunks: Buffer[] = [];
      let totalBytes = 0;
      let aborted = false;

      res.on('data', (chunk: Buffer) => {
        if (aborted) return;
        totalBytes += chunk.length;
        if (totalBytes > maxResponseBytes) {
          aborted = true;
          res.destroy();
          reject(new Error(
            `Response body exceeded maxResponseBytes (${maxResponseBytes}). ` +
            `Read ${totalBytes} bytes before aborting.`,
          ));
          return;
        }
        chunks.push(chunk);
      });

      res.on('end', () => {
        if (aborted) return;
        req.setTimeout(0); // Clear timeout to prevent late-firing destroy
        const headers: Record<string, string> = {};
        if (res.headers) {
          for (const [key, value] of Object.entries(res.headers)) {
            if (value != null) {
              headers[key.toLowerCase()] = Array.isArray(value) ? value.join(', ') : value;
            }
          }
        }
        const body = Buffer.concat(chunks).toString('utf-8');
        resolve({ status: res.statusCode ?? 0, headers, body });
      });

      res.on('error', (err) => {
        if (!aborted) reject(err);
      });
    });

    req.setTimeout(effectiveTimeout, () => {
      req.destroy(new Error(`Request timed out after ${effectiveTimeout}ms`));
    });

    req.on('error', (err) => reject(err));

    if (request.body) {
      req.write(request.body);
    }
    req.end();
  });
}

/**
 * Standard fetch with redirect suppression and streamed body size cap.
 */
async function standardFetch(
  request: TransportRequest,
  maxResponseBytes: number,
  timeoutMs: number,
): Promise<SealedFetchResponse> {
  const abortController = new AbortController();
  const abortTimeout = timeoutMs
    ? setTimeout(() => abortController.abort(new Error(`Transport fetch timed out after ${timeoutMs}ms`)), timeoutMs)
    : undefined;

  let response: Response;
  try {
    response = await fetch(request.url, {
      method: request.method,
      headers: request.headers,
      body: request.method === 'GET' || request.method === 'HEAD' ? undefined : request.body,
      redirect: 'manual',  // never auto-follow redirects
      signal: abortController.signal,
    });
  } catch (err) {
    if (abortTimeout) clearTimeout(abortTimeout);
    throw err;
  }

  try {
    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });

    // Read response body incrementally with size cap to prevent memory exhaustion.
    let body: string;
    if (response.body) {
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let totalBytes = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          totalBytes += value.byteLength;
          if (totalBytes > maxResponseBytes) {
            reader.cancel();
            throw new Error(
              `Response body exceeded maxResponseBytes (${maxResponseBytes}). ` +
              `Read ${totalBytes} bytes before aborting.`,
            );
          }
          chunks.push(value);
        }
      } finally {
        reader.releaseLock();
      }
      const decoder = new TextDecoder();
      body = chunks.map((c) => decoder.decode(c, { stream: true })).join('') +
        decoder.decode();
    } else {
      body = await response.text();
      if (Buffer.byteLength(body, 'utf-8') > maxResponseBytes) {
        throw new Error(
          `Response body exceeded maxResponseBytes (${maxResponseBytes}).`,
        );
      }
    }

    return { status: response.status, headers, body };
  } finally {
    if (abortTimeout) clearTimeout(abortTimeout);
  }
}

export function createNativeFetchTransport(): TransportProvider {
  return {
    name: 'native',

    available(): boolean {
      return true; // Node built-in fetch is always available
    },

    async fetch(req: TransportRequest, options: TransportOptions): Promise<SealedFetchResponse> {
      if (options.pinnedIp) {
        return pinnedIpFetch(req, options.pinnedIp, options.maxResponseBytes, options.timeoutMs);
      }
      return standardFetch(req, options.maxResponseBytes, options.timeoutMs);
    },
  };
}

// ─── CycleTLS Transport ────────────────────────────────────────

export function createCycleTlsTransport(): TransportProvider {
  return {
    name: 'cycletls',

    available(): boolean {
      return isCycleTlsAvailable();
    },

    async fetch(req: TransportRequest, options: TransportOptions): Promise<SealedFetchResponse> {
      // CycleTLS does not support pinnedIp with SNI — delegate to native.
      if (options.pinnedIp) {
        log.debug('CycleTLS does not support pinnedIp; delegating to native fetch');
        const native = createNativeFetchTransport();
        return native.fetch(req, options);
      }

      const result = await tlsFetch(
        { url: req.url, method: req.method, headers: req.headers, body: req.body },
        { timeout: options.timeoutMs, disableRedirect: true, maxResponseBytes: options.maxResponseBytes },
      );

      // Post-hoc body size check.
      // NOTE: CycleTLS materialises the full response body before returning,
      // so this is best-effort — memory may spike for very large bodies before
      // this check throws.
      if (Buffer.byteLength(result.body, 'utf-8') > options.maxResponseBytes) {
        throw new Error(
          `Response body exceeded maxResponseBytes (${options.maxResponseBytes}). ` +
          `CycleTLS returned ${Buffer.byteLength(result.body, 'utf-8')} bytes.`,
        );
      }

      // Defensive re-normalization: ensures header keys are lowercase
      // regardless of which internal CycleTLS code path ran.
      return {
        status: result.status,
        headers: lowercaseHeaders(result.headers),
        body: result.body,
      };
    },

    async cleanup(): Promise<void> {
      await closeTlsClient();
    },
  };
}

// ─── wreq Native Transport ────────────────────────────────────

export function createWreqTransport(): TransportProvider {
  return {
    name: 'wreq',

    available(): boolean {
      try {
        // Use createRequire (synchronous) to keep available() sync per the
        // TransportProvider interface. The fetch() method uses async import()
        // since it returns a Promise.
        const esmRequire = createRequire(import.meta.url);
        const { isWreqAvailable } = esmRequire('../native/tls-fetch.js');
        return isWreqAvailable();
      } catch (err) {
        log.debug({ err }, 'wreq availability check failed');
        return false;
      }
    },

    async fetch(req: TransportRequest, options: TransportOptions): Promise<SealedFetchResponse> {
      // wreq does not support pinnedIp with SNI — delegate to native
      // to preserve the DNS rebinding / TOCTOU protection that pinnedIpFetch provides.
      if (options.pinnedIp) {
        log.debug('wreq does not support pinnedIp; delegating to native fetch');
        const native = createNativeFetchTransport();
        return native.fetch(req, options);
      }

      const { wreqFetch } = await import('../native/tls-fetch.js');
      const result = wreqFetch(
        { url: req.url, method: req.method, headers: req.headers, body: req.body },
        { timeoutMs: options.timeoutMs, maxResponseBytes: options.maxResponseBytes },
      );
      if (!result) {
        throw new Error('wreq native binding returned null — module may not be loaded');
      }
      return result;
    },
    // No cleanup needed — the tokio runtime persists for process lifetime.
    // In-flight requests are dropped on process exit.
  };
}

// ─── Transport Resolution ──────────────────────────────────────

type DirectTransportValue = 'native' | 'cycletls' | 'wreq' | 'auto';

const VALID_DIRECT_TRANSPORTS = new Set<DirectTransportValue>([
  'native', 'cycletls', 'wreq', 'auto',
]);

let cachedTransport: TransportProvider | null = null;

/**
 * Resolve which TransportProvider to use based on config / env.
 *
 * Resolution order:
 *   1. SCHRUTE_DIRECT_TRANSPORT env var
 *   2. config.transport.direct
 *   3. Default: 'auto'
 *
 * 'auto' currently resolves to native only.
 * wreq and cycletls are explicit opt-in.
 */
export function resolveTransport(): TransportProvider {
  if (cachedTransport) return cachedTransport;

  const envValue = process.env.SCHRUTE_DIRECT_TRANSPORT as DirectTransportValue | undefined;
  let choice: DirectTransportValue = 'auto';

  if (envValue) {
    if (!VALID_DIRECT_TRANSPORTS.has(envValue)) {
      throw new Error(
        `Invalid SCHRUTE_DIRECT_TRANSPORT value: "${envValue}". ` +
        `Must be one of: ${[...VALID_DIRECT_TRANSPORTS].join(', ')}.`,
      );
    }
    choice = envValue;
  } else {
    try {
      const cfg = getConfig();
      const cfgValue = cfg.transport?.direct;
      if (cfgValue) {
        if (!VALID_DIRECT_TRANSPORTS.has(cfgValue as DirectTransportValue)) {
          log.warn(
            { value: cfgValue },
            'Invalid transport.direct config value; falling back to auto',
          );
        } else {
          choice = cfgValue as DirectTransportValue;
        }
      }
    } catch (err) {
      log.debug({ err }, 'Config not available during transport resolution — using auto');
    }
  }

  let transport: TransportProvider;

  switch (choice) {
    case 'cycletls':
      transport = createCycleTlsTransport();
      break;
    case 'wreq': {
      const wreq = createWreqTransport();
      if (!wreq.available()) {
        throw new Error(
          'Transport "wreq" requested but native binding is unavailable. ' +
          'Ensure the native module is compiled with wreq support.',
        );
      }
      transport = wreq;
      break;
    }
    case 'native':
      transport = createNativeFetchTransport();
      break;
    case 'auto':
    default:
      // Auto: native only
      transport = createNativeFetchTransport();
      break;
  }

  cachedTransport = transport;
  return transport;
}

/** Reset cached transport (for testing). */
export function _resetTransportCache(): void {
  cachedTransport = null;
}
