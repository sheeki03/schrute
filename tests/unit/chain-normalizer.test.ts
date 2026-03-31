import { describe, it, expect } from 'vitest';
import { normalizeChainRefs } from '../../src/capture/chain-normalizer.js';
import type { SkillSpec } from '../../src/skill/types.js';

function makeSkill(overrides: Partial<SkillSpec> & { id: string }): SkillSpec {
  return {
    version: 1,
    status: 'active',
    currentTier: 'tier_3',
    tierLock: null,
    allowedDomains: ['api.example.com'],
    requiredCapabilities: [],
    parameters: [],
    validation: { semanticChecks: [], customInvariants: [] },
    redaction: { piiClassesFound: [], fieldsRedacted: 0 },
    replayStrategy: 'prefer_tier_3',
    sideEffectClass: 'read-only',
    sampleCount: 1,
    consecutiveValidations: 0,
    confidence: 0.5,
    method: 'GET',
    pathTemplate: '/data',
    inputSchema: {},
    isComposite: false,
    siteId: 'example.com',
    name: 'get_data',
    successRate: 1.0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

describe('chain-normalizer', () => {
  it('resolves new format refs (METHOD host /path) to skill IDs', () => {
    const skills = [
      makeSkill({
        id: 'example.com.get_auth.v1',
        method: 'POST',
        pathTemplate: '/auth/login',
        allowedDomains: ['api.example.com'],
        name: 'get_auth',
      }),
      makeSkill({
        id: 'example.com.get_data.v1',
        method: 'GET',
        pathTemplate: '/data',
        allowedDomains: ['api.example.com'],
        name: 'get_data',
        chainSpec: {
          steps: [
            { skillRef: 'POST api.example.com /auth/login', extractsFrom: [] },
            { skillRef: 'GET api.example.com /data', extractsFrom: [{ responsePath: 'body.token', injectsInto: { location: 'header', path: 'authorization' } }] },
          ],
          canReplayWithCookiesOnly: false,
        },
      }),
    ];

    const count = normalizeChainRefs(skills);
    expect(count).toBe(2);
    expect(skills[1].chainSpec!.steps[0].skillRef).toBe('example.com.get_auth.v1');
    expect(skills[1].chainSpec!.steps[1].skillRef).toBe('example.com.get_data.v1');
  });

  it('falls back to legacy format (METHOD /path) when host does not match', () => {
    const skills = [
      makeSkill({
        id: 'example.com.get_items.v1',
        method: 'GET',
        pathTemplate: '/items',
        allowedDomains: ['api.example.com'],
        name: 'get_items',
      }),
      makeSkill({
        id: 'example.com.chain_skill.v1',
        method: 'GET',
        pathTemplate: '/chain',
        allowedDomains: ['api.example.com'],
        name: 'chain_skill',
        chainSpec: {
          steps: [
            { skillRef: 'GET /items', extractsFrom: [] },
            { skillRef: 'GET /chain', extractsFrom: [] },
          ],
          canReplayWithCookiesOnly: false,
        },
      }),
    ];

    const count = normalizeChainRefs(skills);
    expect(count).toBe(2);
    expect(skills[1].chainSpec!.steps[0].skillRef).toBe('example.com.get_items.v1');
  });

  it('handles multi-host chains', () => {
    const skills = [
      makeSkill({
        id: 'site.auth.v1',
        method: 'POST',
        pathTemplate: '/auth',
        allowedDomains: ['auth.example.com'],
        name: 'auth',
      }),
      makeSkill({
        id: 'site.data.v1',
        method: 'GET',
        pathTemplate: '/data',
        allowedDomains: ['api.example.com'],
        name: 'data',
        chainSpec: {
          steps: [
            { skillRef: 'POST auth.example.com /auth', extractsFrom: [] },
            { skillRef: 'GET api.example.com /data', extractsFrom: [{ responsePath: 'body.token', injectsInto: { location: 'header', path: 'authorization' } }] },
          ],
          canReplayWithCookiesOnly: false,
        },
      }),
    ];

    const count = normalizeChainRefs(skills);
    expect(count).toBe(2);
    expect(skills[1].chainSpec!.steps[0].skillRef).toBe('site.auth.v1');
    expect(skills[1].chainSpec!.steps[1].skillRef).toBe('site.data.v1');
  });

  it('backfill: resolves refs that contain spaces', () => {
    const skills = [
      makeSkill({
        id: 'site.login.v1',
        method: 'POST',
        pathTemplate: '/login',
        allowedDomains: ['example.com'],
        name: 'login',
      }),
      makeSkill({
        id: 'site.profile.v1',
        method: 'GET',
        pathTemplate: '/profile',
        allowedDomains: ['example.com'],
        name: 'profile',
        chainSpec: {
          steps: [
            { skillRef: 'POST example.com /login', extractsFrom: [] },
            { skillRef: 'GET example.com /profile', extractsFrom: [] },
          ],
          canReplayWithCookiesOnly: false,
        },
      }),
    ];

    // Verify refs contain spaces before normalization
    expect(skills[1].chainSpec!.steps[0].skillRef).toContain(' ');

    const count = normalizeChainRefs(skills);
    expect(count).toBe(2);

    // After normalization, no spaces
    expect(skills[1].chainSpec!.steps[0].skillRef).not.toContain(' ');
    expect(skills[1].chainSpec!.steps[1].skillRef).not.toContain(' ');
  });

  it('leaves unresolvable refs as-is', () => {
    const skills = [
      makeSkill({
        id: 'site.other.v1',
        method: 'GET',
        pathTemplate: '/other',
        allowedDomains: ['example.com'],
        name: 'other',
        chainSpec: {
          steps: [
            { skillRef: 'DELETE unknown.host /nonexistent', extractsFrom: [] },
            { skillRef: 'GET example.com /other', extractsFrom: [] },
          ],
          canReplayWithCookiesOnly: false,
        },
      }),
    ];

    const count = normalizeChainRefs(skills);
    // Only the second ref is resolved
    expect(count).toBe(1);
    expect(skills[0].chainSpec!.steps[0].skillRef).toBe('DELETE unknown.host /nonexistent');
    expect(skills[0].chainSpec!.steps[1].skillRef).toBe('site.other.v1');
  });

  it('resolves collisions deterministically by preferring better status/version', () => {
    const skills = [
      makeSkill({
        id: 'site.data.v1',
        version: 1,
        status: 'draft',
        method: 'GET',
        pathTemplate: '/data',
        allowedDomains: ['api.example.com'],
        name: 'data_v1',
      }),
      makeSkill({
        id: 'site.data.v2',
        version: 2,
        status: 'active',
        method: 'GET',
        pathTemplate: '/data',
        allowedDomains: ['api.example.com'],
        name: 'data_v2',
      }),
      makeSkill({
        id: 'site.chain.v1',
        method: 'GET',
        pathTemplate: '/chain',
        allowedDomains: ['api.example.com'],
        name: 'chain',
        chainSpec: {
          steps: [
            { skillRef: 'GET api.example.com /data', extractsFrom: [] },
            { skillRef: 'GET api.example.com /chain', extractsFrom: [] },
          ],
          canReplayWithCookiesOnly: false,
        },
      }),
    ];

    const count = normalizeChainRefs(skills);
    expect(count).toBe(2);
    expect(skills[2].chainSpec!.steps[0].skillRef).toBe('site.data.v2');
  });
});
