import { describe, it, expect, beforeEach } from 'vitest';
import { injectIdempotencyKey, IdempotencyTracker } from '../../src/replay/idempotency.js';
import type { SealedFetchRequest, SkillSpec } from '../../src/skill/types.js';

function makeRequest(overrides: Partial<SealedFetchRequest> = {}): SealedFetchRequest {
  return {
    url: 'https://api.example.com/orders',
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{"item":"widget"}',
    ...overrides,
  };
}

function makeSkill(overrides: Partial<SkillSpec> = {}): SkillSpec {
  return {
    id: 'example.create_order.v1',
    version: 1,
    status: 'active',
    currentTier: 'tier_3',
    tierLock: null,
    allowedDomains: ['api.example.com'],
    requiredCapabilities: [],
    parameters: [],
    validation: { semanticChecks: [], customInvariants: [] },
    redaction: { piiClassesFound: [], fieldsRedacted: 0 },
    replayStrategy: 'prefer_tier_1',
    sideEffectClass: 'non-idempotent',
    sampleCount: 5,
    consecutiveValidations: 5,
    confidence: 0.9,
    method: 'POST',
    pathTemplate: '/orders',
    inputSchema: {},
    isComposite: false,
    siteId: 'example.com',
    name: 'create order',
    successRate: 1.0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  } as SkillSpec;
}

describe('idempotency', () => {
  describe('injectIdempotencyKey', () => {
    it('injects Idempotency-Key for non-idempotent operations', () => {
      const req = makeRequest();
      const skill = makeSkill();
      const tracker = new IdempotencyTracker();

      const result = injectIdempotencyKey(req, skill, tracker);

      expect(result.headers['Idempotency-Key']).toBeDefined();
      expect(result.headers['Idempotency-Key']).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
    });

    it('does not inject for read-only operations', () => {
      const req = makeRequest();
      const skill = makeSkill({ sideEffectClass: 'read-only' });
      const tracker = new IdempotencyTracker();

      const result = injectIdempotencyKey(req, skill, tracker);

      expect(result.headers['Idempotency-Key']).toBeUndefined();
      expect(result).toBe(req); // same reference — no change
    });

    it('does not inject for idempotent operations', () => {
      const req = makeRequest();
      const skill = makeSkill({ sideEffectClass: 'idempotent' });
      const tracker = new IdempotencyTracker();

      const result = injectIdempotencyKey(req, skill, tracker);

      expect(result.headers['Idempotency-Key']).toBeUndefined();
    });

    it('preserves existing idempotency header', () => {
      const req = makeRequest({
        headers: {
          'content-type': 'application/json',
          'Idempotency-Key': 'existing-key-123',
        },
      });
      const skill = makeSkill();
      const tracker = new IdempotencyTracker();

      const result = injectIdempotencyKey(req, skill, tracker);

      expect(result.headers['Idempotency-Key']).toBe('existing-key-123');
    });

    it('detects X-Idempotency-Key from skill headers', () => {
      const req = makeRequest();
      const skill = makeSkill({
        requiredHeaders: { 'X-Idempotency-Key': '' },
      });
      const tracker = new IdempotencyTracker();

      const result = injectIdempotencyKey(req, skill, tracker);

      expect(result.headers['X-Idempotency-Key']).toBeDefined();
    });

    it('records generated keys in tracker', () => {
      const tracker = new IdempotencyTracker();
      const req = makeRequest();
      const skill = makeSkill();

      expect(tracker.size).toBe(0);
      injectIdempotencyKey(req, skill, tracker);
      expect(tracker.size).toBe(1);
    });
  });

  describe('IdempotencyTracker', () => {
    let tracker: IdempotencyTracker;

    beforeEach(() => {
      tracker = new IdempotencyTracker();
    });

    it('check returns false for unknown keys', () => {
      expect(tracker.check('unknown-key')).toBe(false);
    });

    it('check returns true for recorded keys', () => {
      tracker.record('key-1', 'skill.v1');
      expect(tracker.check('key-1')).toBe(true);
    });

    it('clear removes all keys', () => {
      tracker.record('key-1', 'skill.v1');
      tracker.record('key-2', 'skill.v1');
      expect(tracker.size).toBe(2);

      tracker.clear();
      expect(tracker.size).toBe(0);
      expect(tracker.check('key-1')).toBe(false);
    });

    it('expires keys after TTL', () => {
      // Create tracker with 1ms TTL
      const shortTracker = new IdempotencyTracker(1);
      shortTracker.record('key-1', 'skill.v1');

      // Wait for expiry
      const start = Date.now();
      while (Date.now() - start < 5) {
        // busy wait
      }

      expect(shortTracker.check('key-1')).toBe(false);
    });
  });
});
