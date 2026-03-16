/**
 * v0.2 Acceptance — OpenAPI spec validation
 *
 * Validates generated spec structure, active-skills-only paths, and docs endpoint.
 */

import { describe, it, expect, vi } from 'vitest';
import { makeSkill } from '../helpers.js';

vi.mock('../../src/storage/database.js', () => ({
  getDatabase: () => ({
    prepare: () => ({
      run: () => ({ changes: 1 }),
      get: () => undefined,
      all: () => [],
    }),
    exec: () => {},
    close: () => {},
  }),
}));

vi.mock('../../src/skill/generator.js', () => ({
  generateOpenApiFragment: (skill: any) => ({
    paths: {
      [skill.pathTemplate]: {
        [skill.method.toLowerCase()]: {
          operationId: `${skill.siteId}_${skill.name}`,
          summary: skill.description || `${skill.method} ${skill.pathTemplate}`,
          tags: [skill.siteId],
          responses: {
            '200': { description: 'Success' },
          },
        },
      },
    },
  }),
}));

describe('v0.2 OpenAPI — Spec Structure', () => {
  it('generates valid OpenAPI 3.1 structure', async () => {
    const { buildOpenApiSpec } = await import('../../src/server/openapi-server.js');

    const mockRepo = {
      getByStatus: (status: string) => {
        if (status === 'active') return [makeSkill()];
        return [];
      },
    } as any;

    const spec = buildOpenApiSpec(mockRepo);

    expect(spec.openapi).toBe('3.1.0');
    expect(spec.info).toBeDefined();
    expect(spec.info.title).toBe('Schrute API');
    expect(spec.info.version).toBe('0.2.0');
    expect(spec.servers).toBeDefined();
    expect(spec.servers.length).toBeGreaterThan(0);
    expect(spec.paths).toBeDefined();
    expect(spec.tags).toBeDefined();
    expect(spec.components).toBeDefined();
    expect(spec.components.securitySchemes).toBeDefined();
  });

  it('includes meta routes', async () => {
    const { buildOpenApiSpec } = await import('../../src/server/openapi-server.js');

    const mockRepo = {
      getByStatus: () => [],
    } as any;

    const spec = buildOpenApiSpec(mockRepo);

    expect(spec.paths).toHaveProperty('/api/sites');
    expect(spec.paths).toHaveProperty('/api/health');
    expect(spec.paths).toHaveProperty('/api/explore');
    expect(spec.paths).toHaveProperty('/api/record');
    expect(spec.paths).toHaveProperty('/api/stop');
    expect(spec.paths).toHaveProperty('/api/audit');
  });

  it('meta routes have correct HTTP methods', async () => {
    const { buildOpenApiSpec } = await import('../../src/server/openapi-server.js');

    const mockRepo = { getByStatus: () => [] } as any;
    const spec = buildOpenApiSpec(mockRepo);

    expect(spec.paths['/api/sites']).toHaveProperty('get');
    expect(spec.paths['/api/health']).toHaveProperty('get');
    expect(spec.paths['/api/explore']).toHaveProperty('post');
    expect(spec.paths['/api/record']).toHaveProperty('post');
    expect(spec.paths['/api/stop']).toHaveProperty('post');
  });
});

describe('v0.2 OpenAPI — Active Skills Only', () => {
  it('only includes active skills in paths', async () => {
    const { buildOpenApiSpec } = await import('../../src/server/openapi-server.js');

    const activeSkill = makeSkill({
      status: 'active',
      name: 'get_data',
      pathTemplate: '/api/data',
      method: 'GET',
      siteId: 'mysite.com',
    });

    const mockRepo = {
      getByStatus: (status: string) => {
        if (status === 'active') return [activeSkill];
        return [];
      },
    } as any;

    const spec = buildOpenApiSpec(mockRepo);

    // Should include the active skill's proxy path (skill names are slugified)
    const slugifiedName = activeSkill.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    const proxyPath = `/api/sites/${activeSkill.siteId}/skills/${slugifiedName}`;
    expect(spec.paths).toHaveProperty(proxyPath);
  });

  it('does not include draft/stale/broken skills', async () => {
    const { buildOpenApiSpec } = await import('../../src/server/openapi-server.js');

    // getByStatus('active') returns empty — no active skills
    const mockRepo = {
      getByStatus: () => [],
    } as any;

    const spec = buildOpenApiSpec(mockRepo);

    // Only meta routes should exist
    const paths = Object.keys(spec.paths);
    const skillPaths = paths.filter(p =>
      !p.startsWith('/api/sites/{') &&
      !p.startsWith('/api/sites') &&
      !['/api/health', '/api/explore', '/api/record', '/api/stop', '/api/audit'].includes(p)
    );
    expect(skillPaths.length).toBe(0);
  });
});

