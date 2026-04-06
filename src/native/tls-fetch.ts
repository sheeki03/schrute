/**
 * TypeScript wrapper for the native wreq TLS client binding.
 *
 * The native `tlsFetch` function is synchronous — it blocks the Node
 * thread for the duration of the HTTP roundtrip.  This is intentional:
 * Calling it blocks the Node event loop until the HTTP roundtrip completes.
 * Internally, the Rust side runs the async request on a persistent tokio
 * runtime via block_on.
 */

import { getNativeModule } from './index.js';
import type { SealedFetchResponse } from '../skill/types.js';

// ─── Public Request Types ─────────────────────────────────────

export interface WreqFetchRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

export interface WreqFetchOptions {
  timeoutMs?: number;
  maxResponseBytes?: number;
}

// ─── Internal Wire Types ──────────────────────────────────────

interface TlsFetchInput {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
  timeoutMs: number;
  maxResponseBytes: number;
}

interface TlsFetchOutput {
  status: number;
  headers: Record<string, string>;
  body: string;
}

// ─── Public API ───────────────────────────────────────────────

/**
 * Execute an HTTP request via the native wreq TLS client.
 * Returns null if the native module or tlsFetch binding is unavailable.
 * Sync call — blocks for the duration of the HTTP roundtrip.
 */
export function wreqFetch(
  req: WreqFetchRequest,
  options?: WreqFetchOptions,
): SealedFetchResponse | null {
  const native = getNativeModule();
  if (!native?.tlsFetch) return null;

  const input: TlsFetchInput = {
    url: req.url,
    method: req.method,
    headers: req.headers,
    body: req.body,
    timeoutMs: options?.timeoutMs ?? 30_000,
    maxResponseBytes: options?.maxResponseBytes ?? 10 * 1024 * 1024,
  };

  const resultJson = native.tlsFetch(JSON.stringify(input));
  if (!resultJson) return null;

  let output: TlsFetchOutput;
  try {
    output = JSON.parse(resultJson);
  } catch (parseErr) {
    throw new Error(
      `wreq native binding returned unparseable response: ${parseErr instanceof Error ? parseErr.message : parseErr}`,
    );
  }
  return {
    status: output.status,
    headers: output.headers,
    body: output.body,
  };
}

/**
 * Check if the wreq native binding is available.
 */
export function isWreqAvailable(): boolean {
  const native = getNativeModule();
  return typeof native?.tlsFetch === 'function';
}
