import * as crypto from 'node:crypto';
import { getLogger } from '../core/logger.js';
import { withTimeout } from '../core/utils.js';
import type { RedactionMode } from '../skill/types.js';
import { retrieve, store } from './secrets.js';

const SALT_KEY = '__oneagent_redaction_salt__';
let cachedSalt: string | null = null;

async function getSalt(): Promise<string> {
  if (cachedSalt) return cachedSalt;

  try {
    const stored = await retrieve(SALT_KEY);
    if (stored) {
      cachedSalt = stored;
      return stored;
    }
  } catch (err) {
    const redactorLog = getLogger();
    redactorLog.warn(
      { err },
      'Keychain unavailable for redaction salt — using ephemeral salt. HMAC redaction will not be stable across restarts.',
    );
    const ephemeral = crypto.randomBytes(32).toString('hex');
    cachedSalt = ephemeral;
    return ephemeral;
  }

  const newSalt = crypto.randomBytes(32).toString('hex');
  try {
    await store(SALT_KEY, newSalt);
  } catch (err) {
    const redactorLog = getLogger();
    redactorLog.warn(
      { err },
      'Failed to persist redaction salt to keychain — salt is cached in memory only.',
    );
  }
  cachedSalt = newSalt;
  return newSalt;
}

// ─── PII Detection Patterns ──────────────────────────────────────────

