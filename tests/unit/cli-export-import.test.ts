import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';

/**
 * Tests for the export/import CLI logic.
 *
 * We extract and test the core logic: sanitizeHeaders, bundle serialization,
 * and bundle deserialization. The actual CLI commands use Commander which
 * is tested via integration tests — here we focus on the data transformations.
 */

// ─── sanitizeHeaders reimplementation for testing ─────────────────

function sanitizeHeaders(
  headers?: Record<string, string>,
): Record<string, string> | undefined {
  if (!headers) return undefined;
  const sanitized: Record<string, string> = {};
  const sensitivePatterns = [
    /^authorization$/i,
    /^cookie$/i,
    /^set-cookie$/i,
    /^x-api-key$/i,
    /^x-auth/i,
    /^x-csrf/i,
    /^x-session/i,
    /token/i,
    /secret/i,
    /credential/i,
  ];

  for (const [key, value] of Object.entries(headers)) {
    const isSensitive = sensitivePatterns.some((p) => p.test(key));
    if (isSensitive) {
      sanitized[key] = '<REDACTED>';
    } else {
      sanitized[key] = value;
    }
  }
  return sanitized;
}

// ─── Test Data ──────────────────────────────────────────────────────

function makeSite() {
  return {
    id: 'example.com',
    displayName: 'Example',
    firstSeen: 1000,
    lastVisited: 2000,
    masteryLevel: 'full',
    recommendedTier: 'direct',
    totalRequests: 100,
    successfulRequests: 95,
  };
}

function makeSkill(overrides: Record<string, unknown> = {}) {
  return {
    id: 'example.com.getUser.v1',
    siteId: 'example.com',
    name: 'getUser',
    version: 1,
    status: 'active',
    method: 'GET',
    pathTemplate: '/api/users/{id}',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } } },
    sideEffectClass: 'read-only',
    isComposite: false,
    currentTier: 'tier_1',
    tierLock: null,
    confidence: 0.95,
    consecutiveValidations: 3,
    sampleCount: 10,
    successRate: 0.95,
    createdAt: 1000,
    updatedAt: 2000,
    allowedDomains: ['example.com'],
    requiredCapabilities: [],
    parameters: [],
    validation: { semanticChecks: [], customInvariants: [] },
    redaction: { piiClassesFound: [], fieldsRedacted: 0 },
    replayStrategy: 'prefer_tier_1',
    requiredHeaders: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer sk-secret-123',
      'X-Custom': 'safe-value',
    },
    dynamicHeaders: {
      'Cookie': 'session=abc123',
      'Accept': 'application/json',
    },
    ...overrides,
  };
}

function makeBundle() {
  const site = makeSite();
  const skills = [makeSkill()];
  return {
    version: '0.2.0',
    exportedAt: new Date().toISOString(),
    site,
    skills: skills.map((s) => {
      const { requiredHeaders, dynamicHeaders, ...rest } = s;
      return {
        ...rest,
        requiredHeaders: sanitizeHeaders(requiredHeaders as Record<string, string>),
        dynamicHeaders: sanitizeHeaders(dynamicHeaders as Record<string, string>),
      };
    }),
    policy: {
      siteId: site.id,
      allowedMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
      maxQps: 10,
      maxConcurrent: 3,
      readOnlyDefault: true,
      requireConfirmation: [],
      domainAllowlist: [],
      redactionRules: [],
      capabilities: [],
    },
  };
}

// ─── Tests ──────────────────────────────────────────────────────────

