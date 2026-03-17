import { getLogger } from '../core/logger.js';
import type { NetworkEntry } from '../skill/types.js';
import type { StructuredRecord } from './har-extractor.js';

const log = getLogger();

export interface HarLog {
  version: string;
  creator: { name: string; version: string };
  entries: HarEntry[];
}

export interface HarEntry {
  startedDateTime: string;
  time: number;
  request: {
    method: string;
    url: string;
    httpVersion: string;
    headers: Array<{ name: string; value: string }>;
    queryString: Array<{ name: string; value: string }>;
    bodySize: number;
    postData?: { mimeType: string; text: string };
  };
  response: {
    status: number;
    statusText: string;
    httpVersion: string;
    headers: Array<{ name: string; value: string }>;
    content: { size: number; mimeType: string; text?: string };
    bodySize: number;
    chainCandidates?: Record<string, string>;
  };
  timings: {
    send: number;
    wait: number;
    receive: number;
  };
}

/**
 * Minimal HAR-like projection used for action-frame classification/quality score.
 */
export interface AuditableEntry {
  startedDateTime: string;
  request: {
    method: string;
    url: string;
    headers: Array<{ name: string; value: string }>;
    bodySize: number;
    postData?: { text: string };
  };
  response: {
    status: number;
    headers: Array<{ name: string; value: string }>;
    content: { size: number; mimeType: string };
    bodySize: number;
  };
}

export interface DirectCaptureResult {
  records: StructuredRecord[];
  auditEntries: AuditableEntry[];
  totalCount: number;
}

export interface CapturedResponseBody {
  body?: string;
  bodySize?: number;
  chainCandidates?: Record<string, string>;
}

/**
 * Records HAR entries from CDP network events (via agent-browser).
 * Converts NetworkEntry[] to HAR format for skill generation pipeline.
 */
export class CdpHarRecorder {
  private entries: HarEntry[] = [];
  private recording = false;
  private startTime: number = 0;
  private pendingBodies: Promise<void>[] = [];
  private generation: number = 0;

  start(): void {
    this.generation++;
    this.entries = [];
    this.pendingBodies = [];
    this.recording = true;
    this.startTime = Date.now();
    log.debug('CDP HAR recording started');
  }

  /**
   * Flush all pending body reads, then stop recording and return the HAR log.
   */
  async stop(): Promise<HarLog> {
    const entries = await this.flushAndSeal();
    return {
      version: '1.2',
      creator: { name: 'schrute-cdp', version: '1.0' },
      entries,
    };
  }

  /**
   * Flush all pending body reads and return direct structured records/audit entries.
   * Frees internal entry buffers immediately after conversion.
   */
  async stopAsStructuredRecords(): Promise<DirectCaptureResult> {
    const entries = await this.flushAndSeal();
    const records = entries.map(entry => this.harEntryToStructuredRecord(entry));
    const auditEntries = entries.map(entry => this.harEntryToAuditableEntry(entry));

    return {
      records,
      auditEntries,
      totalCount: entries.length,
    };
  }

  private async flushAndSeal(): Promise<HarEntry[]> {
    // Wait for all pending body reads to complete (best-effort, 5s timeout)
    if (this.pendingBodies.length > 0) {
      await Promise.race([
        Promise.allSettled(this.pendingBodies),
        new Promise(resolve => setTimeout(resolve, 5000)),
      ]);
    }
    this.recording = false;
    this.generation++; // invalidate any still-pending body callbacks from this recording
    this.pendingBodies = [];
    const entries = this.entries;
    this.entries = [];
    log.debug({ entryCount: entries.length }, 'CDP HAR recording stopped');
    return entries;
  }

  isRecording(): boolean {
    return this.recording;
  }

  /**
   * Ingest network entries immediately (without body).
   * Returns the HAR entry index so the body can be patched in later.
   */
  ingestNetworkEntries(entries: NetworkEntry[]): void {
    if (!this.recording) return;

    for (const entry of entries) {
      const harEntry = this.networkEntryToHar(entry);
      this.entries.push(harEntry);
    }
  }

  /**
   * Ingest a network entry immediately, then patch in the body when the
   * promise resolves. The entry is recorded even if the body read fails.
   */
  ingestWithPendingBody(
    entry: NetworkEntry,
    bodyPromise: Promise<CapturedResponseBody | undefined>,
  ): void {
    if (!this.recording) return;

    const harEntry = this.networkEntryToHar(entry);
    const idx = this.entries.length;
    const gen = this.generation;
    this.entries.push(harEntry);

    const pending = bodyPromise.then(body => {
      // Guard: only patch if we're still in the same recording session.
      // A late body from recording A must never mutate recording B's entries.
      if (body !== undefined && this.generation === gen && this.entries[idx]) {
        if (body.body !== undefined) {
          this.entries[idx].response.content.text = body.body;
        }
        if (body.chainCandidates) {
          Object.assign(this.entries[idx].response, {
            chainCandidates: body.chainCandidates,
          });
        }
        const effectiveSize = body.bodySize ?? (body.body !== undefined ? Buffer.byteLength(body.body) : 0);
        this.entries[idx].response.content.size = effectiveSize;
        this.entries[idx].response.bodySize = effectiveSize;
      }
    }).catch(err => log.debug({ err }, 'Response body unavailable during HAR recording'));

    this.pendingBodies.push(pending);
  }

