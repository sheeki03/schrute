import { getLogger } from '../core/logger.js';
import { typeOf } from '../core/utils.js';
import type { StructuredRecord, StructuredRequest } from './har-extractor.js';
import type { PathTrie } from './path-trie.js';

const log = getLogger();

// ─── Types ───────────────────────────────────────────────────────────

export interface EndpointCluster {
  method: string;
  pathTemplate: string;
  requests: StructuredRecord[];
  commonHeaders: Record<string, string>;
  commonQueryParams: string[];
  bodyShape?: Record<string, string>; // field -> type
}

export interface ScoredCluster extends EndpointCluster {
  utilityScore: number;
}

// ─── Path Parameterization ───────────────────────────────────────────

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NUMERIC_PATTERN = /^\d+$/;
const HASH_PATTERN = /^[0-9a-f]{16,64}$/i;
const BASE64_ID_PATTERN = /^[A-Za-z0-9_-]{20,}={0,2}$/;

export function parameterizePath(urlPath: string): string {
  const segments = urlPath.split('/');
  return segments
    .map(seg => {
      if (!seg) return seg;
      if (UUID_PATTERN.test(seg)) return '{uuid}';
      if (NUMERIC_PATTERN.test(seg)) return '{id}';
      if (HASH_PATTERN.test(seg)) return '{hash}';
      if (BASE64_ID_PATTERN.test(seg) && seg.length > 20) return '{id}';
      return seg;
    })
    .join('/');
}

// ─── Clustering ──────────────────────────────────────────────────────

export function clusterEndpoints(requests: StructuredRecord[], trie?: PathTrie): EndpointCluster[] {
  const clusterMap = new Map<string, StructuredRecord[]>();

  for (const rec of requests) {
    let urlPath: string;
    try {
      urlPath = new URL(rec.request.url).pathname;
    } catch {
      continue;
    }

    let template = parameterizePath(urlPath);
    if (trie) {
      try {
        const host = new URL(rec.request.url).hostname;
        trie.insert(host, template);
        template = trie.parameterize(host, template);
      } catch { /* URL parse failure — use un-trieified template */ }
    }
    const key = `${rec.request.method.toUpperCase()}|${template}`;

    let cluster = clusterMap.get(key);
    if (!cluster) {
      cluster = [];
      clusterMap.set(key, cluster);
    }
    cluster.push(rec);
  }

  const clusters: EndpointCluster[] = [];

  for (const [key, recs] of clusterMap) {
    const [method, pathTemplate] = key.split('|', 2);

    const commonHeaders = extractCommonHeaders(recs.map(r => r.request));
    const commonQueryParams = extractCommonQueryParams(recs.map(r => r.request));
    const bodyShape = inferBodyShape(recs.map(r => r.request));

    clusters.push({
      method,
      pathTemplate,
      requests: recs,
      commonHeaders,
      commonQueryParams,
      bodyShape,
    });
  }

  log.debug({ clusterCount: clusters.length }, 'Clustered endpoints');
  return clusters;
}

// ─── Cluster Utility Ranking ────────────────────────────────────────

const GARBAGE_SEGMENT_HEX_RE = /^[0-9a-f]{16,}$/i;
const GARBAGE_SEGMENT_TOKEN_RE = /^[A-Za-z0-9_-]{20,}$/;

