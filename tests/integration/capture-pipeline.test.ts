import { describe, it, expect } from 'vitest';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseHar, extractRequestResponse } from '../../src/capture/har-extractor.js';
import { filterRequests } from '../../src/capture/noise-filter.js';
import { canonicalizeUrl, canonicalizeRequest } from '../../src/capture/canonicalizer.js';
import { clusterEndpoints, parameterizePath } from '../../src/capture/api-extractor.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const harDir = join(__dirname, '..', 'fixtures', 'har-files');

describe('capture pipeline integration', () => {
  const harPath = join(harDir, 'simple-rest-api.har');

  it('parses HAR file and extracts all entries', () => {
    const har = parseHar(harPath);
    expect(har.log).toBeDefined();
    expect(har.log.entries).toBeInstanceOf(Array);
    expect(har.log.entries.length).toBe(5);
  });

  it('extracts structured records from HAR entries', () => {
    const har = parseHar(harPath);
    const records = har.log.entries.map(extractRequestResponse);

    expect(records).toHaveLength(5);

    const first = records[0];
    expect(first.request.method).toBe('GET');
    expect(first.request.url).toContain('/api/users');
    expect(first.response.status).toBe(200);
    expect(first.duration).toBeGreaterThan(0);
  });

  it('filters noise from signal entries', () => {
    const har = parseHar(harPath);
    const result = filterRequests(har.log.entries);

    // All entries in simple-rest-api.har are API calls, no noise
    expect(result.signal.length).toBeGreaterThan(0);
    expect(result.noise).toHaveLength(0);
    // The REST API entries should all be signal
    expect(result.signal.length).toBe(5);
  });

  it('canonicalizes URLs by stripping tracking params and sorting query params', () => {
    const har = parseHar(harPath);
    const records = har.log.entries.map(extractRequestResponse);

    for (const rec of records) {
      const canonical = canonicalizeUrl(rec.request.url);
      // Should not contain tracking params
      expect(canonical).not.toContain('utm_source');
      expect(canonical).not.toContain('fbclid');
      // URL should still be valid
      expect(() => new URL(canonical)).not.toThrow();
    }

    // Specifically check the paginated request preserves page/limit
    const paginatedRecord = records.find(r => r.request.url.includes('page=2'));
    if (paginatedRecord) {
      const canonical = canonicalizeUrl(paginatedRecord.request.url);
      expect(canonical).toContain('page=2');
      expect(canonical).toContain('limit=10');
    }
  });

  it('canonicalizes requests including body processing', () => {
    const har = parseHar(harPath);
    const records = har.log.entries.map(extractRequestResponse);
    const postRecord = records.find(r => r.request.method === 'POST');
    expect(postRecord).toBeDefined();

    const canonical = canonicalizeRequest(postRecord!.request);
    expect(canonical.method).toBe('POST');
    expect(canonical.canonicalUrl).toContain('/api/users');
    // JSON body should be canonicalized (sorted keys, ephemeral keys stripped)
    if (canonical.canonicalBody) {
      const parsed = JSON.parse(canonical.canonicalBody);
      expect(parsed).toHaveProperty('name');
      expect(parsed).toHaveProperty('email');
    }
  });

  it('clusters endpoints and parameterizes paths', () => {
    const har = parseHar(harPath);
    const records = har.log.entries.map(extractRequestResponse);
    const clusters = clusterEndpoints(records);

    // Should have at least 3 clusters: GET /api/users, GET /api/users/{id}, POST /api/users, PUT /api/users/{id}
    expect(clusters.length).toBeGreaterThanOrEqual(3);

    // Check that numeric IDs are parameterized
    const clusterWithParam = clusters.find(c => c.pathTemplate.includes('{id}'));
    expect(clusterWithParam).toBeDefined();
    expect(clusterWithParam!.pathTemplate).toContain('{id}');
  });

  it('full pipeline: HAR -> filter -> canonicalize -> cluster produces correct endpoint count', () => {
    const har = parseHar(harPath);

    // Step 1: Filter
    const { signal } = filterRequests(har.log.entries);
    expect(signal.length).toBeGreaterThan(0);

    // Step 2: Extract structured records from signal entries
    const records = signal.map(extractRequestResponse);

    // Step 3: Canonicalize each request
    const canonicalized = records.map(rec => ({
      ...rec,
      request: {
        ...rec.request,
        url: canonicalizeUrl(rec.request.url),
      },
    }));

    // Step 4: Cluster endpoints
    const clusters = clusterEndpoints(canonicalized);

    // Verify we have reasonable clusters
    expect(clusters.length).toBeGreaterThanOrEqual(3);
    expect(clusters.length).toBeLessThanOrEqual(6);

    // Each cluster should have at least one request
    for (const cluster of clusters) {
      expect(cluster.requests.length).toBeGreaterThan(0);
      expect(cluster.method).toBeTruthy();
      expect(cluster.pathTemplate).toBeTruthy();
    }
  });

  it('parameterizes UUIDs and numeric IDs in paths', () => {
    expect(parameterizePath('/api/users/123')).toBe('/api/users/{id}');
    expect(parameterizePath('/api/users/550e8400-e29b-41d4-a716-446655440000')).toBe('/api/users/{uuid}');
    expect(parameterizePath('/api/users')).toBe('/api/users');
  });
});
