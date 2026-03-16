import { describe, it, expect } from 'vitest';
import { validateImportableSkill, validateImportableSite } from '../../src/storage/import-validator.js';

describe('validateImportableSkill', () => {
  function validSkill() {
    return {
      id: 'example.com.get_users.v1',
      siteId: 'example.com',
      name: 'get_users',
      method: 'GET',
      pathTemplate: '/api/users',
      version: 1,
      status: 'active',
      currentTier: 'tier_1',
      sideEffectClass: 'read-only',
      replayStrategy: 'prefer_tier_1',
    };
  }

  it('accepts a valid skill', () => {
    const result = validateImportableSkill(validSkill());
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('rejects non-object input', () => {
    const result = validateImportableSkill('not-an-object');
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('skill is not an object');
  });

  it('rejects missing required fields', () => {
    const result = validateImportableSkill({});
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('id must be a non-empty string');
    expect(result.errors).toContain('siteId must be a non-empty string');
    expect(result.errors).toContain('method must be a string');
    expect(result.errors).toContain('pathTemplate must be a string');
    expect(result.errors).toContain('version must be a number');
  });

  it('rejects invalid status enum', () => {
    const result = validateImportableSkill({ ...validSkill(), status: 'invalid_status' });
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('invalid status');
  });

  it('rejects invalid currentTier enum', () => {
    const result = validateImportableSkill({ ...validSkill(), currentTier: 'tier_99' });
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('invalid currentTier');
  });

  it('rejects invalid sideEffectClass enum', () => {
    const result = validateImportableSkill({ ...validSkill(), sideEffectClass: 'destroy' });
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('invalid sideEffectClass');
  });

  it('rejects invalid replayStrategy enum', () => {
    const result = validateImportableSkill({ ...validSkill(), replayStrategy: 'random' });
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('invalid replayStrategy');
  });

  it('rejects invalid authType enum', () => {
    const result = validateImportableSkill({ ...validSkill(), authType: 'kerberos' });
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('invalid authType');
  });

  // ─── tierLock validation ──────────────────────────────────────
  describe('tierLock', () => {
    it('accepts null tierLock', () => {
      const result = validateImportableSkill({ ...validSkill(), tierLock: null });
      expect(result.valid).toBe(true);
    });

    it('rejects non-object tierLock', () => {
      const result = validateImportableSkill({ ...validSkill(), tierLock: 'locked' });
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain('tierLock must be an object');
    });

    it('rejects permanent tierLock missing required fields', () => {
      const result = validateImportableSkill({
        ...validSkill(),
        tierLock: { type: 'permanent' },
      });
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain('missing required fields "reason" and "evidence"');
    });

    it('accepts valid permanent tierLock', () => {
      const result = validateImportableSkill({
        ...validSkill(),
        tierLock: { type: 'permanent', reason: 'js_computed', evidence: 'x-sig' },
      });
      expect(result.valid).toBe(true);
    });

    it('rejects temporary_demotion tierLock missing fields', () => {
      const result = validateImportableSkill({
        ...validSkill(),
        tierLock: { type: 'temporary_demotion' },
      });
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain('missing required fields "since" and "demotions"');
    });

    it('rejects unknown tierLock type', () => {
      const result = validateImportableSkill({
        ...validSkill(),
        tierLock: { type: 'unknown_type' },
      });
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain('unknown type');
    });
  });

  // ─── allowedDomains ───────────────────────────────────────────
  it('rejects non-array allowedDomains', () => {
    const result = validateImportableSkill({ ...validSkill(), allowedDomains: 'example.com' });
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('allowedDomains must be an array');
  });

  it('rejects non-string items in allowedDomains', () => {
    const result = validateImportableSkill({ ...validSkill(), allowedDomains: [123] });
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('allowedDomains[0] must be a string');
  });
});

describe('validateImportableSite', () => {
  function validSite() {
    return {
      id: 'example.com',
      masteryLevel: 'full',
      recommendedTier: 'direct',
      firstSeen: Date.now(),
      lastVisited: Date.now(),
      totalRequests: 100,
      successfulRequests: 95,
    };
  }

  it('accepts a valid site', () => {
    const result = validateImportableSite(validSite());
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('rejects non-object input', () => {
    const result = validateImportableSite(42);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('site is not an object');
  });

  it('rejects missing id', () => {
    const result = validateImportableSite({ masteryLevel: 'full' });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('id must be a non-empty string');
  });

  it('rejects invalid masteryLevel enum', () => {
    const result = validateImportableSite({ ...validSite(), masteryLevel: 'god' });
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('invalid masteryLevel');
  });

  it('rejects invalid recommendedTier enum', () => {
    const result = validateImportableSite({ ...validSite(), recommendedTier: 'mega_tier' });
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('invalid recommendedTier');
  });

  it('rejects non-finite firstSeen', () => {
    const result = validateImportableSite({ ...validSite(), firstSeen: Infinity });
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('firstSeen must be a finite number');
  });

  it('rejects non-finite lastVisited', () => {
    const result = validateImportableSite({ ...validSite(), lastVisited: NaN });
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('lastVisited must be a finite number');
  });

  it('rejects non-finite totalRequests', () => {
    const result = validateImportableSite({ ...validSite(), totalRequests: Infinity });
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('totalRequests must be a finite number');
  });

  it('rejects non-finite successfulRequests', () => {
    const result = validateImportableSite({ ...validSite(), successfulRequests: NaN });
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('successfulRequests must be a finite number');
  });

  it('rejects non-number totalRequests', () => {
    const result = validateImportableSite({ ...validSite(), totalRequests: 'many' });
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('totalRequests must be a finite number');
  });
});
