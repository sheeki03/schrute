import { describe, expect, it, vi, beforeEach } from 'vitest';
import { Engine } from '../../src/core/engine.js';
import { SideEffectClass, type SkillSpec } from '../../src/skill/types.js';
import { getSitePolicy } from '../../src/core/policy.js';

vi.mock('../../src/core/logger.js', () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('../../src/core/policy.js', () => ({
  getSitePolicy: vi.fn(() => ({
    executionBackend: 'agent-browser',
    executionSessionName: undefined,
    maxConcurrent: 3,
  })),
  checkCapability: vi.fn(),
  enforceDomainAllowlist: vi.fn(),
  checkMethodAllowed: vi.fn(),
  checkPathRisk: vi.fn(),
  mergeSitePolicy: vi.fn(),
}));

function makeSkill(id: string, sideEffectClass = SideEffectClass.READ_ONLY, siteId = 'example.com'): SkillSpec {
  return {
    id,
    version: 1,
    status: 'active',
    currentTier: 'tier_1',
    tierLock: null,
    allowedDomains: [siteId],
    requiredCapabilities: [],
    parameters: [],
    validation: { semanticChecks: [], customInvariants: [] },
    redaction: { piiClassesFound: [], fieldsRedacted: 0 },
    replayStrategy: 'prefer_tier_1',
    sideEffectClass,
    sampleCount: 1,
    consecutiveValidations: 1,
    confidence: 1,
    method: 'GET',
    pathTemplate: `/${id}`,
    inputSchema: {},
    isComposite: false,
    siteId,
    name: id,
    successRate: 1,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  } as SkillSpec;
}

function createBatchEngine(
  skills: Record<string, SkillSpec>,
  executeSkillImpl: (skillId: string, params: Record<string, unknown>) => Promise<unknown>,
): Engine {
  const engine = Object.create(Engine.prototype) as Engine & {
    skillRepo: { getById: (id: string) => SkillSpec | undefined };
    config: Record<string, unknown>;
    executeSkill: (skillId: string, params: Record<string, unknown>, callerId?: string) => Promise<unknown>;
    executionBackendGroupIds: WeakMap<object, string>;
    nextExecutionBackendGroupId: number;
  };

  engine.skillRepo = {
    getById: (id: string) => skills[id],
  };
  engine.config = {
    browser: {
      execution: {
        backend: 'agent-browser',
      },
    },
  };
  engine.executionBackendGroupIds = new WeakMap();
  engine.nextExecutionBackendGroupId = 0;
  engine.executeSkill = vi.fn((skillId: string, params: Record<string, unknown>) => executeSkillImpl(skillId, params)) as unknown as Engine['executeSkill'];
  return engine;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('Engine.executeBatch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('resolves execution group keys from actual backend routing', () => {
    const engine = createBatchEngine({}, async () => ({ success: true, latencyMs: 1 })) as Engine;
    const routedBackend = {} as any;
    const alternateBackend = {} as any;
    const getExecutionBackend = vi.fn();
    (engine as Engine & { getExecutionBackend: typeof getExecutionBackend }).getExecutionBackend = getExecutionBackend as unknown as Engine['getExecutionBackend'];

    getExecutionBackend.mockReturnValue(routedBackend);
    const first = engine.resolveExecutionGroupKey(makeSkill('skill-a'));

    (getSitePolicy as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      executionBackend: 'live-chrome',
      executionSessionName: 'shared-session',
    });
    const second = engine.resolveExecutionGroupKey(makeSkill('skill-b'));

    getExecutionBackend.mockReturnValue(alternateBackend);
    const third = engine.resolveExecutionGroupKey(makeSkill('skill-c'));

    expect(getExecutionBackend).toHaveBeenCalledTimes(3);
    expect(first).toBe(second);
    expect(third).not.toBe(first);
  });

  it('preserves result order and enforces write barriers', async () => {
    const skills = {
      r1: makeSkill('r1'),
      r2: makeSkill('r2'),
      w1: makeSkill('w1', SideEffectClass.NON_IDEMPOTENT),
      r3: makeSkill('r3'),
      r4: makeSkill('r4'),
    };
    const events: string[] = [];
    const engine = createBatchEngine(skills, async (skillId) => {
      events.push(`start:${skillId}`);
      await delay(skillId.startsWith('r') ? 20 : 5);
      events.push(`end:${skillId}`);
      return { success: true, data: { skillId }, latencyMs: 1 };
    });

    const results = await engine.executeBatch([
      { skillId: 'r1' },
      { skillId: 'r2' },
      { skillId: 'w1' },
      { skillId: 'r3' },
      { skillId: 'r4' },
    ]);

    expect(results.map((result) => result.skillId)).toEqual(['r1', 'r2', 'w1', 'r3', 'r4']);
    expect(events.indexOf('end:r1')).toBeLessThan(events.indexOf('start:w1'));
    expect(events.indexOf('end:r2')).toBeLessThan(events.indexOf('start:w1'));
    expect(events.indexOf('end:w1')).toBeLessThan(events.indexOf('start:r3'));
  });

  it('caps read-window concurrency at 3 per execution group', async () => {
    const skills = Object.fromEntries(
      ['r1', 'r2', 'r3', 'r4', 'r5'].map((id) => [id, makeSkill(id)]),
    ) as Record<string, SkillSpec>;
    let active = 0;
    let maxActive = 0;

    const engine = createBatchEngine(skills, async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await delay(20);
      active -= 1;
      return { success: true, latencyMs: 1 };
    });

    await engine.executeBatch([
      { skillId: 'r1' },
      { skillId: 'r2' },
      { skillId: 'r3' },
      { skillId: 'r4' },
      { skillId: 'r5' },
    ]);

    expect(maxActive).toBe(3);
  });

  it('uses per-site policy maxConcurrent for read-window concurrency', async () => {
    (getSitePolicy as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      executionBackend: 'agent-browser',
      executionSessionName: undefined,
      maxConcurrent: 2,
    });

    const skills = Object.fromEntries(
      ['r1', 'r2', 'r3', 'r4'].map((id) => [id, makeSkill(id)]),
    ) as Record<string, SkillSpec>;
    let active = 0;
    let maxActive = 0;

    const engine = createBatchEngine(skills, async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await delay(20);
      active -= 1;
      return { success: true, latencyMs: 1 };
    });

    await engine.executeBatch([
      { skillId: 'r1' },
      { skillId: 'r2' },
      { skillId: 'r3' },
      { skillId: 'r4' },
    ]);

    expect(maxActive).toBe(2);
  });

  it('retries rate-limited actions once before returning the final result', async () => {
    const skills = {
      r1: makeSkill('r1'),
    };
    const executeSkill = vi.fn()
      .mockResolvedValueOnce({
        success: false,
        failureCause: 'rate_limited',
        failureDetail: 'Retry after 100ms',
        error: 'rate limited',
        latencyMs: 1,
      })
      .mockResolvedValueOnce({
        success: true,
        data: { ok: true },
        latencyMs: 1,
      });
    const engine = createBatchEngine(skills, executeSkill);

    const results = await engine.executeBatch([{ skillId: 'r1' }]);
    expect(results).toEqual([expect.objectContaining({ skillId: 'r1', success: true, data: { ok: true } })]);
    expect(executeSkill).toHaveBeenCalledTimes(2);
  });

  it('preserves browser handoff metadata in batch results', async () => {
    const skills = {
      r1: makeSkill('r1'),
    };
    const executeSkill = vi.fn().mockResolvedValue({
      success: false,
      status: 'browser_handoff_required',
      reason: 'cloudflare_challenge',
      recoveryMode: 'real_browser_cdp',
      siteId: 'example.com',
      url: 'https://example.com/challenge',
      hint: 'Complete challenge',
      resumeToken: 'recover-token',
      managedBrowser: true,
      latencyMs: 1,
    });
    const engine = createBatchEngine(skills, executeSkill);

    const results = await engine.executeBatch([{ skillId: 'r1' }]);

    expect(results[0]).toEqual(expect.objectContaining({
      skillId: 'r1',
      success: false,
      status: 'browser_handoff_required',
      resumeToken: 'recover-token',
      managedBrowser: true,
      recoveryMode: 'real_browser_cdp',
    }));
  });

  it('builds workflow step executors that request wait-for-permit pacing', async () => {
    const engine = createBatchEngine({}, async () => ({ success: true, latencyMs: 1 }));

    const executor = (engine as any).buildWorkflowStepExecutor('caller-1');
    await executor('workflow-step', { query: 'ada' });

    expect(engine.executeSkill).toHaveBeenCalledWith(
      'workflow-step',
      { query: 'ada' },
      'caller-1',
      {
        skipTransform: true,
        waitForPermit: {
          timeoutMs: 30_000,
        },
      },
    );
  });
});