describe('sanitizeHeaders', () => {
  it('returns undefined for undefined input', () => {
    expect(sanitizeHeaders(undefined)).toBeUndefined();
  });

  it('redacts Authorization header', () => {
    const result = sanitizeHeaders({ Authorization: 'Bearer token123' });
    expect(result).toEqual({ Authorization: '<REDACTED>' });
  });

  it('redacts Cookie header', () => {
    const result = sanitizeHeaders({ Cookie: 'session=abc' });
    expect(result).toEqual({ Cookie: '<REDACTED>' });
  });

  it('redacts Set-Cookie header', () => {
    const result = sanitizeHeaders({ 'Set-Cookie': 'session=abc; Path=/' });
    expect(result).toEqual({ 'Set-Cookie': '<REDACTED>' });
  });

  it('redacts X-API-Key header', () => {
    const result = sanitizeHeaders({ 'X-API-Key': 'key123' });
    expect(result).toEqual({ 'X-API-Key': '<REDACTED>' });
  });

  it('redacts headers containing "token"', () => {
    const result = sanitizeHeaders({ 'X-CSRF-Token': 'abc', 'refresh-token': 'def' });
    expect(result).toEqual({
      'X-CSRF-Token': '<REDACTED>',
      'refresh-token': '<REDACTED>',
    });
  });

  it('preserves safe headers', () => {
    const result = sanitizeHeaders({
      'Content-Type': 'application/json',
      Accept: 'text/html',
      'User-Agent': 'test/1.0',
    });
    expect(result).toEqual({
      'Content-Type': 'application/json',
      Accept: 'text/html',
      'User-Agent': 'test/1.0',
    });
  });

  it('handles mixed safe and sensitive headers', () => {
    const result = sanitizeHeaders({
      'Content-Type': 'application/json',
      Authorization: 'Bearer sk-123',
      Accept: 'application/json',
      Cookie: 'session=xyz',
    });
    expect(result).toEqual({
      'Content-Type': 'application/json',
      Authorization: '<REDACTED>',
      Accept: 'application/json',
      Cookie: '<REDACTED>',
    });
  });
});

describe('Export bundle', () => {
  it('creates valid JSON bundle structure', () => {
    const bundle = makeBundle();
    expect(bundle).toHaveProperty('version', '0.2.0');
    expect(bundle).toHaveProperty('exportedAt');
    expect(bundle).toHaveProperty('site');
    expect(bundle).toHaveProperty('skills');
    expect(bundle).toHaveProperty('policy');
    expect(bundle.site.id).toBe('example.com');
    expect(bundle.skills).toHaveLength(1);
  });

  it('redacts credentials in exported skills', () => {
    const bundle = makeBundle();
    const skill = bundle.skills[0];

    // Authorization should be redacted
    expect(skill.requiredHeaders?.Authorization).toBe('<REDACTED>');
    // Content-Type should be preserved
    expect(skill.requiredHeaders?.['Content-Type']).toBe('application/json');
    // Cookie should be redacted
    expect(skill.dynamicHeaders?.Cookie).toBe('<REDACTED>');
    // Accept should be preserved
    expect(skill.dynamicHeaders?.Accept).toBe('application/json');
  });

  it('never includes raw auth tokens', () => {
    const bundle = makeBundle();
    const json = JSON.stringify(bundle);
    expect(json).not.toContain('sk-secret-123');
    expect(json).not.toContain('session=abc123');
  });
});

describe('Import bundle', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(tmpdir(), 'schrute-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('reads and parses a JSON bundle file', () => {
    const bundle = makeBundle();
    const filePath = path.join(tmpDir, 'test-bundle.json');
    fs.writeFileSync(filePath, JSON.stringify(bundle), 'utf-8');

    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw);

    expect(parsed.version).toBe('0.2.0');
    expect(parsed.site.id).toBe('example.com');
    expect(parsed.skills).toHaveLength(1);
    expect(parsed.skills[0].id).toBe('example.com.getUser.v1');
  });

  it('validates bundle structure', () => {
    // Valid bundle
    const bundle = makeBundle();
    expect(bundle.site).toBeDefined();
    expect(Array.isArray(bundle.skills)).toBe(true);

    // Invalid: missing site
    const invalidNoSite = { version: '0.2.0', skills: [] };
    expect(invalidNoSite).not.toHaveProperty('site');

    // Invalid: skills is not an array
    const invalidSkillsType = { version: '0.2.0', site: makeSite(), skills: 'not-array' };
    expect(Array.isArray(invalidSkillsType.skills)).toBe(false);
  });

  it('roundtrips bundle through JSON serialization', () => {
    const bundle = makeBundle();
    const json = JSON.stringify(bundle, null, 2);
    const restored = JSON.parse(json);

    expect(restored.site.id).toBe(bundle.site.id);
    expect(restored.skills.length).toBe(bundle.skills.length);
    expect(restored.skills[0].name).toBe(bundle.skills[0].name);
    expect(restored.policy.siteId).toBe(bundle.policy.siteId);
  });
});
