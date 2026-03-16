import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mock logger ─────────────────────────────────────────────────
vi.mock('../../src/core/logger.js', () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// ─── Mock dryRun and forcePromote ────────────────────────────────
vi.mock('../../src/replay/dry-run.js', () => ({
  dryRun: vi.fn().mockResolvedValue({ ok: true }),
}));

vi.mock('../../src/core/promotion.js', () => ({
  forcePromote: vi.fn().mockReturnValue({
    newStatus: 'active',
    timestamp: '2025-01-01T00:00:00.000Z',
  }),
}));

import { SchruteService, type AppDeps } from '../../src/app/service.js';
import type { SkillSpec } from '../../src/skill/types.js';

// ─── Mock Factories ──────────────────────────────────────────────

function makeSkill(overrides: Partial<SkillSpec> = {}): SkillSpec {
  return {
    id: 'skill-1',
    name: 'Test Skill',
    siteId: 'example.com',
    method: 'GET',
    pathTemplate: '/api/test',
    status: 'active' as any,
    currentTier: 'tier1',
    sideEffectClass: 'read-only',
    confidence: 0.9,
    createdAt: '2025-01-01T00:00:00.000Z',
    updatedAt: '2025-01-01T00:00:00.000Z',
    ...overrides,
  } as SkillSpec;
}

function makeDeps(overrides: Partial<AppDeps> = {}): AppDeps {
  return {
    engine: {
      explore: vi.fn().mockResolvedValue({ siteId: 'example.com', endpoints: [] }),
      startRecording: vi.fn().mockResolvedValue(undefined),
      stopRecording: vi.fn().mockResolvedValue({ steps: [] }),
      executeSkill: vi.fn().mockResolvedValue({ status: 'ok', data: {} }),
      getStatus: vi.fn().mockReturnValue({
        mode: 'idle',
        uptime: 12345,
        activeSession: null,
        currentRecording: null,
      }),
      getMultiSessionManager: vi.fn().mockReturnValue({
        list: vi.fn().mockReturnValue([]),
        getActive: vi.fn().mockReturnValue(null),
        setActive: vi.fn(),
        close: vi.fn().mockResolvedValue(undefined),
      }),
    } as any,
    skillRepo: {
      getAll: vi.fn().mockReturnValue([]),
      getById: vi.fn().mockReturnValue(null),
      getBySiteId: vi.fn().mockReturnValue([]),
      getByStatusAndSiteId: vi.fn().mockReturnValue([]),
      getByStatus: vi.fn().mockReturnValue([]),
      update: vi.fn(),
    } as any,
    siteRepo: {
      getAll: vi.fn().mockReturnValue([]),
      getById: vi.fn().mockReturnValue(null),
    } as any,
    config: {
      dataDir: '/tmp/test',
      logLevel: 'silent',
      daemon: { port: 19420, autoStart: false },
    } as any,
    confirmation: {
      isSkillConfirmed: vi.fn().mockReturnValue(true),
      generateToken: vi.fn().mockResolvedValue({
        nonce: 'token-abc',
        expiresAt: Date.now() + 60000,
      }),
      verifyToken: vi.fn().mockReturnValue({ valid: true, token: { skillId: 'skill-1', tier: 'tier1' } }),
      verifyAndConsume: vi.fn().mockReturnValue({ valid: true, token: { skillId: 'skill-1', tier: 'tier1' } }),
      consumeToken: vi.fn(),
    } as any,
    ...overrides,
  };
}

// ─── Tests ───────────────────────────────────────────────────────

describe('SchruteService', () => {
  let deps: AppDeps;
  let service: SchruteService;

  beforeEach(() => {
    vi.clearAllMocks();
    deps = makeDeps();
    service = new SchruteService(deps);
  });

  describe('getStatus', () => {
    it('returns engine status info', () => {
      const status = service.getStatus();

      expect(status.mode).toBe('idle');
      expect(status.uptime).toBe(12345);
      expect(status.activeSession).toBeNull();
      expect(status.currentRecording).toBeNull();
      expect(deps.engine.getStatus).toHaveBeenCalled();
    });
  });

  describe('listSkills', () => {
    it('returns all skills when no filters', async () => {
      const skills = [makeSkill({ id: 'a' }), makeSkill({ id: 'b' })];
      vi.mocked(deps.skillRepo.getAll).mockReturnValue(skills);

      const result = await service.listSkills();

      expect(result).toEqual(skills);
      expect(deps.skillRepo.getAll).toHaveBeenCalled();
    });

    it('filters by siteId', async () => {
      const skills = [makeSkill({ id: 'a', siteId: 'site-1' })];
      vi.mocked(deps.skillRepo.getBySiteId).mockReturnValue(skills);

      const result = await service.listSkills('site-1');

      expect(result).toEqual(skills);
      expect(deps.skillRepo.getBySiteId).toHaveBeenCalledWith('site-1');
    });

    it('filters by status', async () => {
      const skills = [makeSkill({ id: 'a', status: 'active' as any })];
      vi.mocked(deps.skillRepo.getByStatus).mockReturnValue(skills);

      const result = await service.listSkills(undefined, 'active' as any);

      expect(result).toEqual(skills);
      expect(deps.skillRepo.getByStatus).toHaveBeenCalledWith('active');
    });

    it('filters by both siteId and status', async () => {
      const filtered = [
        makeSkill({ id: 'a', siteId: 'site-1', status: 'active' as any }),
      ];
      vi.mocked(deps.skillRepo.getByStatusAndSiteId).mockReturnValue(filtered);

      const result = await service.listSkills('site-1', 'active' as any);

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('a');
      expect(deps.skillRepo.getByStatusAndSiteId).toHaveBeenCalledWith('active', 'site-1');
    });
  });

  describe('executeSkill — confirmation gate', () => {
    it('executes directly when skill is confirmed', async () => {
      const skill = makeSkill();
      vi.mocked(deps.skillRepo.getById).mockReturnValue(skill);
      vi.mocked(deps.confirmation.isSkillConfirmed).mockReturnValue(true);
      vi.mocked(deps.engine.executeSkill).mockResolvedValue({ status: 'ok', data: { result: 42 } } as any);

      const result = await service.executeSkill('skill-1', { key: 'value' });

      expect(result.status).toBe('executed');
      expect((result as any).result).toBeDefined();
      expect(deps.engine.executeSkill).toHaveBeenCalledWith('skill-1', { key: 'value' }, undefined);
    });

    it('returns confirmation_required when skill is not confirmed', async () => {
      const skill = makeSkill({
        sideEffectClass: 'write',
        method: 'POST',
        pathTemplate: '/api/data',
      });
      vi.mocked(deps.skillRepo.getById).mockReturnValue(skill);
      vi.mocked(deps.confirmation.isSkillConfirmed).mockReturnValue(false);
      vi.mocked(deps.confirmation.generateToken).mockResolvedValue({
        nonce: 'token-xyz',
        expiresAt: 9999999,
      });

      const result = await service.executeSkill('skill-1', {});

      expect(result.status).toBe('confirmation_required');
      expect((result as any).confirmationToken).toBe('token-xyz');
      expect((result as any).sideEffectClass).toBe('write');
      expect((result as any).method).toBe('POST');
      expect((result as any).pathTemplate).toBe('/api/data');
      expect(deps.engine.executeSkill).not.toHaveBeenCalled();
    });

    it('throws when skill not found', async () => {
      vi.mocked(deps.skillRepo.getById).mockReturnValue(null as any);

      await expect(service.executeSkill('nonexistent', {})).rejects.toThrow(
        "Skill 'nonexistent' not found",
      );
    });

    it('throws when skill is not active', async () => {
      const skill = makeSkill({ status: 'draft' as any });
      vi.mocked(deps.skillRepo.getById).mockReturnValue(skill);

      await expect(service.executeSkill('skill-1', {})).rejects.toThrow(
        "Skill 'skill-1' is not active (status: draft)",
      );
      expect(deps.engine.executeSkill).not.toHaveBeenCalled();
    });
  });

  describe('getSkill', () => {
    it('returns skill when found', () => {
      const skill = makeSkill();
      vi.mocked(deps.skillRepo.getById).mockReturnValue(skill);

      const result = service.getSkill('skill-1');

      expect(result).toEqual(skill);
    });

    it('returns null when not found', () => {
      vi.mocked(deps.skillRepo.getById).mockReturnValue(undefined as any);

      const result = service.getSkill('missing');

      expect(result).toBeNull();
    });
  });

  describe('listSites', () => {
    it('delegates to siteRepo', () => {
      const sites = [{ siteId: 'example.com' }];
      vi.mocked(deps.siteRepo.getAll).mockReturnValue(sites as any);

      const result = service.listSites();

      expect(result).toEqual(sites);
    });
  });

  describe('getConfig', () => {
    it('returns the config object', () => {
      const config = service.getConfig();

      expect(config).toBe(deps.config);
    });
  });

  describe('confirm', () => {
    it('approves a valid token', () => {
      vi.mocked(deps.confirmation.verifyAndConsume).mockReturnValue({
        valid: true,
        token: { skillId: 'skill-1', tier: 'tier1' },
      } as any);

      const result = service.confirm('token-abc', true) as any;

      expect(result.status).toBe('approved');
      expect(result.skillId).toBe('skill-1');
      expect(deps.confirmation.verifyAndConsume).toHaveBeenCalledWith('token-abc', true);
    });

    it('denies a valid token', () => {
      vi.mocked(deps.confirmation.verifyAndConsume).mockReturnValue({
        valid: true,
        token: { skillId: 'skill-1', tier: 'tier1' },
      } as any);

      const result = service.confirm('token-abc', false) as any;

      expect(result.status).toBe('denied');
      expect(result.skillId).toBe('skill-1');
    });

    it('throws on invalid token', () => {
      vi.mocked(deps.confirmation.verifyAndConsume).mockReturnValue({
        valid: false,
        error: 'expired',
      } as any);

      expect(() => service.confirm('bad-token', true)).toThrow(/Confirmation failed.*expired/);
    });
  });
});
