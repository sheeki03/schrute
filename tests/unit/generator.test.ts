import { describe, it, expect } from 'vitest';
import {
  generateSkill,
  generateSkillMd,
  generateOpenApiFragment,
  type ClusterInfo,
} from '../../src/skill/generator.js';
import type { AuthRecipe, ParameterEvidence, RequestChain } from '../../src/skill/types.js';

// ─── Helpers ──────────────────────────────────────────────────────

function makeCluster(overrides: Partial<ClusterInfo> = {}): ClusterInfo {
  return {
    method: 'GET',
    pathTemplate: '/api/users/{id}',
    actionName: 'getUser',
    description: 'Fetch a user by ID',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    },
    sampleCount: 5,
    ...overrides,
  };
}

const bearerAuth: AuthRecipe = {
  type: 'bearer',
  injection: { location: 'header', key: 'Authorization', prefix: 'Bearer ' },
  refreshTriggers: ['401'],
  refreshMethod: 'browser_relogin',
};

// ─── Tests ────────────────────────────────────────────────────────

describe('generator', () => {
  describe('generateSkill', () => {
    it('creates a SkillSpec with correct id format', () => {
      const spec = generateSkill('example.com', makeCluster());
      expect(spec.id).toBe('example_com.getuser.v1');
    });

    it('uses GraphQL id format when isGraphQL is true', () => {
      const spec = generateSkill('example.com', makeCluster({
        isGraphQL: true,
        graphqlOperationName: 'GetUser',
      }));
      expect(spec.id).toBe('example_com.gql.GetUser.v1');
    });

    it('sets default tier to tier_3', () => {
      const spec = generateSkill('example.com', makeCluster());
      expect(spec.currentTier).toBe('tier_3');
    });

    it('sets status to draft', () => {
      const spec = generateSkill('example.com', makeCluster());
      expect(spec.status).toBe('draft');
    });

    it('includes secrets.use capability when auth is provided', () => {
      const spec = generateSkill('example.com', makeCluster(), bearerAuth);
      expect(spec.requiredCapabilities).toContain('secrets.use');
    });

    it('does not include secrets.use capability when no auth', () => {
      const spec = generateSkill('example.com', makeCluster());
      expect(spec.requiredCapabilities).not.toContain('secrets.use');
    });

    it('builds parameters from paramEvidence with parameter classification', () => {
      const evidence: ParameterEvidence[] = [
        { fieldPath: 'query.q', classification: 'parameter', observedValues: ['a', 'b'], correlatesWithInput: true, volatility: 0.5 },
        { fieldPath: 'header.x-version', classification: 'constant', observedValues: ['2.0'], correlatesWithInput: false, volatility: 0 },
        { fieldPath: 'body.nonce', classification: 'ephemeral', observedValues: ['x', 'y'], correlatesWithInput: false, volatility: 1.0 },
      ];

      const spec = generateSkill('example.com', makeCluster(), undefined, evidence);
      // Only 'parameter' classification should become SkillParameters
      expect(spec.parameters).toHaveLength(1);
      expect(spec.parameters[0].name).toBe('query.q');
      expect(spec.parameters[0].source).toBe('user_input');
    });

    it('marks composite when chain has multiple steps', () => {
      const chain: RequestChain = {
        steps: [
          { skillRef: 'GET /auth', extractsFrom: [] },
          { skillRef: 'GET /data', extractsFrom: [{ responsePath: 'body.token', injectsInto: { location: 'header', path: 'Authorization' } }] },
        ],
        canReplayWithCookiesOnly: false,
      };

      const spec = generateSkill('example.com', makeCluster(), undefined, undefined, chain);
      expect(spec.isComposite).toBe(true);
      expect(spec.chainSpec).toBe(chain);
    });

    it('preserves html response content type and keeps html skills read-only', () => {
      const spec = generateSkill('example.com', makeCluster({
        responseContentType: 'text/html; charset=utf-8',
      }));

      expect(spec.responseContentType).toBe('text/html; charset=utf-8');
      expect(spec.sideEffectClass).toBe('read-only');
    });
  });

  describe('generateSkillMd', () => {
    it('produces YAML frontmatter between --- delimiters', () => {
      const spec = generateSkill('example.com', makeCluster());
      const md = generateSkillMd(spec);
      expect(md.startsWith('---\n')).toBe(true);
      expect(md).toContain('\n---\n');
    });

    it('contains the skill id in frontmatter', () => {
      const spec = generateSkill('example.com', makeCluster());
      const md = generateSkillMd(spec);
      expect(md).toContain('id: example_com.getuser.v1');
    });

    it('contains endpoint section with method and path', () => {
      const spec = generateSkill('example.com', makeCluster());
      const md = generateSkillMd(spec);
      expect(md).toContain('**Method**: `GET`');
      expect(md).toContain('**Path**: `/api/users/{id}`');
    });

    it('includes auth type when present', () => {
      const spec = generateSkill('example.com', makeCluster(), bearerAuth);
      const md = generateSkillMd(spec);
      expect(md).toContain('**Auth**: `bearer`');
    });

    it('includes parameters table when parameters exist', () => {
      const evidence: ParameterEvidence[] = [
        { fieldPath: 'query.q', classification: 'parameter', observedValues: ['test'], correlatesWithInput: true, volatility: 0.5 },
      ];
      const spec = generateSkill('example.com', makeCluster(), undefined, evidence);
      const md = generateSkillMd(spec);
      expect(md).toContain('## Parameters');
      expect(md).toContain('| query.q |');
    });

    it('includes input schema as JSON code block', () => {
      const spec = generateSkill('example.com', makeCluster());
      const md = generateSkillMd(spec);
      expect(md).toContain('## Input Schema');
      expect(md).toContain('```json');
    });
  });

  describe('generateOpenApiFragment', () => {
    it('produces valid OpenAPI 3.1.0 structure', () => {
      const spec = generateSkill('example.com', makeCluster());
      const fragment = generateOpenApiFragment(spec);
      expect(fragment.openapi).toBe('3.1.0');
      expect(fragment.info).toBeDefined();
      expect(fragment.paths).toBeDefined();
    });

    it('uses correct path and method keys', () => {
      const spec = generateSkill('example.com', makeCluster());
      const fragment = generateOpenApiFragment(spec);
      const paths = fragment.paths as Record<string, Record<string, unknown>>;
      expect(paths['/api/users/{id}']).toBeDefined();
      expect(paths['/api/users/{id}']['get']).toBeDefined();
    });

    it('includes path parameters for parameterized paths', () => {
      const spec = generateSkill('example.com', makeCluster());
      const fragment = generateOpenApiFragment(spec);
      const paths = fragment.paths as Record<string, Record<string, unknown>>;
      const operation = paths['/api/users/{id}']['get'] as Record<string, unknown>;
      const params = operation.parameters as Array<{ name: string; in: string }>;
      expect(params.some(p => p.name === 'id' && p.in === 'path')).toBe(true);
    });

    it('includes requestBody for POST endpoints', () => {
      const spec = generateSkill('example.com', makeCluster({ method: 'POST' }));
      const fragment = generateOpenApiFragment(spec);
      const paths = fragment.paths as Record<string, Record<string, unknown>>;
      const operation = paths['/api/users/{id}']['post'] as Record<string, unknown>;
      expect(operation.requestBody).toBeDefined();
    });

    it('includes security when auth type is present', () => {
      const spec = generateSkill('example.com', makeCluster(), bearerAuth);
      const fragment = generateOpenApiFragment(spec);
      const paths = fragment.paths as Record<string, Record<string, unknown>>;
      const operation = paths['/api/users/{id}']['get'] as Record<string, unknown>;
      expect(operation.security).toBeDefined();
    });

    it('sets operationId to the skill id', () => {
      const spec = generateSkill('example.com', makeCluster());
      const fragment = generateOpenApiFragment(spec);
      const paths = fragment.paths as Record<string, Record<string, unknown>>;
      const operation = paths['/api/users/{id}']['get'] as Record<string, unknown>;
      expect(operation.operationId).toBe(spec.id);
    });
  });
});