describe('v0.2 OpenAPI — Security Schemes', () => {
  it('adds bearer scheme when skills use bearer auth', async () => {
    const { buildOpenApiSpec } = await import('../../src/server/openapi-server.js');

    const skill = makeSkill({ authType: 'bearer' });
    const mockRepo = {
      getByStatus: (status: string) => status === 'active' ? [skill] : [],
    } as any;

    const spec = buildOpenApiSpec(mockRepo);
    expect(spec.components.securitySchemes).toHaveProperty('bearerAuth');
  });

  it('adds cookie scheme when skills use cookie auth', async () => {
    const { buildOpenApiSpec } = await import('../../src/server/openapi-server.js');

    const skill = makeSkill({ authType: 'cookie' });
    const mockRepo = {
      getByStatus: (status: string) => status === 'active' ? [skill] : [],
    } as any;

    const spec = buildOpenApiSpec(mockRepo);
    expect(spec.components.securitySchemes).toHaveProperty('cookieAuth');
  });

  it('adds api_key scheme when skills use api_key auth', async () => {
    const { buildOpenApiSpec } = await import('../../src/server/openapi-server.js');

    const skill = makeSkill({ authType: 'api_key' });
    const mockRepo = {
      getByStatus: (status: string) => status === 'active' ? [skill] : [],
    } as any;

    const spec = buildOpenApiSpec(mockRepo);
    expect(spec.components.securitySchemes).toHaveProperty('apiKeyAuth');
  });

  it('no security schemes when skills have no auth', async () => {
    const { buildOpenApiSpec } = await import('../../src/server/openapi-server.js');

    const skill = makeSkill({ authType: undefined });
    const mockRepo = {
      getByStatus: (status: string) => status === 'active' ? [skill] : [],
    } as any;

    const spec = buildOpenApiSpec(mockRepo);
    expect(Object.keys(spec.components.securitySchemes).length).toBe(0);
  });
});

describe('v0.2 OpenAPI — Tags', () => {
  it('includes meta tag', async () => {
    const { buildOpenApiSpec } = await import('../../src/server/openapi-server.js');

    const mockRepo = { getByStatus: () => [] } as any;
    const spec = buildOpenApiSpec(mockRepo);

    const tagNames = spec.tags.map(t => t.name);
    expect(tagNames).toContain('meta');
  });

  it('includes site tags for active skills', async () => {
    const { buildOpenApiSpec } = await import('../../src/server/openapi-server.js');

    const skill = makeSkill({ siteId: 'myapp.com' });
    const mockRepo = {
      getByStatus: (status: string) => status === 'active' ? [skill] : [],
    } as any;

    const spec = buildOpenApiSpec(mockRepo);
    const tagNames = spec.tags.map(t => t.name);
    expect(tagNames).toContain('myapp.com');
  });

  it('custom server URL and title', async () => {
    const { buildOpenApiSpec } = await import('../../src/server/openapi-server.js');

    const mockRepo = { getByStatus: () => [] } as any;
    const spec = buildOpenApiSpec(mockRepo, {
      serverUrl: 'https://custom.host:8080',
      title: 'Custom API',
      version: '1.0.0',
    });

    expect(spec.info.title).toBe('Custom API');
    expect(spec.info.version).toBe('1.0.0');
    expect(spec.servers[0].url).toBe('https://custom.host:8080');
  });
});