  /**
   * Convert a single NetworkEntry to HAR format.
   */
  private networkEntryToHar(entry: NetworkEntry): HarEntry {
    // Parse URL for query string
    let queryString: Array<{ name: string; value: string }> = [];
    try {
      const url = new URL(entry.url);
      queryString = [...url.searchParams.entries()].map(([name, value]) => ({
        name,
        value,
      }));
    } catch (err) {
      log.debug({ err, url: entry.url }, 'Invalid URL — query params omitted');
    }

    // Convert headers
    const requestHeaders = Object.entries(entry.requestHeaders).map(([name, value]) => ({
      name,
      value,
    }));

    const responseHeaders = Object.entries(entry.responseHeaders).map(([name, value]) => ({
      name,
      value,
    }));

    const contentType =
      entry.responseHeaders['content-type'] ??
      entry.responseHeaders['Content-Type'] ??
      'application/octet-stream';

    const duration = entry.timing.duration;

    return {
      startedDateTime: new Date(entry.timing.startTime).toISOString(),
      time: duration,
      request: {
        method: entry.method,
        url: entry.url,
        httpVersion: 'HTTP/1.1',
        headers: requestHeaders,
        queryString,
        bodySize: entry.requestBody ? Buffer.byteLength(entry.requestBody) : 0,
        ...(entry.requestBody
          ? { postData: { mimeType: 'application/json', text: entry.requestBody } }
          : {}),
      },
      response: {
        status: entry.status,
        statusText: this.statusText(entry.status),
        httpVersion: 'HTTP/1.1',
        headers: responseHeaders,
        content: {
          size: entry.responseBody ? Buffer.byteLength(entry.responseBody) : 0,
          mimeType: contentType,
          text: entry.responseBody,
        },
        bodySize: entry.responseBody ? Buffer.byteLength(entry.responseBody) : 0,
      },
      timings: {
        send: 0,
        wait: duration * 0.8, // approximate
        receive: duration * 0.2,
      },
    };
  }

  private harEntryToStructuredRecord(entry: HarEntry): StructuredRecord {
    const requestHeaders: Record<string, string> = {};
    for (const header of entry.request.headers) {
      requestHeaders[header.name.toLowerCase()] = header.value;
    }

    const responseHeaders: Record<string, string> = {};
    for (const header of entry.response.headers) {
      responseHeaders[header.name.toLowerCase()] = header.value;
    }

    const queryParams: Record<string, string> = {};
    for (const query of entry.request.queryString) {
      queryParams[query.name] = query.value;
    }

    const chainCandidates = (entry.response as { chainCandidates?: Record<string, string> }).chainCandidates;

    return {
      request: {
        method: entry.request.method,
        url: entry.request.url,
        headers: requestHeaders,
        body: entry.request.postData?.text,
        contentType: entry.request.postData?.mimeType ?? requestHeaders['content-type'],
        queryParams,
      },
      response: {
        status: entry.response.status,
        statusText: entry.response.statusText,
        headers: responseHeaders,
        body: chainCandidates ? undefined : entry.response.content.text,
        contentType: entry.response.content.mimeType,
        chainCandidates,
      },
      startedAt: new Date(entry.startedDateTime).getTime(),
      duration: entry.time,
    };
  }

  private harEntryToAuditableEntry(entry: HarEntry): AuditableEntry {
    return {
      startedDateTime: entry.startedDateTime,
      request: {
        method: entry.request.method,
        url: entry.request.url,
        headers: entry.request.headers,
        bodySize: entry.request.bodySize,
        ...(entry.request.postData?.text
          ? { postData: { text: entry.request.postData.text } }
          : {}),
      },
      response: {
        status: entry.response.status,
        headers: entry.response.headers,
        content: {
          size: entry.response.content.size,
          mimeType: entry.response.content.mimeType,
        },
        bodySize: entry.response.bodySize,
      },
    };
  }

  private statusText(status: number): string {
    const texts: Record<number, string> = {
      200: 'OK', 201: 'Created', 204: 'No Content',
      301: 'Moved Permanently', 302: 'Found', 304: 'Not Modified',
      400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden',
      404: 'Not Found', 429: 'Too Many Requests',
      500: 'Internal Server Error', 502: 'Bad Gateway', 503: 'Service Unavailable',
    };
    return texts[status] ?? '';
  }
}
