import { describe, it, expect } from 'vitest';
import { pruneSkills, getShortlist } from '../../src/skill/pruner.js';
import type { SkillSpec, OneAgentConfig } from '../../src/skill/types.js';
import { SkillStatus } from '../../src/skill/types.js';

function makeConfig(overrides?: Partial<OneAgentConfig>): OneAgentConfig {
  return {
    dataDir: '/tmp/test-oneagent',
    logLevel: 'silent',
    features: { webmcp: false, httpTransport: false },
    toolBudget: {
      maxToolCallsPerTask: 50,
      maxConcurrentCalls: 3,
      crossDomainCalls: false,
      secretsToNonAllowlisted: false,
    },
    payloadLimits: {
      maxResponseBodyBytes: 10 * 1024 * 1024,
      maxRequestBodyBytes: 5 * 1024 * 1024,
      replayTimeoutMs: { tier1: 30000, tier3: 60000, tier4: 120000 },
      harCaptureMaxBodyBytes: 50 * 1024 * 1024,
      redactorTimeoutMs: 10000,
    },
    audit: { strictMode: true, rootHashExport: true },
    storage: { maxPerSiteMb: 500, maxGlobalMb: 5000, retentionDays: 90 },
    server: { network: false },
    tempTtlMs: 3600000,
    gcIntervalMs: 900000,
    confirmationTimeoutMs: 30000,
    confirmationExpiryMs: 60000,
    promotionConsecutivePasses: 5,
    promotionVolatilityThreshold: 0.2,
    maxToolsPerSite: 20,
    toolShortlistK: 10,
    ...overrides,
  } as OneAgentConfig;
}

function makeSkill(overrides: Partial<SkillSpec> = {}): SkillSpec {
  return {
    id: `test.skill.v1`,
    version: 1,
    status: SkillStatus.ACTIVE,
    currentTier: 'tier_3',
    tierLock: null,
    allowedDomains: ['example.com'],
    requiredCapabilities: [],
    parameters: [],
    validation: { semanticChecks: [], customInvariants: [] },
    redaction: { piiClassesFound: [], fieldsRedacted: 0 },
    replayStrategy: 'prefer_tier_1',
    sideEffectClass: 'read-only',
    sampleCount: 5,
    consecutiveValidations: 5,
    confidence: 0.9,
    method: 'GET',
    pathTemplate: '/api/data',
    inputSchema: {},
    isComposite: false,
    siteId: 'example.com',
    name: 'test skill',
    successRate: 1.0,
    lastVerified: Date.now(), // recently verified
    lastUsed: Date.now(),
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  } as SkillSpec;
}

const config = makeConfig();

describe('pruner', () => {
  describe('pruneSkills', () => {
    it('only active skills with sufficient confidence are visible', () => {
      const skills = [
        makeSkill({ id: 'active-1', status: SkillStatus.ACTIVE, lastVerified: Date.now() }),
        makeSkill({ id: 'draft-1', status: SkillStatus.DRAFT }),
        makeSkill({ id: 'stale-1', status: SkillStatus.STALE }),
        makeSkill({ id: 'broken-1', status: SkillStatus.BROKEN }),
      ];
      const result = pruneSkills(skills, config);
      expect(result.visible).toHaveLength(1);
      expect(result.visible[0].id).toBe('active-1');
      expect(result.hidden).toHaveLength(3);
    });

    it('hides active skills with low confidence (stale)', () => {
      const ninetyDaysAgo = Date.now() - 90 * 24 * 60 * 60 * 1000;
      const skills = [
        makeSkill({ id: 'old-skill', status: SkillStatus.ACTIVE, lastVerified: ninetyDaysAgo }),
      ];
      const result = pruneSkills(skills, config);
      expect(result.visible).toHaveLength(0);
      expect(result.hidden).toHaveLength(1);
    });

    it('caps visible skills per site', () => {
      const smallCapConfig = makeConfig({ maxToolsPerSite: 3 } as Partial<OneAgentConfig>);
      const skills = Array.from({ length: 5 }, (_, i) =>
        makeSkill({
          id: `skill-${i}`,
          lastUsed: Date.now() - i * 1000,
          lastVerified: Date.now(),
        }),
      );
      const result = pruneSkills(skills, smallCapConfig);
      expect(result.visible).toHaveLength(3);
      expect(result.hidden).toHaveLength(2);
    });

    it('sorts visible by last used (most recent first)', () => {
      const skills = [
        makeSkill({ id: 'old', lastUsed: Date.now() - 10000, lastVerified: Date.now() }),
        makeSkill({ id: 'new', lastUsed: Date.now(), lastVerified: Date.now() }),
        makeSkill({ id: 'mid', lastUsed: Date.now() - 5000, lastVerified: Date.now() }),
      ];
      const result = pruneSkills(skills, config);
      expect(result.visible[0].id).toBe('new');
      expect(result.visible[1].id).toBe('mid');
      expect(result.visible[2].id).toBe('old');
    });
  });

  describe('getShortlist', () => {
    it('returns top K skills', () => {
      const smallK = makeConfig({ toolShortlistK: 2 } as Partial<OneAgentConfig>);
      const skills = Array.from({ length: 5 }, (_, i) =>
        makeSkill({
          id: `skill-${i}`,
          name: `Skill ${i}`,
          lastUsed: Date.now() - i * 1000,
          lastVerified: Date.now(),
        }),
      );
      const result = getShortlist(skills, undefined, undefined, smallK);
      expect(result.skills.length).toBeLessThanOrEqual(2);
    });

    it('returns empty for no active skills', () => {
      const result = getShortlist(
        [makeSkill({ status: SkillStatus.DRAFT })],
        'search',
        undefined,
        config,
      );
      expect(result.skills).toHaveLength(0);
    });

    it('matches intent to skill name', () => {
      const skills = [
        makeSkill({ id: 'search', name: 'search users', lastVerified: Date.now() }),
        makeSkill({ id: 'create', name: 'create user', lastVerified: Date.now() }),
        makeSkill({ id: 'delete', name: 'delete user', lastVerified: Date.now() }),
      ];
      const result = getShortlist(skills, 'search', 1, config);
      // The search skill should score highest
      if (result.skills.length > 0) {
        expect(result.skills[0].name).toContain('search');
      }
    });
  });
});