const PII_PATTERNS: { name: string; pattern: RegExp }[] = [
  { name: 'email', pattern: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g },
  { name: 'phone', pattern: /(?:\+\d{1,3}[\s-]?)?\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}/g },
  { name: 'uuid', pattern: /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi },
  { name: 'mongodb_objectid', pattern: /\b[0-9a-f]{24}\b/gi },
  { name: 'jwt', pattern: /eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g },
  { name: 'bearer_token', pattern: /Bearer\s+[A-Za-z0-9_\-.~+/]+=*/gi },
  { name: 'aws_key', pattern: /(?:AKIA|ABIA|ACCA|ASIA)[0-9A-Z]{16}/g },
  { name: 'aws_secret', pattern: /(?:(?<=AKIA[A-Z0-9]{12,}\s*[:=]\s*['"]?)|(?<=aws_secret_access_key\s*[:=]\s*['"]?))[0-9a-zA-Z/+=]{40}/gi },
  { name: 'api_key', pattern: /(?:api[_-]?key|apikey|api_secret|access_token|secret_key)\s*[:=]\s*['"]?([A-Za-z0-9_\-.]{16,})['"]?/gi },
  { name: 'credit_card', pattern: /\b(?:4[0-9]{12}(?:[0-9]{3})?|5[1-5][0-9]{14}|3[47][0-9]{13}|6(?:011|5[0-9]{2})[0-9]{12})\b/g },
  { name: 'ssn', pattern: /\b\d{3}-\d{2}-\d{4}\b/g },
  { name: 'address', pattern: /\b\d{1,5}\s+\w+\s+(?:Street|St|Avenue|Ave|Boulevard|Blvd|Drive|Dr|Lane|Ln|Road|Rd|Way|Court|Ct|Place|Pl)\b/gi },
];

function containsPii(value: string): string | null {
  for (const { name, pattern } of PII_PATTERNS) {
    pattern.lastIndex = 0;
    if (pattern.test(value)) return name;
  }
  return null;
}

function isSafeValue(value: string): boolean {
  // Short integers, booleans, known enums
  if (/^\d{1,5}$/.test(value)) return true;
  if (/^(true|false|null|undefined)$/i.test(value)) return true;
  if (/^[a-z_]{1,30}$/i.test(value)) return true; // enum-like
  return false;
}

// ─── Redaction Strategies ────────────────────────────────────────────

async function hmacRedact(value: string): Promise<string> {
  const salt = await getSalt();
  const hash = crypto.createHmac('sha256', salt).update(value).digest('hex');
  return `[REDACTED:${hash.slice(0, 12)}]`;
}

function maskValue(value: string): string {
  if (value.length <= 4) return '***';
  return `${value.slice(0, 2)}***${value.slice(-2)}`;
}

// ─── Timeout Helper ──────────────────────────────────────────────────
// withTimeout imported from core/utils.ts
// Note: The original local version accepted a thunk () => Promise<T>.
// The canonical version accepts a Promise<T> directly. Callers now
// pass fn() instead of fn.

// ─── Public API ──────────────────────────────────────────────────────

export async function redactString(input: string, timeoutMs = 10000): Promise<string> {
  return withTimeout((async () => {
    if (isSafeValue(input)) return input;

    const piiType = containsPii(input);
    if (piiType) {
      return hmacRedact(input);
    }

    // Sensitive but non-PII: mask if it looks like a token/key
    if (input.length > 20 && /^[A-Za-z0-9_\-./+=]+$/.test(input)) {
      return maskValue(input);
    }

    return input;
  })(), timeoutMs, 'Redaction');
}

export async function redactHeaders(
  headers: Record<string, string>,
  timeoutMs = 10000,
): Promise<Record<string, string>> {
  return withTimeout((async () => {
    const result: Record<string, string> = {};
    const sensitiveHeaders = new Set([
      'authorization', 'cookie', 'set-cookie',
      'x-api-key', 'x-auth-token', 'x-csrf-token',
      'proxy-authorization',
    ]);

    for (const [key, value] of Object.entries(headers)) {
      const lowerKey = key.toLowerCase();
      if (sensitiveHeaders.has(lowerKey)) {
        result[key] = await hmacRedact(value);
      } else {
        result[key] = await redactString(value, timeoutMs);
      }
    }
    return result;
  })(), timeoutMs, 'Redaction');
}

export async function redactBody(
  body: string | undefined,
  timeoutMs = 10000,
): Promise<string | undefined> {
  if (!body) return body;

  return withTimeout((async () => {
    try {
      const parsed = JSON.parse(body);
      const redacted = await redactObject(parsed);
      return JSON.stringify(redacted);
    } catch {
      // Not JSON, redact as string
      return redactString(body, timeoutMs);
    }
  })(), timeoutMs, 'Redaction');
}

const SENSITIVE_FIELD_NAMES = new Set([
  'password', 'passwd', 'secret', 'token', 'api_key', 'apikey',
  'api_secret', 'access_token', 'refresh_token', 'private_key',
  'client_secret', 'credential', 'credentials', 'ssn', 'credit_card',
]);

function isSensitiveFieldName(key: string): boolean {
  return SENSITIVE_FIELD_NAMES.has(key.toLowerCase());
}

async function redactObject(obj: unknown, parentKey?: string): Promise<unknown> {
  if (obj === null || obj === undefined) return obj;

  if (typeof obj === 'string') {
    // If the parent field name is sensitive, always redact the value
    if (parentKey && isSensitiveFieldName(parentKey)) {
      return hmacRedact(obj);
    }
    return redactString(obj);
  }

  if (typeof obj === 'number' || typeof obj === 'boolean') {
    return obj;
  }

  if (Array.isArray(obj)) {
    return Promise.all(obj.map(item => redactObject(item, parentKey)));
  }

  if (typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      result[key] = await redactObject(value, key);
    }
    return result;
  }

  return obj;
}

export interface HarEntry {
  request?: {
    url?: string;
    method?: string;
    headers?: Array<{ name: string; value: string }>;
    postData?: { text?: string; mimeType?: string };
  };
  response?: {
    status?: number;
    headers?: Array<{ name: string; value: string }>;
    content?: { text?: string; mimeType?: string };
  };
}

export async function redactHarEntry(
  entry: HarEntry,
  timeoutMs = 10000,
): Promise<HarEntry> {
  return withTimeout((async () => {
    const result: HarEntry = {};

    if (entry.request) {
      result.request = {
        url: entry.request.url ? await redactUrlParams(entry.request.url) : undefined,
        method: entry.request.method,
        headers: entry.request.headers
          ? await Promise.all(entry.request.headers.map(async h => ({
              name: h.name,
              value: await redactString(h.value),
            })))
          : undefined,
        postData: entry.request.postData
          ? {
              mimeType: entry.request.postData.mimeType,
              text: await redactBody(entry.request.postData.text),
            }
          : undefined,
      };
    }

    if (entry.response) {
      result.response = {
        status: entry.response.status,
        headers: entry.response.headers
          ? await Promise.all(entry.response.headers.map(async h => ({
              name: h.name,
              value: await redactString(h.value),
            })))
          : undefined,
        content: entry.response.content
          ? {
              mimeType: entry.response.content.mimeType,
              text: await redactBody(entry.response.content.text),
            }
          : undefined,
      };
    }

    return result;
  })(), timeoutMs, 'Redaction');
}

async function redactUrlParams(url: string): Promise<string> {
  try {
    const parsed = new URL(url);
    for (const [key, value] of parsed.searchParams.entries()) {
      parsed.searchParams.set(key, await redactString(value));
    }
    return parsed.toString();
  } catch {
    return redactString(url);
  }
}

export async function redactForOutput(
  data: unknown,
  mode: RedactionMode,
  timeoutMs = 10000,
): Promise<unknown> {
  return withTimeout((async () => {
    if (mode === 'agent-safe') {
      // Minimal redaction: only schema-validated output, all PII stripped
      return redactObject(data);
    }

    // developer-debug: redact PII but leave traces for debugging
    if (typeof data === 'string') {
      const piiType = containsPii(data);
      if (piiType) {
        const redacted = await hmacRedact(data);
        return `${redacted} [was:${piiType}]`;
      }
      return data;
    }

    if (typeof data === 'object' && data !== null) {
      if (Array.isArray(data)) {
        return Promise.all(data.map(item => redactForOutput(item, mode)));
      }
      const result: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
        result[key] = await redactForOutput(value, mode);
      }
      return result;
    }

    return data;
  })(), timeoutMs, 'Redaction');
}