export function scoreAndRankClusters(
  clusters: EndpointCluster[],
  maxClusters: number,
): ScoredCluster[] {
  if (maxClusters <= 0 || clusters.length === 0) return [];

  const scored = clusters.map(cluster => {
    const segments = cluster.pathTemplate.split('/').filter(Boolean);
    const pathSpecificity = Math.min(segments.length / 5, 1);

    const uniqueBodyFingerprints = new Set(
      cluster.requests
        .map(rec => rec.request.body)
        .filter((body): body is string => typeof body === 'string' && body.length > 0),
    ).size;
    const sampleDiversity = Math.min(uniqueBodyFingerprints / 3, 1);

    const methodWeight = methodUtilityWeight(cluster.method);

    const authPresent = cluster.requests.some(rec => {
      const keys = Object.keys(rec.request.headers);
      return keys.some(key => {
        const normalized = key.toLowerCase();
        return normalized === 'authorization' || normalized === 'cookie';
      });
    });
    const authScore = authPresent ? 1 : 0.5;

    const bodyComplexity = Math.min(Object.keys(cluster.bodyShape ?? {}).length / 5, 1);

    const successful = cluster.requests.filter(rec =>
      rec.response.status >= 200 && rec.response.status < 300,
    ).length;
    const successRate = cluster.requests.length > 0
      ? successful / cluster.requests.length
      : 0;

    const rawScore = (
      pathSpecificity * 0.25 +
      sampleDiversity * 0.20 +
      methodWeight * 0.15 +
      authScore * 0.15 +
      bodyComplexity * 0.15 +
      successRate * 0.10
    );

    const penalty = hasGarbageTerminalSegment(cluster.pathTemplate) ? 0.5 : 1;
    const utilityScore = Number((rawScore * penalty).toFixed(6));

    return {
      ...cluster,
      utilityScore,
    };
  });

  scored.sort((a, b) => {
    if (b.utilityScore !== a.utilityScore) {
      return b.utilityScore - a.utilityScore;
    }
    const aKey = `${a.method}|${a.pathTemplate}`;
    const bKey = `${b.method}|${b.pathTemplate}`;
    return aKey.localeCompare(bKey);
  });

  return scored.slice(0, maxClusters);
}

// ─── Header Extraction ───────────────────────────────────────────────

const SKIP_HEADERS = new Set([
  'host', 'connection', 'accept-encoding', 'content-length',
  'user-agent', 'referer', 'origin', 'sec-fetch-site',
  'sec-fetch-mode', 'sec-fetch-dest', 'sec-ch-ua',
  'sec-ch-ua-mobile', 'sec-ch-ua-platform',
  'sec-fetch-user', 'upgrade-insecure-requests', 'priority',
]);

function extractCommonHeaders(requests: StructuredRequest[]): Record<string, string> {
  if (requests.length === 0) return {};

  const firstHeaders = requests[0].headers;
  const common: Record<string, string> = {};

  for (const [key, value] of Object.entries(firstHeaders)) {
    if (SKIP_HEADERS.has(key.toLowerCase())) continue;
    // HTTP/2 pseudo-headers are transport-level, not API headers
    if (key.startsWith(':')) continue;

    const allMatch = requests.every(r => r.headers[key] === value);
    if (allMatch) {
      common[key] = value;
    }
  }

  return common;
}

function extractCommonQueryParams(requests: StructuredRequest[]): string[] {
  if (requests.length === 0) return [];

  const first = requests[0].queryParams;
  return Object.keys(first).filter(key =>
    requests.every(r => key in r.queryParams),
  );
}

// ─── Body Shape Inference ────────────────────────────────────────────

function inferBodyShape(requests: StructuredRequest[]): Record<string, string> | undefined {
  const bodies = requests
    .filter(r => r.body)
    .map(r => {
      try {
        return JSON.parse(r.body!);
      } catch {
        return null;
      }
    })
    .filter((b): b is Record<string, unknown> => b !== null && typeof b === 'object' && !Array.isArray(b));

  if (bodies.length === 0) return undefined;

  const shape: Record<string, string> = {};
  const allKeys = new Set<string>();

  for (const body of bodies) {
    for (const key of Object.keys(body)) {
      allKeys.add(key);
    }
  }

  for (const key of allKeys) {
    const types = new Set<string>();
    for (const body of bodies) {
      if (key in body) {
        types.add(typeOf(body[key]));
      }
    }
    shape[key] = types.size === 1 ? [...types][0] : 'mixed';
  }

  return shape;
}

function methodUtilityWeight(method: string): number {
  const normalized = method.toUpperCase();
  if (normalized === 'GET') return 1;
  if (normalized === 'POST') return 0.8;
  if (normalized === 'PUT' || normalized === 'PATCH') return 0.7;
  if (normalized === 'DELETE') return 0.6;
  if (normalized === 'HEAD') return 0.3;
  return 0.5;
}

function hasGarbageTerminalSegment(pathTemplate: string): boolean {
  const segments = pathTemplate.split('/').filter(Boolean);
  if (segments.length === 0) return false;
  const last = segments[segments.length - 1];
  return GARBAGE_SEGMENT_HEX_RE.test(last) || GARBAGE_SEGMENT_TOKEN_RE.test(last);
}
