/**
 * v0.2 Acceptance — 3-site mock scenarios
 *
 * Tests cooperative site (clean REST, Tier 1), GraphQL site
 * (operationName clustering), and hostile site (CSRF tokens, Tier 3 locked)
 * through the shared router.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { makeSkill, makeSitePolicy, makeTestConfig } from '../helpers.js';

// Helper to create a mock confirmation manager for router tests
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

// ─── Scenario 1: Cooperative Site (Clean REST, Tier 1) ────────────

describe('v0.2 Scenarios — Cooperative Site', () => {
  it('skill is Tier 1 promoted with high confidence', () => {
    const skill = makeSkill({
      siteId: 'shop.example.com',
      name: 'list_products',
      method: 'GET',
      pathTemplate: '/api/products',
      currentTier: 'tier_1',
      confidence: 0.98,
      consecutiveValidations: 10,
      successRate: 0.99,
      sideEffectClass: 'read-only',
    });

    expect(skill.currentTier).toBe('tier_1');
    expect(skill.confidence).toBeGreaterThan(0.9);
    expect(skill.consecutiveValidations).toBeGreaterThanOrEqual(5);
  });

  it('GET method is always allowed for cooperative site', async () => {
    const { checkMethodAllowed } = await import('../../src/core/policy.js');
    expect(checkMethodAllowed('shop.example.com', 'GET')).toBe(true);
  });

  it('safe paths pass risk check', async () => {
    const { checkPathRisk } = await import('../../src/core/policy.js');
    expect(checkPathRisk('GET', '/api/products').blocked).toBe(false);
    expect(checkPathRisk('GET', '/api/products/123').blocked).toBe(false);
    expect(checkPathRisk('GET', '/api/categories').blocked).toBe(false);
  });

  it('router executes confirmed cooperative skill', async () => {
    const { createRouter } = await import('../../src/server/router.js');

    const skill = makeSkill({
      siteId: 'shop.example.com',
      name: 'list_products',
      consecutiveValidations: 5,
      parameters: [],
    });

    const mockEngine = {
      getStatus: () => ({ mode: 'idle', activeSession: null, currentRecording: null, uptime: 1000 }),
      executeSkill: async () => ({ success: true, data: { products: [] }, latencyMs: 15 }),
    } as any;

    const mockSkillRepo = {
      getBySiteId: (siteId: string) => siteId === 'shop.example.com' ? [skill] : [],
      getByStatus: () => [],
    } as any;

    // Skill must be confirmed before execution (all skills require confirmation now)
    const confirmation = makeConfirmationManager();
    (confirmation.isSkillConfirmed as ReturnType<typeof vi.fn>).mockReturnValue(true);

    const router = createRouter({
      engine: mockEngine,
      skillRepo: mockSkillRepo,
      siteRepo: { getAll: () => [], getById: () => null } as any,
      config: makeTestConfig() as any,
      confirmation: confirmation as any,
    });

    const result = await router.executeSkill('shop.example.com', 'list_products', {});
    expect(result.success).toBe(true);
  });

  it('dry run for cooperative site produces clean preview', async () => {
    const { createRouter } = await import('../../src/server/router.js');

    const skill = makeSkill({
      siteId: 'shop.example.com',
      name: 'list_products',
      parameters: [],
    });

    const router = createRouter({
      engine: { getStatus: () => ({}) } as any,
      skillRepo: {
        getBySiteId: (siteId: string) => siteId === 'shop.example.com' ? [skill] : [],
        getByStatus: () => [],
      } as any,
      siteRepo: { getAll: () => [], getById: () => null } as any,
      config: makeTestConfig() as any,
      confirmation: makeConfirmationManager() as any,
    });

    const result = await router.dryRunSkill('shop.example.com', 'list_products', {});
    expect(result.success).toBe(true);
    expect((result.data as any).note).toContain('preview');
  });
});

// ─── Scenario 2: GraphQL Site (operationName Clustering) ──────────

describe('v0.2 Scenarios — GraphQL Site', () => {
  it('GraphQL skill has POST method with read-only side effect', () => {
    const skill = makeSkill({
      siteId: 'graphql.example.com',
      name: 'query_users',
      method: 'POST',
      pathTemplate: '/graphql',
      sideEffectClass: 'read-only',
      currentTier: 'tier_3',
    });

    expect(skill.method).toBe('POST');
    expect(skill.sideEffectClass).toBe('read-only');
    expect(skill.pathTemplate).toBe('/graphql');
  });

  it('POST with read-only side-effect is allowed', async () => {
    const { checkMethodAllowed } = await import('../../src/core/policy.js');
    expect(checkMethodAllowed('graphql.example.com', 'POST', 'read-only')).toBe(true);
  });

  it('POST with non-idempotent side-effect is blocked by default', async () => {
    const { checkMethodAllowed } = await import('../../src/core/policy.js');
    expect(checkMethodAllowed('graphql.example.com', 'POST', 'non-idempotent')).toBe(false);
  });

  it('GraphQL skills cluster by operationName', () => {
    const querySkill = makeSkill({
      siteId: 'graphql.example.com',
      name: 'GetUsers',
      method: 'POST',
      pathTemplate: '/graphql',
    });

    const mutationSkill = makeSkill({
      siteId: 'graphql.example.com',
      name: 'CreateUser',
      method: 'POST',
      pathTemplate: '/graphql',
      sideEffectClass: 'non-idempotent',
    });

    // Different operations share the same pathTemplate (/graphql)
    expect(querySkill.pathTemplate).toBe(mutationSkill.pathTemplate);
    // But have different names (operationName clustering)
    expect(querySkill.name).not.toBe(mutationSkill.name);
  });

  it('mutation paths blocked in GraphQL', async () => {
    const { checkPathRisk } = await import('../../src/core/policy.js');
    // /mutation path is flagged by DESTRUCTIVE_POST_PATTERNS
    expect(checkPathRisk('POST', '/mutation').blocked).toBe(true);
  });

  it('router handles non-existent GraphQL skill gracefully', async () => {
    const { createRouter } = await import('../../src/server/router.js');

    const router = createRouter({
      engine: { getStatus: () => ({}) } as any,
      skillRepo: { getBySiteId: () => [], getByStatus: () => [] } as any,
      siteRepo: { getAll: () => [], getById: () => null } as any,
      config: makeTestConfig() as any,
      confirmation: makeConfirmationManager() as any,
    });

    const result = await router.executeSkill('graphql.example.com', 'NonExistent', {});
    expect(result.success).toBe(false);
    expect(result.statusCode).toBe(404);
  });
});

// ─── Scenario 3: Hostile Site (CSRF tokens, Tier 3 locked) ────────

describe('v0.2 Scenarios — Hostile Site', () => {
  it('hostile skill is Tier 3 locked permanently', () => {
    const skill = makeSkill({
      siteId: 'hostile.example.com',
      name: 'submit_form',
      method: 'POST',
      pathTemplate: '/api/submit',
      currentTier: 'tier_3',
      tierLock: {
        type: 'permanent',
        reason: 'js_computed_field',
        evidence: 'CSRF token computed by JavaScript',
      },
      sideEffectClass: 'non-idempotent',
      confidence: 0.6,
      consecutiveValidations: 0,
    });

    expect(skill.currentTier).toBe('tier_3');
    expect(skill.tierLock).not.toBeNull();
    expect(skill.tierLock!.type).toBe('permanent');
    expect((skill.tierLock as any).reason).toBe('js_computed_field');
  });

  it('unvalidated hostile skill requires confirmation', async () => {
    const { createRouter } = await import('../../src/server/router.js');

    const skill = makeSkill({
      siteId: 'hostile.example.com',
      name: 'submit_form',
      method: 'POST',
      status: 'active',
      consecutiveValidations: 0,
      sideEffectClass: 'non-idempotent',
      parameters: [],
    });

    const router = createRouter({
      engine: { getStatus: () => ({}) } as any,
      skillRepo: {
        getBySiteId: (siteId: string) => siteId === 'hostile.example.com' ? [skill] : [],
        getByStatus: () => [],
      } as any,
      siteRepo: { getAll: () => [], getById: () => null } as any,
      config: makeTestConfig() as any,
      confirmation: makeConfirmationManager() as any,
    });

    // POST method not allowed by default (non-idempotent side effect)
    // But the router first checks if skill exists and is active
    const result = await router.executeSkill('hostile.example.com', 'submit_form', {});
    // With consecutiveValidations=0, should require confirmation (statusCode=202)
    expect(result.statusCode).toBe(202);
    expect((result.data as any).status).toBe('confirmation_required');
  });

  it('hostile site domain enforcement', async () => {
    const { enforceDomainAllowlist, setSitePolicy } = await import('../../src/core/policy.js');

    setSitePolicy(makeSitePolicy({
      siteId: 'hostile.example.com',
      domainAllowlist: ['hostile.example.com'],
    }));

    // Hostile site tries to redirect to different domain
    const crossDomain = enforceDomainAllowlist('hostile.example.com', 'evil.com');
    expect(crossDomain.allowed).toBe(false);

    // Same domain is fine
    const sameDomain = enforceDomainAllowlist('hostile.example.com', 'hostile.example.com');
    expect(sameDomain.allowed).toBe(true);
  });

  it('redirect to malicious domain is blocked', async () => {
    const { checkRedirectAllowed, setSitePolicy } = await import('../../src/core/policy.js');

    setSitePolicy(makeSitePolicy({
      siteId: 'hostile-redirect.example.com',
      domainAllowlist: ['hostile-redirect.example.com'],
    }));

    const result = checkRedirectAllowed('hostile-redirect.example.com', 'https://evil.com/phish');
    expect(result.allowed).toBe(false);
  });

  it('confirmation token flow for hostile skill', async () => {
    const { createRouter } = await import('../../src/server/router.js');

    const skill = makeSkill({
      siteId: 'hostile.example.com',
      name: 'risky_action',
      status: 'active',
      consecutiveValidations: 0,
      sideEffectClass: 'non-idempotent',
      parameters: [],
    });

    const config = makeTestConfig();
    const confirmation = makeConfirmationManager();

    const router = createRouter({
      engine: { getStatus: () => ({}) } as any,
      skillRepo: {
        getBySiteId: (siteId: string) => siteId === 'hostile.example.com' ? [skill] : [],
        getByStatus: () => [],
      } as any,
      siteRepo: { getAll: () => [], getById: () => null } as any,
      config: config as any,
      confirmation: confirmation as any,
    });

    // Step 1: Execute → get confirmation token
    const result = await router.executeSkill('hostile.example.com', 'risky_action', {});
    expect(result.statusCode).toBe(202);
    const token = (result.data as any).confirmationToken;
    expect(token).toBeDefined();

    // Step 2: Confirm → approve
    const confirmResult = router.confirm(token, true);
    expect(confirmResult.success).toBe(true);
    expect((confirmResult.data as any).status).toBe('approved');

    // Step 3: Token is consumed — cannot reuse
    const reuse = router.confirm(token, true);
    expect(reuse.success).toBe(false);
    expect(reuse.error).toContain('consumed');
  });

  it('denied confirmation returns denial status', async () => {
    const { createRouter } = await import('../../src/server/router.js');

    const skill = makeSkill({
      siteId: 'hostile.example.com',
      name: 'denied_action',
      status: 'active',
      consecutiveValidations: 0,
      sideEffectClass: 'non-idempotent',
      parameters: [],
    });

    const confirmation = makeConfirmationManager();

    const router = createRouter({
      engine: { getStatus: () => ({}) } as any,
      skillRepo: {
        getBySiteId: (siteId: string) => siteId === 'hostile.example.com' ? [skill] : [],
        getByStatus: () => [],
      } as any,
      siteRepo: { getAll: () => [], getById: () => null } as any,
      config: makeTestConfig() as any,
      confirmation: confirmation as any,
    });

    const result = await router.executeSkill('hostile.example.com', 'denied_action', {});
    const token = (result.data as any).confirmationToken;

    const denyResult = router.confirm(token, false);
    expect(denyResult.success).toBe(true);
    expect((denyResult.data as any).status).toBe('denied');
  });
});
