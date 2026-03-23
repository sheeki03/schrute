import { describe, expect, it, vi } from 'vitest';
import { executeWorkflow, type WorkflowStepCacheStore } from '../../src/replay/workflow-executor.js';
import { SideEffectClass, SkillStatus, type SkillSpec, type WorkflowSpec } from '../../src/skill/types.js';

function makeSkill(id: string, overrides: Partial<SkillSpec> = {}): SkillSpec {
  return {
    id,
    version: 1,
    status: SkillStatus.ACTIVE,
    currentTier: 'tier_1',
    tierLock: null,
    allowedDomains: ['example.com'],
    requiredCapabilities: [],
    parameters: [],
    validation: { semanticChecks: [], customInvariants: [] },
    redaction: { piiClassesFound: [], fieldsRedacted: 0 },
    replayStrategy: 'prefer_tier_1',
    sideEffectClass: SideEffectClass.READ_ONLY,
    sampleCount: 1,
    consecutiveValidations: 1,
    confidence: 1,
    method: 'GET',
    pathTemplate: `/${id}`,
    inputSchema: {},
    isComposite: false,
    siteId: 'example.com',
    name: id,
    successRate: 1,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  } as SkillSpec;
}

function makeRepo(skills: Record<string, SkillSpec>) {
  return {
    getById: (id: string) => skills[id],
  };
}

