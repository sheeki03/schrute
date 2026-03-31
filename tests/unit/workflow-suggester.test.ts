import { describe, it, expect } from 'vitest';
import { suggestWorkflows } from '../../src/capture/workflow-suggester.js';
import type { SkillSpec, RequestChain } from '../../src/skill/types.js';

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

describe('workflow-suggester', () => {
  it('suggests a 2-step workflow with $prev provenance', () => {
    const skillA = makeSkill({ id: 'a', name: 'get_token', method: 'GET', pathTemplate: '/token' });
    const skillB = makeSkill({
      id: 'b',
      name: 'get_data',
      method: 'GET',
      pathTemplate: '/data',
      chainSpec: {
        steps: [
          { skillRef: 'a', extractsFrom: [], captureIndex: 0 },
          {
            skillRef: 'b',
            extractsFrom: [{
              responsePath: 'body.token',
              injectsInto: { location: 'header', path: 'authorization' },
              sourceStepIndex: 0,
            }],
            captureIndex: 1,
          },
        ],
        canReplayWithCookiesOnly: false,
      },
    });

    const suggestions = suggestWorkflows([skillA, skillB]);
    expect(suggestions.length).toBe(1);
    const wf = suggestions[0].workflowSpec;
    expect(wf.steps.length).toBe(2);
    expect(wf.steps[0].skillId).toBe('a');
    expect(wf.steps[1].skillId).toBe('b');
    // sourceStepIndex 0 is previous step (i-1 === 0 when i=1), so $prev
    expect(wf.steps[1].paramMapping!['authorization']).toBe('$prev.data.token');
  });

  it('suggests a 3-step workflow with non-adjacent $steps.<name> provenance', () => {
    const skillA = makeSkill({ id: 'a', name: 'get_token', method: 'GET', pathTemplate: '/token' });
    const skillB = makeSkill({ id: 'b', name: 'get_session', method: 'GET', pathTemplate: '/session' });
    const skillC = makeSkill({
      id: 'c',
      name: 'get_result',
      method: 'GET',
      pathTemplate: '/result',
      chainSpec: {
        steps: [
          { skillRef: 'a', extractsFrom: [], captureIndex: 0 },
          { skillRef: 'b', extractsFrom: [{
            responsePath: 'body.token',
            injectsInto: { location: 'header', path: 'auth' },
            sourceStepIndex: 0,
          }], captureIndex: 1 },
          { skillRef: 'c', extractsFrom: [{
            responsePath: 'body.sessionId',
            injectsInto: { location: 'query', path: 'session' },
            sourceStepIndex: 0, // non-adjacent: from step 0, not step 1
          }], captureIndex: 2 },
        ],
        canReplayWithCookiesOnly: false,
      },
    });

    const suggestions = suggestWorkflows([skillA, skillB, skillC]);
    expect(suggestions.length).toBe(1);
    const wf = suggestions[0].workflowSpec;
    expect(wf.steps.length).toBe(3);
    // Step 2 (index=2) referencing step 0 (non-adjacent) → $steps.get_token
    expect(wf.steps[2].paramMapping!['session']).toBe('$steps.get_token.data.sessionId');
  });

  it('generates unique step names for same endpoint called twice', () => {
    const skillA = makeSkill({ id: 'a', name: 'get_data', method: 'GET', pathTemplate: '/data' });
    const skillB = makeSkill({
      id: 'b',
      name: 'get_final',
      method: 'GET',
      pathTemplate: '/final',
      chainSpec: {
        steps: [
          { skillRef: 'a', extractsFrom: [], captureIndex: 0 },
          { skillRef: 'a', extractsFrom: [{
            responsePath: 'body.id',
            injectsInto: { location: 'query', path: 'ref' },
            sourceStepIndex: 0,
          }], captureIndex: 1 },
          { skillRef: 'b', extractsFrom: [{
            responsePath: 'body.next',
            injectsInto: { location: 'query', path: 'cursor' },
            sourceStepIndex: 1,
          }], captureIndex: 2 },
        ],
        canReplayWithCookiesOnly: false,
      },
    });

    const suggestions = suggestWorkflows([skillA, skillB]);
    expect(suggestions.length).toBe(1);
    const wf = suggestions[0].workflowSpec;
    // Two steps referencing skill 'a' should have distinct names
    expect(wf.steps[0].name).toBe('get_data');
    expect(wf.steps[1].name).toBe('get_data_2');
    expect(wf.steps[2].name).toBe('get_final');
  });

  it('does not suggest for POST skills (non-GET/HEAD)', () => {
    const skillA = makeSkill({ id: 'a', name: 'create_thing', method: 'POST', pathTemplate: '/things', sideEffectClass: 'non-idempotent' });
    const skillB = makeSkill({
      id: 'b',
      name: 'get_thing',
      method: 'GET',
      pathTemplate: '/things/{id}',
      chainSpec: {
        steps: [
          { skillRef: 'a', extractsFrom: [], captureIndex: 0 },
          { skillRef: 'b', extractsFrom: [{
            responsePath: 'body.id',
            injectsInto: { location: 'query', path: 'id' },
            sourceStepIndex: 0,
          }], captureIndex: 1 },
        ],
        canReplayWithCookiesOnly: false,
      },
    });

    const suggestions = suggestWorkflows([skillA, skillB]);
    expect(suggestions.length).toBe(0);
  });

  it('does not suggest for draft skills', () => {
    const skillA = makeSkill({ id: 'a', name: 'get_token', method: 'GET', pathTemplate: '/token', status: 'draft' });
    const skillB = makeSkill({
      id: 'b',
      name: 'get_data',
      method: 'GET',
      pathTemplate: '/data',
      chainSpec: {
        steps: [
          { skillRef: 'a', extractsFrom: [], captureIndex: 0 },
          { skillRef: 'b', extractsFrom: [], captureIndex: 1 },
        ],
        canReplayWithCookiesOnly: false,
      },
    });

    const suggestions = suggestWorkflows([skillA, skillB]);
    expect(suggestions.length).toBe(0);
  });

  it('allows legacy 2-step chains without sourceStepIndex', () => {
    const skillA = makeSkill({ id: 'a', name: 'get_token', method: 'GET', pathTemplate: '/token' });
    const skillB = makeSkill({
      id: 'b',
      name: 'get_data',
      method: 'GET',
      pathTemplate: '/data',
      chainSpec: {
        steps: [
          { skillRef: 'a', extractsFrom: [] },
          {
            skillRef: 'b',
            extractsFrom: [{
              responsePath: 'body.token',
              injectsInto: { location: 'header', path: 'auth' },
              // no sourceStepIndex — legacy format
            }],
          },
        ],
        canReplayWithCookiesOnly: false,
      },
    });

    const suggestions = suggestWorkflows([skillA, skillB]);
    expect(suggestions.length).toBe(1);
    // Legacy always uses $prev
    expect(suggestions[0].workflowSpec.steps[1].paramMapping!['auth']).toBe('$prev.data.token');
  });

  it('skips legacy chains with 3+ steps (no sourceStepIndex)', () => {
    const skillA = makeSkill({ id: 'a', name: 'step1', method: 'GET', pathTemplate: '/s1' });
    const skillB = makeSkill({ id: 'b', name: 'step2', method: 'GET', pathTemplate: '/s2' });
    const skillC = makeSkill({
      id: 'c',
      name: 'step3',
      method: 'GET',
      pathTemplate: '/s3',
      chainSpec: {
        steps: [
          { skillRef: 'a', extractsFrom: [] },
          { skillRef: 'b', extractsFrom: [] },
          { skillRef: 'c', extractsFrom: [] },
        ],
        canReplayWithCookiesOnly: false,
      },
    });

    const suggestions = suggestWorkflows([skillA, skillB, skillC]);
    expect(suggestions.length).toBe(0);
  });

  it('translates body[0].id path to data[0].id', () => {
    const skillA = makeSkill({ id: 'a', name: 'list_items', method: 'GET', pathTemplate: '/items' });
    const skillB = makeSkill({
      id: 'b',
      name: 'get_item',
      method: 'GET',
      pathTemplate: '/items/{id}',
      chainSpec: {
        steps: [
          { skillRef: 'a', extractsFrom: [], captureIndex: 0 },
          {
            skillRef: 'b',
            extractsFrom: [{
              responsePath: 'body[0].id',
              injectsInto: { location: 'query', path: 'itemId' },
              sourceStepIndex: 0,
            }],
            captureIndex: 1,
          },
        ],
        canReplayWithCookiesOnly: false,
      },
    });

    const suggestions = suggestWorkflows([skillA, skillB]);
    expect(suggestions.length).toBe(1);
    expect(suggestions[0].workflowSpec.steps[1].paramMapping!['itemId']).toBe('$prev.data[0].id');
  });

  it('deduplicates suggestions with same ordered skillIds + paramMapping', () => {
    const skillA = makeSkill({ id: 'a', name: 'get_token', method: 'GET', pathTemplate: '/token' });
    // Two skills with identical chainSpecs
    const skillB1 = makeSkill({
      id: 'b1',
      name: 'get_data1',
      method: 'GET',
      pathTemplate: '/data1',
      chainSpec: {
        steps: [
          { skillRef: 'a', extractsFrom: [], captureIndex: 0 },
          { skillRef: 'a', extractsFrom: [{
            responsePath: 'body.token',
            injectsInto: { location: 'header', path: 'auth' },
            sourceStepIndex: 0,
          }], captureIndex: 1 },
        ],
        canReplayWithCookiesOnly: false,
      },
    });
    const skillB2 = makeSkill({
      id: 'b2',
      name: 'get_data2',
      method: 'GET',
      pathTemplate: '/data2',
      chainSpec: {
        steps: [
          { skillRef: 'a', extractsFrom: [], captureIndex: 0 },
          { skillRef: 'a', extractsFrom: [{
            responsePath: 'body.token',
            injectsInto: { location: 'header', path: 'auth' },
            sourceStepIndex: 0,
          }], captureIndex: 1 },
        ],
        canReplayWithCookiesOnly: false,
      },
    });

    const suggestions = suggestWorkflows([skillA, skillB1, skillB2]);
    // Both chains reference the same skills with same params — should dedup to 1
    expect(suggestions.length).toBe(1);
  });

  it('skips cookie-only chains (canReplayWithCookiesOnly)', () => {
    const skillA = makeSkill({ id: 'site.login.v1', name: 'login', pathTemplate: '/login' });
    const skillB = makeSkill({ id: 'site.api.v1', name: 'api', pathTemplate: '/api/data' });

    // Attach a cookie-only chain
    (skillA as any).chainSpec = {
      steps: [
        { skillRef: 'site.login.v1', extractsFrom: [], captureIndex: 0 },
        { skillRef: 'site.api.v1', extractsFrom: [{ responsePath: 'headers.set-cookie.sid', injectsInto: { location: 'header', path: 'cookie' }, sourceStepIndex: 0 }], captureIndex: 1 },
      ],
      canReplayWithCookiesOnly: true,
    };

    const suggestions = suggestWorkflows([skillA, skillB]);
    expect(suggestions.length).toBe(0);
  });

  it('skips chains with forward sourceStepIndex references', () => {
    const skillA = makeSkill({ id: 'a', name: 'step_a', method: 'GET', pathTemplate: '/a' });
    const skillB = makeSkill({
      id: 'b',
      name: 'step_b',
      method: 'GET',
      pathTemplate: '/b',
      chainSpec: {
        steps: [
          { skillRef: 'a', extractsFrom: [], captureIndex: 0 },
          {
            skillRef: 'b',
            extractsFrom: [{
              responsePath: 'body.token',
              injectsInto: { location: 'query', path: 'token' },
              sourceStepIndex: 1,
            }],
            captureIndex: 1,
          },
        ],
        canReplayWithCookiesOnly: false,
      },
    });

    const suggestions = suggestWorkflows([skillA, skillB]);
    expect(suggestions).toHaveLength(0);
  });
});
