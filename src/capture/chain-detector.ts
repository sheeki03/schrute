import type { RequestChain, ChainStep, ChainStepExtraction } from '../skill/types.js';
import type { StructuredRecord } from './har-extractor.js';
import { getLogger } from '../core/logger.js';

const log = getLogger();

// ─── Public API ──────────────────────────────────────────────────────

export function detectChains(requests: StructuredRecord[]): RequestChain[] {
  if (requests.length < 2) return [];

  // Sort by start time
  const sorted = [...requests].sort((a, b) => a.startedAt - b.startedAt);
  const chains: RequestChain[] = [];

  // Find value propagation chains
  const valueChain = detectValuePropagation(sorted);
  if (valueChain) {
    chains.push(valueChain);
  }

  // Find cookie-based chains
  const cookieChain = detectCookieChain(sorted);
  if (cookieChain && !chainsOverlap(chains, cookieChain)) {
    chains.push(cookieChain);
  }

  log.debug({ chainCount: chains.length }, 'Detected request chains');
  return chains;
}

// ─── Value Propagation Detection ─────────────────────────────────────

function detectValuePropagation(requests: StructuredRecord[]): RequestChain | null {
  const steps: ChainStep[] = [];
  const usedIndices = new Set<number>();

  for (let i = 0; i < requests.length; i++) {
    const responseValues = extractResponseValues(requests[i]);
    if (responseValues.size === 0) continue;

    for (let j = i + 1; j < requests.length; j++) {
      const injections = findInjections(responseValues, requests[j]);

      if (injections.length > 0) {
        if (!usedIndices.has(i)) {
          usedIndices.add(i);
          steps.push({
            skillRef: buildSkillRef(requests[i]),
            extractsFrom: [],
          });
        }

        usedIndices.add(j);
        steps.push({
          skillRef: buildSkillRef(requests[j]),
          extractsFrom: injections,
        });
      }
    }
  }

  if (steps.length < 2) return null;

  return {
    steps,
    canReplayWithCookiesOnly: false,
  };
}

// ─── Cookie Chain Detection ──────────────────────────────────────────

function detectCookieChain(requests: StructuredRecord[]): RequestChain | null {
  const steps: ChainStep[] = [];
  const cookieSetters: Array<{ index: number; cookies: Map<string, string> }> = [];

  // Find responses that set cookies
  for (let i = 0; i < requests.length; i++) {
    const setCookies = extractSetCookies(requests[i]);
    if (setCookies.size > 0) {
      cookieSetters.push({ index: i, cookies: setCookies });
    }
  }

  if (cookieSetters.length === 0) return null;

  // Find subsequent requests that use those cookies
  for (const setter of cookieSetters) {
    for (let j = setter.index + 1; j < requests.length; j++) {
      const reqCookies = extractRequestCookies(requests[j]);
      const matchedCookies: ChainStepExtraction[] = [];

      for (const [name] of setter.cookies) {
        if (reqCookies.has(name)) {
          matchedCookies.push({
            responsePath: `headers.set-cookie.${name}`,
            injectsInto: {
              location: 'header',
              path: `cookie.${name}`,
            },
          });
        }
      }

      if (matchedCookies.length > 0) {
        if (steps.length === 0) {
          steps.push({
            skillRef: buildSkillRef(requests[setter.index]),
            extractsFrom: [],
          });
        }
        steps.push({
          skillRef: buildSkillRef(requests[j]),
          extractsFrom: matchedCookies,
        });
      }
    }
  }

  if (steps.length < 2) return null;

  return {
    steps,
    canReplayWithCookiesOnly: true,
  };
}

// ─── Value Extraction ────────────────────────────────────────────────

function extractResponseValues(record: StructuredRecord): Map<string, string> {
  const values = new Map<string, string>();

  // Extract from response body (JSON)
  if (record.response.body) {
    try {
      const parsed = JSON.parse(record.response.body);
      flattenValues(parsed, 'body', values);
    } catch {
      // non-JSON response, skip
    }
  }

  // Extract from response headers
  for (const [key, value] of Object.entries(record.response.headers)) {
    if (value && value.length > 3 && value.length < 2048) {
      values.set(`headers.${key}`, value);
    }
  }

  return values;
}

