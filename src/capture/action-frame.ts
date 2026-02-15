import * as crypto from 'node:crypto';
import type { ActionFrame } from '../skill/types.js';
import type { AgentDatabase } from '../storage/database.js';
import { getLogger } from '../core/logger.js';
import { filterRequestsNative as filterRequests } from '../native/noise-filter.js';
import { recordFilteredEntries } from './noise-filter.js';
import type { HarEntry } from './har-extractor.js';

const log = getLogger();

// ─── In-Memory Frame State ───────────────────────────────────────────

interface LiveFrame {
  id: string;
  siteId: string;
  name: string;
  inputs?: Record<string, string>;
  startedAt: number;
  entries: HarEntry[];
}

const liveFrames = new Map<string, LiveFrame>();

// ─── Public API ──────────────────────────────────────────────────────

export function startFrame(
  db: AgentDatabase,
  siteId: string,
  name: string,
  inputs?: Record<string, string>,
): string {
  const frameId = crypto.randomUUID();
  const now = Date.now();

  const frame: LiveFrame = {
    id: frameId,
    siteId,
    name,
    inputs,
    startedAt: now,
    entries: [],
  };

  liveFrames.set(frameId, frame);

  db.run(
    `INSERT INTO action_frames (id, site_id, name, started_at, request_count, signal_count, skill_count)
     VALUES (?, ?, ?, ?, 0, 0, 0)`,
    frameId,
    siteId,
    name,
    now,
  );

  log.info({ frameId, siteId, name }, 'Started action frame');
  return frameId;
}

export function addEntriesToFrame(frameId: string, entries: HarEntry[]): void {
  const frame = liveFrames.get(frameId);
  if (!frame) {
    log.warn({ frameId }, 'Cannot add entries to unknown frame');
    return;
  }
  frame.entries.push(...entries);
}

export function stopFrame(
  db: AgentDatabase,
  frameId: string,
): ActionFrame {
  const frame = liveFrames.get(frameId);
  if (!frame) {
    throw new Error(`No live frame with id ${frameId}`);
  }

  liveFrames.delete(frameId);
  const endedAt = Date.now();

  // Filter and record entries
  const { signal, noise, ambiguous } = recordFilteredEntries(
    db,
    frameId,
    frame.entries,
  );

  const requestCount = frame.entries.length;
  const signalCount = signal.length;
  const qualityScore = computeQualityScore(frame.entries, signal, noise, ambiguous);

  db.run(
    `UPDATE action_frames
     SET ended_at = ?, request_count = ?, signal_count = ?, quality_score = ?
     WHERE id = ?`,
    endedAt,
    requestCount,
    signalCount,
    qualityScore,
    frameId,
  );

  const result: ActionFrame = {
    id: frameId,
    siteId: frame.siteId,
    name: frame.name,
    qualityScore,
    startedAt: frame.startedAt,
    endedAt,
    requestCount,
    signalCount,
    skillCount: 0,
  };

  log.info(
    { frameId, requestCount, signalCount, qualityScore },
    'Stopped action frame',
  );

  return result;
}

export function getMainRequests(
  db: AgentDatabase,
  frameId: string,
): Array<{ method: string; url: string; classification: string }> {
  const frame = liveFrames.get(frameId);
  if (!frame) {
    // Frame already stopped — query from DB entries
    const entries = db.all<{
      request_hash: string;
      classification: string;
    }>(
      `SELECT request_hash, classification FROM action_frame_entries
       WHERE frame_id = ? AND classification = 'signal'`,
      frameId,
    );
    return entries.map(e => ({
      method: 'UNKNOWN',
      url: e.request_hash,
      classification: e.classification,
    }));
  }

  // Frame still live — use in-memory entries
  const { signal } = filterRequests(frame.entries);
  return signal.map(e => ({
    method: e.request.method,
    url: e.request.url,
    classification: 'signal',
  }));
}

export function getInputsForFrame(frameId: string): Record<string, string> | undefined {
  return liveFrames.get(frameId)?.inputs;
}

// ─── Quality Scoring ─────────────────────────────────────────────────

function computeQualityScore(
  all: HarEntry[],
  signal: HarEntry[],
  noise: HarEntry[],
  ambiguous: HarEntry[],
): number {
  if (all.length === 0) return 0;

  // Signal ratio: what percentage of requests are signal
  const signalRatio = signal.length / all.length;

  // Candidate endpoint count: more unique endpoints = richer capture
  const uniqueEndpoints = new Set(
    signal.map(e => `${e.request.method}|${new URL(e.request.url).pathname}`),
  );
  const endpointScore = Math.min(uniqueEndpoints.size / 10, 1); // cap at 10

  // Required field entropy: body diversity across signal requests
  const bodySizes = signal
    .map(e => e.request.postData?.text?.length ?? 0)
    .filter(s => s > 0);
  const fieldEntropy = bodySizes.length > 0
    ? Math.min(computeEntropy(bodySizes) / 3, 1)
    : 0.5;

  // Token preflight presence: auth headers in signal requests
  const hasAuth = signal.some(e =>
    e.request.headers.some(h =>
      h.name.toLowerCase() === 'authorization' ||
      h.name.toLowerCase() === 'cookie',
    ),
  );
  const authScore = hasAuth ? 1 : 0.7;

  // Redirect graph complexity: how many redirects are present
  const redirectCount = signal.filter(e =>
    e.response.status >= 300 && e.response.status < 400,
  ).length;
  const redirectScore = redirectCount > 3 ? 0.6 : 1;

  // Weighted average
  const score = (
    signalRatio * 0.30 +
    endpointScore * 0.25 +
    fieldEntropy * 0.15 +
    authScore * 0.15 +
    redirectScore * 0.15
  );

  return Math.round(score * 100) / 100;
}

function computeEntropy(values: number[]): number {
  const total = values.reduce((a, b) => a + b, 0);
  if (total === 0) return 0;

  let entropy = 0;
  for (const v of values) {
    const p = v / total;
    if (p > 0) {
      entropy -= p * Math.log2(p);
    }
  }
  return entropy;
}
