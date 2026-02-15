import * as fs from 'node:fs';
import { getLogger } from '../core/logger.js';

const log = getLogger();

// ─── HAR 1.2 Types ───────────────────────────────────────────────────

export interface HarHeader {
  name: string;
  value: string;
}

export interface HarQueryParam {
  name: string;
  value: string;
}

export interface HarPostData {
  mimeType: string;
  text?: string;
  params?: Array<{ name: string; value: string }>;
}

export interface HarContent {
  size: number;
  mimeType: string;
  text?: string;
  encoding?: string;
}

export interface HarTimings {
  blocked?: number;
  dns?: number;
  connect?: number;
  send: number;
  wait: number;
  receive: number;
  ssl?: number;
}

export interface HarRequest {
  method: string;
  url: string;
  httpVersion: string;
  headers: HarHeader[];
  queryString: HarQueryParam[];
  postData?: HarPostData;
  headersSize: number;
  bodySize: number;
}

export interface HarResponse {
  status: number;
  statusText: string;
  httpVersion: string;
  headers: HarHeader[];
  content: HarContent;
  redirectURL: string;
  headersSize: number;
  bodySize: number;
}

export interface HarEntry {
  startedDateTime: string;
  time: number;
  request: HarRequest;
  response: HarResponse;
  timings: HarTimings;
  serverIPAddress?: string;
  connection?: string;
  _resourceType?: string;
}

export interface HarPage {
  startedDateTime: string;
  id: string;
  title: string;
}

export interface HarLog {
  version: string;
  creator: { name: string; version: string };
  pages?: HarPage[];
  entries: HarEntry[];
}

export interface HarData {
  log: HarLog;
}

// ─── Structured Record ───────────────────────────────────────────────

export interface StructuredRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
  contentType?: string;
  queryParams: Record<string, string>;
}

export interface StructuredResponse {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body?: string;
  contentType?: string;
}

export interface StructuredRecord {
  request: StructuredRequest;
  response: StructuredResponse;
  startedAt: number;
  duration: number;
  serverIp?: string;
}

// ─── Public API ──────────────────────────────────────────────────────

export function parseHar(harPath: string): HarData {
  const raw = fs.readFileSync(harPath, 'utf-8');
  const parsed = JSON.parse(raw) as HarData;

  if (!parsed.log) {
    throw new Error('Invalid HAR file: missing "log" property');
  }
  if (!Array.isArray(parsed.log.entries)) {
    throw new Error('Invalid HAR file: missing "log.entries" array');
  }

  log.debug({ path: harPath, entries: parsed.log.entries.length }, 'Parsed HAR file');
  return parsed;
}

export function filterByTimeWindow(
  entries: HarEntry[],
  startTime: number,
  endTime: number,
): HarEntry[] {
  return entries.filter(entry => {
    const ts = new Date(entry.startedDateTime).getTime();
    return ts >= startTime && ts <= endTime;
  });
}

export function extractRequestResponse(entry: HarEntry): StructuredRecord {
  const headers: Record<string, string> = {};
  for (const h of entry.request.headers) {
    headers[h.name.toLowerCase()] = h.value;
  }

  const queryParams: Record<string, string> = {};
  for (const q of entry.request.queryString) {
    queryParams[q.name] = q.value;
  }

  const respHeaders: Record<string, string> = {};
  for (const h of entry.response.headers) {
    respHeaders[h.name.toLowerCase()] = h.value;
  }

  return {
    request: {
      method: entry.request.method,
      url: entry.request.url,
      headers,
      body: entry.request.postData?.text,
      contentType: entry.request.postData?.mimeType ?? headers['content-type'],
      queryParams,
    },
    response: {
      status: entry.response.status,
      statusText: entry.response.statusText,
      headers: respHeaders,
      body: entry.response.content.text,
      contentType: entry.response.content.mimeType,
    },
    startedAt: new Date(entry.startedDateTime).getTime(),
    duration: entry.time,
    serverIp: entry.serverIPAddress,
  };
}
