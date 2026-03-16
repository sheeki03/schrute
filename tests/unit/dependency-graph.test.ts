import { describe, it, expect } from 'vitest';
import { buildDependencyGraph, getCascadeAffected, getDependencies, getDependents } from '../../src/skill/dependency-graph.js';
import type { SkillSpec } from '../../src/skill/types.js';

// Create minimal skill specs for testing
function makeSkill(overrides: Partial<SkillSpec>): SkillSpec {
  return {
    id: 'test', siteId: 'example.com', name: 'test', version: 1,
    status: 'active', method: 'GET', pathTemplate: '/api/test',
    inputSchema: {}, sideEffectClass: 'read-only', currentTier: 'tier_3',
    tierLock: null, confidence: 1, consecutiveValidations: 5, sampleCount: 10,
    successRate: 1, createdAt: Date.now(), updatedAt: Date.now(),
    allowedDomains: ['example.com'], requiredCapabilities: [],
    parameters: [], validation: { semanticChecks: [], customInvariants: [] },
    redaction: { piiClassesFound: [], fieldsRedacted: 0 },
    replayStrategy: 'prefer_tier_3', directCanaryEligible: false,
    isComposite: false,
    ...overrides,
  } as SkillSpec;
}

describe('Skill Dependency Graph', () => {
  it('detects chain_ref dependencies', () => {
    const skills = [
      makeSkill({ id: 'A', chainSpec: { steps: [{ skillRef: 'B', extractsFrom: [] }], canReplayWithCookiesOnly: true } }),
      makeSkill({ id: 'B' }),
    ];
    const graph = buildDependencyGraph(skills);
    expect(graph.edges).toHaveLength(1);
    expect(graph.edges[0]).toEqual({ from: 'A', to: 'B', reason: 'chain_ref' });
  });

  it('detects shared_auth dependencies', () => {
    const skills = [
      makeSkill({ id: 'A', siteId: 'site1', authType: 'cookie' }),
      makeSkill({ id: 'B', siteId: 'site1', authType: 'cookie' }),
      makeSkill({ id: 'C', siteId: 'site2', authType: 'cookie' }),
    ];
    const graph = buildDependencyGraph(skills);
    const authEdges = graph.edges.filter(e => e.reason === 'shared_auth');
    expect(authEdges).toHaveLength(1); // A-B only, not C
  });

  it('cascades through dependents', () => {
    const skills = [
      makeSkill({ id: 'A' }),
      makeSkill({ id: 'B', chainSpec: { steps: [{ skillRef: 'A', extractsFrom: [] }], canReplayWithCookiesOnly: true } }),
      makeSkill({ id: 'C', chainSpec: { steps: [{ skillRef: 'B', extractsFrom: [] }], canReplayWithCookiesOnly: true } }),
    ];
    const graph = buildDependencyGraph(skills);
    const affected = getCascadeAffected(graph, 'A');
    expect(affected).toContain('B');
    expect(affected).toContain('C');
    expect(affected).not.toContain('A');
  });

  it('returns empty for no dependencies', () => {
    const graph = buildDependencyGraph([makeSkill({ id: 'lonely' })]);
    expect(getDependencies(graph, 'lonely')).toEqual([]);
    expect(getDependents(graph, 'lonely')).toEqual([]);
  });
});