function flattenValues(
  obj: unknown,
  prefix: string,
  values: Map<string, string>,
): void {
  if (obj === null || obj === undefined) return;

  if (typeof obj === 'string') {
    // Only track strings that look like tokens/ids (not trivial values)
    if (obj.length > 3 && obj.length < 2048) {
      values.set(prefix, obj);
    }
    return;
  }

  if (typeof obj === 'number') {
    values.set(prefix, String(obj));
    return;
  }

  if (Array.isArray(obj)) {
    for (let i = 0; i < Math.min(obj.length, 10); i++) {
      flattenValues(obj[i], `${prefix}[${i}]`, values);
    }
    return;
  }

  if (typeof obj === 'object') {
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      flattenValues(value, `${prefix}.${key}`, values);
    }
  }
}

function findInjections(
  responseValues: Map<string, string>,
  request: StructuredRecord,
): ChainStepExtraction[] {
  const injections: ChainStepExtraction[] = [];

  for (const [responsePath, value] of responseValues) {
    // Check headers
    for (const [headerKey, headerValue] of Object.entries(request.request.headers)) {
      if (headerValue.includes(value)) {
        injections.push({
          responsePath,
          injectsInto: { location: 'header', path: headerKey },
        });
      }
    }

    // Check query params
    for (const [paramKey, paramValue] of Object.entries(request.request.queryParams)) {
      if (paramValue.includes(value)) {
        injections.push({
          responsePath,
          injectsInto: { location: 'query', path: paramKey },
        });
      }
    }

    // Check body
    if (request.request.body && request.request.body.includes(value)) {
      // Try to find the exact JSON path
      const bodyPath = findJsonPath(request.request.body, value);
      injections.push({
        responsePath,
        injectsInto: { location: 'body', path: bodyPath ?? '$' },
      });
    }
  }

  return injections;
}

function findJsonPath(body: string, value: string): string | null {
  try {
    const parsed = JSON.parse(body);
    return searchJsonPath(parsed, value, '$');
  } catch {
    return null;
  }
}

function searchJsonPath(obj: unknown, target: string, path: string): string | null {
  if (obj === target) return path;
  if (typeof obj === 'number' && String(obj) === target) return path;

  if (typeof obj === 'string' && obj.includes(target)) return path;

  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) {
      const result = searchJsonPath(obj[i], target, `${path}[${i}]`);
      if (result) return result;
    }
  }

  if (typeof obj === 'object' && obj !== null) {
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      const result = searchJsonPath(value, target, `${path}.${key}`);
      if (result) return result;
    }
  }

  return null;
}

// ─── Cookie Helpers ──────────────────────────────────────────────────

function extractSetCookies(record: StructuredRecord): Map<string, string> {
  const cookies = new Map<string, string>();
  const setCookieHeader = record.response.headers['set-cookie'];

  if (!setCookieHeader) return cookies;

  // set-cookie may be concatenated with newlines or commas
  const parts = setCookieHeader.split(/[,\n]/).map(s => s.trim()).filter(Boolean);
  for (const part of parts) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const name = part.slice(0, eq).trim();
    const valueEnd = part.indexOf(';');
    const value = valueEnd === -1 ? part.slice(eq + 1) : part.slice(eq + 1, valueEnd);
    cookies.set(name, value.trim());
  }

  return cookies;
}

function extractRequestCookies(record: StructuredRecord): Map<string, string> {
  const cookies = new Map<string, string>();
  const cookieHeader = record.request.headers['cookie'];
  if (!cookieHeader) return cookies;

  const pairs = cookieHeader.split(';');
  for (const pair of pairs) {
    const eq = pair.indexOf('=');
    if (eq === -1) continue;
    cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
  }

  return cookies;
}

// ─── Helpers ─────────────────────────────────────────────────────────

function buildSkillRef(record: StructuredRecord): string {
  try {
    const url = new URL(record.request.url);
    return `${record.request.method} ${url.pathname}`;
  } catch {
    return `${record.request.method} ${record.request.url}`;
  }
}

function chainsOverlap(existing: RequestChain[], candidate: RequestChain): boolean {
  const existingRefs = new Set<string>();
  for (const chain of existing) {
    for (const step of chain.steps) {
      existingRefs.add(step.skillRef);
    }
  }

  return candidate.steps.some(step => existingRefs.has(step.skillRef));
}