describe('workflow-executor', () => {
  it('passes data from $prev references across steps', async () => {
    const workflow: WorkflowSpec = {
      steps: [
        { skillId: 'search', name: 'search', paramMapping: { query: '$initial.query' } },
        { skillId: 'detail', paramMapping: { id: '$prev.data.id' } },
      ],
    };
    const repo = makeRepo({
      search: makeSkill('search'),
      detail: makeSkill('detail'),
    });
    const executeStep = vi.fn()
      .mockResolvedValueOnce({ success: true, data: { id: 'user-1' }, latencyMs: 1 })
      .mockResolvedValueOnce({ success: true, data: { name: 'Ada' }, latencyMs: 1 });

    const result = await executeWorkflow(workflow, { query: 'ada' }, executeStep, repo as any);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({ name: 'Ada' });
    }
    expect(executeStep).toHaveBeenNthCalledWith(1, 'search', { query: 'ada' });
    expect(executeStep).toHaveBeenNthCalledWith(2, 'detail', { id: 'user-1' });
  });

  it('passes data from named $steps references', async () => {
    const workflow: WorkflowSpec = {
      steps: [
        { skillId: 'search', name: 'search', paramMapping: { query: '$initial.query' } },
        { skillId: 'detail', name: 'detail', paramMapping: { id: '$steps.search.data.results[0].id' } },
        { skillId: 'summary', paramMapping: { text: '$steps.detail.data.summary' } },
      ],
    };
    const repo = makeRepo({
      search: makeSkill('search'),
      detail: makeSkill('detail'),
      summary: makeSkill('summary'),
    });
    const executeStep = vi.fn()
      .mockResolvedValueOnce({ success: true, data: { results: [{ id: 'r1' }] }, latencyMs: 1 })
      .mockResolvedValueOnce({ success: true, data: { summary: 'ok' }, latencyMs: 1 })
      .mockResolvedValueOnce({ success: true, data: { done: true }, latencyMs: 1 });

    const result = await executeWorkflow(workflow, { query: 'ada' }, executeStep, repo as any);
    expect(result.success).toBe(true);
    expect(executeStep).toHaveBeenNthCalledWith(2, 'detail', { id: 'r1' });
    expect(executeStep).toHaveBeenNthCalledWith(3, 'summary', { text: 'ok' });
  });

  it('returns partial results when a later step fails', async () => {
    const workflow: WorkflowSpec = {
      steps: [
        { skillId: 'search', name: 'search', paramMapping: { query: '$initial.query' } },
        { skillId: 'detail', name: 'detail', paramMapping: { id: '$prev.data.id' } },
      ],
    };
    const repo = makeRepo({
      search: makeSkill('search'),
      detail: makeSkill('detail'),
    });
    const executeStep = vi.fn()
      .mockResolvedValueOnce({ success: true, data: { id: 'user-1' }, latencyMs: 1 })
      .mockResolvedValueOnce({ success: false, error: 'detail failed', failureCause: 'unknown', latencyMs: 1 });

    const result = await executeWorkflow(workflow, { query: 'ada' }, executeStep, repo as any);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.failedAtStep).toBe('detail');
      expect(result.data.steps).toHaveLength(2);
      expect(result.data.steps[0].success).toBe(true);
      expect(result.data.steps[1].success).toBe(false);
    }
  });

  it('fails loudly on undefined param paths', async () => {
    const workflow: WorkflowSpec = {
      steps: [
        { skillId: 'search', name: 'search', paramMapping: { query: '$initial.query' } },
        { skillId: 'detail', name: 'detail', paramMapping: { id: '$steps.search.data.missing.id' } },
      ],
    };
    const repo = makeRepo({
      search: makeSkill('search'),
      detail: makeSkill('detail'),
    });
    const executeStep = vi.fn()
      .mockResolvedValueOnce({ success: true, data: { results: [] }, latencyMs: 1 });

    const result = await executeWorkflow(workflow, { query: 'ada' }, executeStep, repo as any);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("resolved to undefined");
      expect(result.failedAtStep).toBe('detail');
    }
  });

  it('applies per-step transforms without double-transforming later lookups', async () => {
    const workflow: WorkflowSpec = {
      steps: [
        {
          skillId: 'search',
          name: 'search',
          paramMapping: { query: '$initial.query' },
          transform: { type: 'jsonpath', expression: '$.items[0].id' },
        },
        { skillId: 'detail', paramMapping: { id: '$prev.data' } },
      ],
    };
    const repo = makeRepo({
      search: makeSkill('search'),
      detail: makeSkill('detail'),
    });
    const executeStep = vi.fn()
      .mockResolvedValueOnce({ success: true, data: { items: [{ id: 'user-1' }] }, latencyMs: 1 })
      .mockResolvedValueOnce({ success: true, data: { done: true }, latencyMs: 1 });

    const result = await executeWorkflow(workflow, { query: 'ada' }, executeStep, repo as any);

    expect(result.success).toBe(true);
    expect(executeStep).toHaveBeenNthCalledWith(2, 'detail', { id: 'user-1' });
  });

  it('rejects write skills during preflight', async () => {
    const workflow: WorkflowSpec = {
      steps: [{ skillId: 'write-step' }],
    };
    const repo = makeRepo({
      'write-step': makeSkill('write-step', { sideEffectClass: SideEffectClass.NON_IDEMPOTENT }),
    });
    const executeStep = vi.fn();

    const result = await executeWorkflow(workflow, {}, executeStep, repo as any);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('not read-only');
    }
    expect(executeStep).not.toHaveBeenCalled();
  });

  it('rejects nested workflows during preflight', async () => {
    const workflow: WorkflowSpec = {
      steps: [{ skillId: 'nested' }],
    };
    const repo = makeRepo({
      nested: makeSkill('nested', { workflowSpec: { steps: [] } }),
    });

    const result = await executeWorkflow(workflow, {}, vi.fn(), repo as any);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('cannot reference another workflow');
    }
  });

  it('rejects inactive step skills during preflight', async () => {
    const workflow: WorkflowSpec = {
      steps: [{ skillId: 'draft-step' }],
    };
    const repo = makeRepo({
      'draft-step': makeSkill('draft-step', { status: SkillStatus.DRAFT }),
    });

    const result = await executeWorkflow(workflow, {}, vi.fn(), repo as any);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('not active');
    }
  });

  it('rejects unknown named step references during preflight', async () => {
    const workflow: WorkflowSpec = {
      steps: [
        { skillId: 'detail', name: 'detail', paramMapping: { id: '$steps.search.data.id' } },
      ],
    };
    const repo = makeRepo({
      detail: makeSkill('detail'),
    });
    const executeStep = vi.fn();

    const result = await executeWorkflow(workflow, {}, executeStep, repo as any);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("unknown step 'search'");
      expect(result.failedAtStep).toBe('detail');
    }
    expect(executeStep).not.toHaveBeenCalled();
  });

  it('rejects $prev references in the first step during preflight', async () => {
    const workflow: WorkflowSpec = {
      steps: [
        { skillId: 'detail', name: 'detail', paramMapping: { id: '$prev.data.id' } },
      ],
    };
    const repo = makeRepo({
      detail: makeSkill('detail'),
    });
    const executeStep = vi.fn();

    const result = await executeWorkflow(workflow, {}, executeStep, repo as any);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('there is no previous step result');
      expect(result.failedAtStep).toBe('detail');
    }
    expect(executeStep).not.toHaveBeenCalled();
  });

  it('propagates browser handoff results from a step without wrapping', async () => {
    const workflow: WorkflowSpec = {
      steps: [{ skillId: 'search' }],
    };
    const repo = makeRepo({
      search: makeSkill('search'),
    });

    const result = await executeWorkflow(workflow, {}, vi.fn().mockResolvedValue({
      success: false,
      status: 'browser_handoff_required',
      siteId: 'example.com',
      url: 'https://example.com',
      hint: 'Complete login',
      latencyMs: 1,
    }), repo as any);

    expect('status' in result && result.status === 'browser_handoff_required').toBe(true);
    if ('status' in result && result.status === 'browser_handoff_required') {
      expect(result.hint).toBe('Complete login');
    }
  });

  it('retries a rate-limited workflow step once before succeeding', async () => {
    vi.useFakeTimers();

    try {
      const workflow: WorkflowSpec = {
        steps: [
          { skillId: 'search', name: 'search', paramMapping: { query: '$initial.query' } },
          { skillId: 'detail', name: 'detail', paramMapping: { id: '$prev.data.id' } },
        ],
      };
      const repo = makeRepo({
        search: makeSkill('search'),
        detail: makeSkill('detail'),
      });
      const executeStep = vi.fn()
        .mockResolvedValueOnce({ success: true, data: { id: 'user-1' }, latencyMs: 1 })
        .mockResolvedValueOnce({
          success: false,
          error: 'rate limited',
          failureCause: 'rate_limited',
          failureDetail: 'Retry after 100ms',
          latencyMs: 1,
        })
        .mockResolvedValueOnce({ success: true, data: { name: 'Ada' }, latencyMs: 1 });

      const resultPromise = executeWorkflow(workflow, { query: 'ada' }, executeStep, repo as any);
      await vi.advanceTimersByTimeAsync(150);
      const result = await resultPromise;

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toEqual({ name: 'Ada' });
      }
      expect(executeStep).toHaveBeenCalledTimes(3);
      expect(executeStep).toHaveBeenNthCalledWith(2, 'detail', { id: 'user-1' });
      expect(executeStep).toHaveBeenNthCalledWith(3, 'detail', { id: 'user-1' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('returns the final rate-limit failure when the retry also fails', async () => {
    vi.useFakeTimers();

    try {
      const workflow: WorkflowSpec = {
        steps: [
          { skillId: 'search', name: 'search', paramMapping: { query: '$initial.query' } },
          { skillId: 'detail', name: 'detail', paramMapping: { id: '$prev.data.id' } },
        ],
      };
      const repo = makeRepo({
        search: makeSkill('search'),
        detail: makeSkill('detail'),
      });
      const executeStep = vi.fn()
        .mockResolvedValueOnce({ success: true, data: { id: 'user-1' }, latencyMs: 1 })
        .mockResolvedValueOnce({
          success: false,
          error: 'rate limited',
          failureCause: 'rate_limited',
          failureDetail: 'Retry after 100ms',
          latencyMs: 1,
        })
        .mockResolvedValueOnce({
          success: false,
          error: 'still rate limited',
          failureCause: 'rate_limited',
          failureDetail: 'Retry after 100ms',
          latencyMs: 1,
        });

      const resultPromise = executeWorkflow(workflow, { query: 'ada' }, executeStep, repo as any);
      await vi.advanceTimersByTimeAsync(150);
      const result = await resultPromise;

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.failedAtStep).toBe('detail');
        expect(result.error).toBe('still rate limited');
        expect(result.failureCause).toBe('rate_limited');
      }
      expect(executeStep).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reuses cached step results within the ttl window across workflow runs', async () => {
    const workflow: WorkflowSpec = {
      steps: [
        { skillId: 'search', name: 'search-1', paramMapping: { query: '$initial.query' }, cache: { ttlMs: 1_000 } },
      ],
    };
    const repo = makeRepo({
      search: makeSkill('search'),
    });
    const executeStep = vi.fn().mockResolvedValue({
      success: true,
      data: { items: [{ id: 'user-1' }] },
      latencyMs: 1,
    });
    const cache: WorkflowStepCacheStore = new Map();

    const first = await executeWorkflow(workflow, { query: 'ada' }, executeStep, repo as any, cache);
    const second = await executeWorkflow(workflow, { query: 'ada' }, executeStep, repo as any, cache);
    expect(first.success).toBe(true);
    expect(second.success).toBe(true);
    expect(executeStep).toHaveBeenCalledTimes(1);
  });

  it('does not reuse cached entries across workflows when ttl contracts differ', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));

    try {
      const longTtlWorkflow: WorkflowSpec = {
        steps: [
          { skillId: 'search', name: 'search', paramMapping: { query: '$initial.query' }, cache: { ttlMs: 60_000 } },
        ],
      };
      const shortTtlWorkflow: WorkflowSpec = {
        steps: [
          { skillId: 'search', name: 'search', paramMapping: { query: '$initial.query' }, cache: { ttlMs: 1_000 } },
        ],
      };
      const repo = makeRepo({
        search: makeSkill('search'),
      });
      const executeStep = vi.fn().mockResolvedValue({
        success: true,
        data: { items: [{ id: 'user-1' }] },
        latencyMs: 1,
      });
      const cache: WorkflowStepCacheStore = new Map();

      await executeWorkflow(longTtlWorkflow, { query: 'ada' }, executeStep, repo as any, cache);
      vi.advanceTimersByTime(1_500);
      await executeWorkflow(shortTtlWorkflow, { query: 'ada' }, executeStep, repo as any, cache);

      expect(executeStep).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reuses cached entries across workflows when a later ttl contract is longer and the result is still fresh', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));

    try {
      const shortTtlWorkflow: WorkflowSpec = {
        steps: [
          { skillId: 'search', name: 'search', paramMapping: { query: '$initial.query' }, cache: { ttlMs: 1_000 } },
        ],
      };
      const longTtlWorkflow: WorkflowSpec = {
        steps: [
          { skillId: 'search', name: 'search', paramMapping: { query: '$initial.query' }, cache: { ttlMs: 60_000 } },
        ],
      };
      const repo = makeRepo({
        search: makeSkill('search'),
      });
      const executeStep = vi.fn().mockResolvedValue({
        success: true,
        data: { items: [{ id: 'user-1' }] },
        latencyMs: 1,
      });
      const cache: WorkflowStepCacheStore = new Map();

      await executeWorkflow(shortTtlWorkflow, { query: 'ada' }, executeStep, repo as any, cache);
      vi.advanceTimersByTime(500);
      await executeWorkflow(longTtlWorkflow, { query: 'ada' }, executeStep, repo as any, cache);

      expect(executeStep).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('prunes expired cache entries even when later workflows use different keys', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));

    try {
      const workflow: WorkflowSpec = {
        steps: [
          { skillId: 'search', name: 'search', paramMapping: { query: '$initial.query' }, cache: { ttlMs: 1_000 } },
        ],
      };
      const repo = makeRepo({
        search: makeSkill('search'),
      });
      const executeStep = vi.fn().mockResolvedValue({
        success: true,
        data: { items: [{ id: 'user-1' }] },
        latencyMs: 1,
      });
      const cache: WorkflowStepCacheStore = new Map();

      await executeWorkflow(workflow, { query: 'ada' }, executeStep, repo as any, cache);
      expect(Array.from(cache.entries())).toHaveLength(1);

      vi.advanceTimersByTime(24 * 60 * 60 * 1000 + 1);
      await executeWorkflow(workflow, { query: 'grace' }, executeStep, repo as any, cache);

      const entries = Array.from(cache.entries());
      expect(entries).toHaveLength(1);
      expect(entries[0][0]).toContain('"grace"');
    } finally {
      vi.useRealTimers();
    }
  });

  it('applies per-step transforms after cache lookup so steps do not contaminate each other', async () => {
    const workflow: WorkflowSpec = {
      steps: [
        {
          skillId: 'search',
          name: 'price',
          paramMapping: { query: '$initial.query' },
          cache: { ttlMs: 1_000 },
          transform: { type: 'regex', expression: 'price=(?<price>\\d+)' },
        },
        {
          skillId: 'search',
          name: 'currency',
          paramMapping: { query: '$initial.query' },
          cache: { ttlMs: 1_000 },
          transform: { type: 'regex', expression: 'currency=(?<currency>[A-Z]+)' },
        },
      ],
    };
    const repo = makeRepo({
      search: makeSkill('search'),
    });
    const executeStep = vi.fn().mockResolvedValue({
      success: true,
      data: 'price=123 currency=USD',
      latencyMs: 1,
    });

    const result = await executeWorkflow(workflow, { query: 'ada' }, executeStep, repo as any);

    expect(result.success).toBe(true);
    expect(executeStep).toHaveBeenCalledTimes(1);
    if (result.success) {
      expect(result.stepResults[0].data).toEqual({ price: '123' });
      expect(result.stepResults[1].data).toEqual({ currency: 'USD' });
      expect(result.data).toEqual({ currency: 'USD' });
    }
  });
});
