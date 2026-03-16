import { getLogger } from '../core/logger.js';
import type { NetworkEntry } from '../skill/types.js';

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
  };
  timings: {
    send: number;
    wait: number;
    receive: number;
  };
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
    log.debug({ entryCount: this.entries.length }, 'CDP HAR recording stopped');
    return {
      version: '1.2',
      creator: { name: 'schrute-cdp', version: '1.0' },
      entries: [...this.entries],
    };
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
  ingestWithPendingBody(entry: NetworkEntry, bodyPromise: Promise<string | undefined>): void {
    if (!this.recording) return;

    const harEntry = this.networkEntryToHar(entry);
    const idx = this.entries.length;
    const gen = this.generation;
    this.entries.push(harEntry);

    const pending = bodyPromise.then(body => {
      // Guard: only patch if we're still in the same recording session.
      // A late body from recording A must never mutate recording B's entries.
      if (body !== undefined && this.generation === gen && this.entries[idx]) {
        this.entries[idx].response.content.text = body;
        this.entries[idx].response.content.size = Buffer.byteLength(body);
        this.entries[idx].response.bodySize = Buffer.byteLength(body);
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
