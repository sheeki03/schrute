import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRouter, type RouterDeps } from '../../src/server/router.js';
import type { Engine } from '../../src/core/engine.js';
import type { SkillRepository } from '../../src/storage/skill-repository.js';
import type { SiteRepository } from '../../src/storage/site-repository.js';
import type { SchruteConfig, SkillSpec, SiteManifest } from '../../src/skill/types.js';

// ─── Mock Config ─────────────────────────────────────────────────

const mockConfig: SchruteConfig = {
  dataDir: '/tmp/schrute-test',
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
  paramLimits: { maxStringLength: 10_000, maxDepth: 5, maxProperties: 50 },
  daemon: { port: 19420, autoStart: false },
  tempTtlMs: 3600000,
  gcIntervalMs: 900000,
  confirmationTimeoutMs: 30000,
  confirmationExpiryMs: 60000,
  promotionConsecutivePasses: 5,
  promotionVolatilityThreshold: 0.2,
  maxToolsPerSite: 20,
  toolShortlistK: 10,
};

// ─── Mock Skill ──────────────────────────────────────────────────

function makeSkill(overrides: Partial<SkillSpec> = {}): SkillSpec {
  return {
    id: 'example_com.get_users.v1',
    version: 1,
    status: 'active',
    currentTier: 'tier_3',
    tierLock: null,
    allowedDomains: ['example.com'],
    requiredCapabilities: ['net.fetch.direct'],
    parameters: [],
    validation: { semanticChecks: [], customInvariants: [] },
    redaction: { piiClassesFound: [], fieldsRedacted: 0 },
    replayStrategy: 'prefer_tier_3',
    sideEffectClass: 'read-only',
    sampleCount: 5,
    consecutiveValidations: 3,
    confidence: 0.9,
    method: 'GET',
    pathTemplate: '/api/users/{id}',
    inputSchema: {},
    isComposite: false,
    siteId: 'example.com',
    name: 'get_users',
    description: 'Fetch users',
    successRate: 0.95,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

function makeSite(overrides: Partial<SiteManifest> = {}): SiteManifest {
  return {
    id: 'example.com',
    firstSeen: Date.now(),
    lastVisited: Date.now(),
    masteryLevel: 'explore',
    recommendedTier: 'browser_proxied',
    totalRequests: 100,
    successfulRequests: 95,
    ...overrides,
  };
}

// ─── Mock Confirmation Manager ───────────────────────────────────

function makeConfirmationManager() {
  const pendingTokens = new Map<string, { skillId: string; tier: string; consumed: boolean }>();
  let tokenCounter = 0;

  return {
    isSkillConfirmed: vi.fn().mockReturnValue(false),
    generateToken: vi.fn().mockImplementation((skillId: string, _params: Record<string, unknown>, tier: string) => {
      const nonce = `test-token-${++tokenCounter}`;
      pendingTokens.set(nonce, { skillId, tier, consumed: false });
      return {
        nonce,
        skillId,
        paramsHash: 'test-hash',
        tier,
        createdAt: Date.now(),
        expiresAt: Date.now() + 60000,
        consumed: false,
      };
    }),
    verifyToken: vi.fn().mockImplementation((tokenId: string) => {
      const token = pendingTokens.get(tokenId);
      if (!token) return { valid: false, error: 'Token not found' };
      if (token.consumed) return { valid: false, error: 'Token already consumed' };
      return {
        valid: true,
        token: {
          nonce: tokenId,
          skillId: token.skillId,
          paramsHash: 'test-hash',
          tier: token.tier,
          createdAt: Date.now(),
          expiresAt: Date.now() + 60000,
          consumed: false,
        },
      };
    }),
    consumeToken: vi.fn().mockImplementation((tokenId: string, _approve: boolean) => {
      const token = pendingTokens.get(tokenId);
      if (token) token.consumed = true;
    }),
    verifyAndConsume: vi.fn().mockImplementation((tokenId: string, _approve: boolean) => {
      const token = pendingTokens.get(tokenId);
      if (!token) return { valid: false, error: 'Token not found' };
      if (token.consumed) return { valid: false, error: 'Token already consumed' };
      token.consumed = true;
      return {
        valid: true,
        token: {
          nonce: tokenId,
          skillId: token.skillId,
          paramsHash: 'test-hash',
          tier: token.tier,
          createdAt: Date.now(),
          expiresAt: Date.now() + 60000,
          consumed: true,
        },
      };
    }),
  };
}

// ─── Mock Dependencies ───────────────────────────────────────────

function makeDeps(): RouterDeps {
  const mockSkillRepo = {
    getByStatus: vi.fn().mockReturnValue([]),
    getBySiteId: vi.fn().mockReturnValue([]),
    getById: vi.fn().mockReturnValue(undefined),
  } as unknown as SkillRepository;

  const mockSiteRepo = {
    getAll: vi.fn().mockReturnValue([]),
    getById: vi.fn().mockReturnValue(undefined),
  } as unknown as SiteRepository;

  const mockEngine = {
    getStatus: vi.fn().mockReturnValue({
      mode: 'idle',
      activeSession: null,
      currentRecording: null,
      uptime: 1000,
    }),
    explore: vi.fn().mockResolvedValue({ sessionId: 's1', siteId: 'example.com', url: 'https://example.com' }),
    startRecording: vi.fn().mockResolvedValue({ id: 'r1', name: 'test', siteId: 'example.com', startedAt: Date.now(), requestCount: 0 }),
    stopRecording: vi.fn().mockResolvedValue({ id: 'r1', name: 'test', siteId: 'example.com', startedAt: Date.now(), requestCount: 5 }),
    executeSkill: vi.fn().mockResolvedValue({ success: true, data: { result: 'ok' }, latencyMs: 100 }),
    close: vi.fn().mockResolvedValue(undefined),
  } as unknown as Engine;

  return {
    engine: mockEngine,
    skillRepo: mockSkillRepo,
    siteRepo: mockSiteRepo,
    config: mockConfig,
    confirmation: makeConfirmationManager() as any,
  };
}

// ─── Tests ────────────────────────────────────────────────────────

describe('router', () => {
  let deps: RouterDeps;

  beforeEach(() => {
    deps = makeDeps();
  });

  describe('listSites', () => {
    it('returns empty list when no sites', () => {
      const router = createRouter(deps);
      const result = router.listSites();
      expect(result.success).toBe(true);
      expect(result.data).toEqual([]);
    });

    it('returns sites from repo', () => {
      const sites = [makeSite()];
      (deps.siteRepo.getAll as ReturnType<typeof vi.fn>).mockReturnValue(sites);
      const router = createRouter(deps);
      const result = router.listSites();
      expect(result.success).toBe(true);
      expect(result.data).toEqual(sites);
    });
  });

  describe('getSite', () => {
    it('returns 404 for unknown site', () => {
      const router = createRouter(deps);
      const result = router.getSite('unknown.com');
      expect(result.success).toBe(false);
      expect(result.statusCode).toBe(404);
    });

    it('returns site when found', () => {
      const site = makeSite();
      (deps.siteRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(site);
      const router = createRouter(deps);
      const result = router.getSite('example.com');
      expect(result.success).toBe(true);
      expect(result.data).toEqual(site);
    });
  });

  describe('listSkills', () => {
    it('returns skills for a site', () => {
      const skills = [makeSkill()];
      (deps.skillRepo.getBySiteId as ReturnType<typeof vi.fn>).mockReturnValue(skills);
      const router = createRouter(deps);
      const result = router.listSkills('example.com');
      expect(result.success).toBe(true);
      expect(Array.isArray(result.data)).toBe(true);
    });

    it('filters by status', () => {
      const skills = [makeSkill({ status: 'active' }), makeSkill({ status: 'draft', id: 's2' })];
      (deps.skillRepo.getByStatus as ReturnType<typeof vi.fn>).mockReturnValue(skills);
      const router = createRouter(deps);
      const result = router.listSkills('example.com', 'active');
      expect(result.success).toBe(true);
    });
  });

  describe('executeSkill', () => {
    it('returns 404 if skill not found', async () => {
      const router = createRouter(deps);
      const result = await router.executeSkill('example.com', 'nonexistent', {});
      expect(result.success).toBe(false);
      expect(result.statusCode).toBe(404);
    });

    it('requires confirmation for unvalidated skills', async () => {
      const skill = makeSkill({ consecutiveValidations: 0, sideEffectClass: 'non-idempotent' });
      (deps.skillRepo.getBySiteId as ReturnType<typeof vi.fn>).mockReturnValue([skill]);
      const router = createRouter(deps);
      const result = await router.executeSkill('example.com', 'get_users', { id: '123' });
      expect(result.statusCode).toBe(202);
      expect((result.data as Record<string, unknown>).status).toBe('confirmation_required');
    });

    it('executes confirmed skill', async () => {
      const skill = makeSkill({ consecutiveValidations: 3 });
      (deps.skillRepo.getBySiteId as ReturnType<typeof vi.fn>).mockReturnValue([skill]);
      // Mark skill as confirmed so it bypasses the confirmation gate
      (deps.confirmation.isSkillConfirmed as ReturnType<typeof vi.fn>).mockReturnValue(true);
      const router = createRouter(deps);
      const result = await router.executeSkill('example.com', 'get_users', { id: '123' });
      expect(result.success).toBe(true);
    });
  });

  describe('dryRunSkill', () => {
    it('returns 404 if skill not found', async () => {
      const router = createRouter(deps);
      const result = await router.dryRunSkill('example.com', 'nonexistent', {});
      expect(result.success).toBe(false);
      expect(result.statusCode).toBe(404);
    });

    it('returns preview for found skill', async () => {
      const skill = makeSkill();
      (deps.skillRepo.getBySiteId as ReturnType<typeof vi.fn>).mockReturnValue([skill]);
      const router = createRouter(deps);
      const result = await router.dryRunSkill('example.com', 'get_users', { id: '123' });
      expect(result.success).toBe(true);
      expect((result.data as Record<string, string>).note).toContain('preview');
    });
  });

  describe('explore', () => {
    it('delegates to engine', async () => {
      const router = createRouter(deps);
      const result = await router.explore('https://example.com');
      expect(result.success).toBe(true);
      expect(deps.engine.explore).toHaveBeenCalledWith('https://example.com', undefined);
    });

    it('handles errors gracefully', async () => {
      (deps.engine.explore as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('fail'));
      const router = createRouter(deps);
      const result = await router.explore('https://example.com');
      expect(result.success).toBe(false);
      expect(result.error).toBe('fail');
    });
  });

  describe('startRecording / stopRecording', () => {
    it('start delegates to engine', async () => {
      const router = createRouter(deps);
      const result = await router.startRecording('test');
      expect(result.success).toBe(true);
      expect(deps.engine.startRecording).toHaveBeenCalledWith('test', undefined);
    });

    it('stop delegates to engine', async () => {
      const router = createRouter(deps);
      const result = await router.stopRecording();
      expect(result.success).toBe(true);
      expect(deps.engine.stopRecording).toHaveBeenCalled();
    });
  });

  describe('health', () => {
    it('returns health status', () => {
      const router = createRouter(deps);
      const result = router.health();
      expect(result.success).toBe(true);
      const data = result.data as Record<string, unknown>;
      expect(data.status).toBe('ok');
      expect(typeof data.uptime).toBe('number');
    });
  });

  describe('confirm', () => {
    it('rejects invalid token', () => {
      const router = createRouter(deps);
      const result = router.confirm('invalid-token', true);
      expect(result.success).toBe(false);
      expect(result.statusCode).toBe(400);
    });
  });
});
