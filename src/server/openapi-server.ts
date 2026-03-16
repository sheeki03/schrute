import { getLogger } from '../core/logger.js';
import { SkillRepository } from '../storage/skill-repository.js';
import { generateOpenApiFragment } from '../skill/generator.js';
import { SkillStatus } from '../skill/types.js';
import type { SkillSpec } from '../skill/types.js';

const log = getLogger();

// ─── OpenAPI 3.1 Spec Builder ────────────────────────────────────

export interface OpenApiSpec {
  openapi: string;
  info: {
    title: string;
    version: string;
    description: string;
  };
  servers: Array<{ url: string; description: string }>;
  paths: Record<string, Record<string, unknown>>;
  tags: Array<{ name: string; description: string }>;
  components: {
    securitySchemes: Record<string, unknown>;
  };
}

export function buildOpenApiSpec(
  skillRepo: SkillRepository,
  options?: {
    serverUrl?: string;
    title?: string;
    version?: string;
  },
): OpenApiSpec {
  const activeSkills = skillRepo.getByStatus(SkillStatus.ACTIVE);

  const spec: OpenApiSpec = {
    openapi: '3.1.0',
    info: {
      title: options?.title ?? 'Schrute API',
      version: options?.version ?? '0.2.0',
      description: 'Dynamically generated API specification from active Schrute skills.',
    },
    servers: [
      {
        url: options?.serverUrl ?? 'http://127.0.0.1:3000',
        description: 'Local Schrute REST server',
      },
    ],
    paths: {},
    tags: [],
    components: {
      securitySchemes: {},
    },
  };

  // Collect unique site IDs for tags
  const siteIds = new Set<string>();

  // Merge fragments from each active skill
  for (const skill of activeSkills) {
    try {
      const fragment = generateOpenApiFragment(skill);
      mergeFragment(spec, fragment, skill);
      siteIds.add(skill.siteId);
    } catch (err) {
      log.warn({ err, skillId: skill.id }, 'Failed to generate OpenAPI fragment for skill — omitting from spec');
    }
  }

  // Add meta-operation tags
  spec.tags.push({ name: 'meta', description: 'Schrute meta operations' });

  // Add site tags
  for (const siteId of siteIds) {
    spec.tags.push({ name: siteId, description: `Skills for ${siteId}` });
  }

  // Add meta-routes to spec
  addMetaRoutes(spec);

  // Add security schemes based on active skills
  addSecuritySchemes(spec, activeSkills);

  log.debug(
    { skillCount: activeSkills.length, pathCount: Object.keys(spec.paths).length },
    'OpenAPI spec built',
  );

  return spec;
}

// ─── Fragment Merger ─────────────────────────────────────────────

function mergeFragment(
  spec: OpenApiSpec,
  fragment: Record<string, unknown>,
  skill: SkillSpec,
): void {
  const paths = fragment.paths as Record<string, Record<string, unknown>> | undefined;
  if (!paths) return;

  for (const [pathKey, methods] of Object.entries(paths)) {
    // Prefix with /api/sites/:siteId/skills/:name proxy path
    const slugifiedName = slugify(skill.name);
    const proxyPath = `/api/sites/${skill.siteId}/skills/${slugifiedName}`;

    if (!spec.paths[proxyPath]) {
      spec.paths[proxyPath] = {};
    }

    for (const [method, operation] of Object.entries(methods)) {
      // Avoid overwriting if already present (first skill wins for same path+method)
      if (!spec.paths[proxyPath][method]) {
        spec.paths[proxyPath][method] = operation;
      }
    }

    // Also include the raw path for documentation purposes
    if (!spec.paths[pathKey]) {
      spec.paths[pathKey] = {};
    }
    for (const [method, operation] of Object.entries(methods)) {
      if (!spec.paths[pathKey][method]) {
        const op = operation as Record<string, unknown>;
        spec.paths[pathKey][method] = {
          ...op,
          'x-schrute-proxy': proxyPath,
          'x-schrute-skill-id': skill.id,
        };
      }
    }
  }
}

// ─── Meta Routes ─────────────────────────────────────────────────

function addMetaRoutes(spec: OpenApiSpec): void {
  spec.paths['/api/sites'] = {
    get: {
      operationId: 'listSites',
      summary: 'List all known sites',
      tags: ['meta'],
      responses: {
        '200': { description: 'List of sites' },
      },
    },
  };

  spec.paths['/api/sites/{id}'] = {
    get: {
      operationId: 'getSite',
      summary: 'Get site manifest and policy',
      tags: ['meta'],
      parameters: [
        { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
      ],
      responses: {
        '200': { description: 'Site manifest' },
        '404': { description: 'Site not found' },
      },
    },
  };

  spec.paths['/api/sites/{id}/skills'] = {
    get: {
      operationId: 'listSkills',
      summary: 'List skills for a site',
      tags: ['meta'],
      parameters: [
        { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
        { name: 'status', in: 'query', schema: { type: 'string' } },
      ],
      responses: {
        '200': { description: 'List of skills' },
      },
    },
  };

  spec.paths['/api/explore'] = {
    post: {
      operationId: 'explore',
      summary: 'Start a browser exploration session',
      tags: ['meta'],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['url'],
              properties: { url: { type: 'string' } },
            },
          },
        },
      },
      responses: {
        '200': { description: 'Exploration started' },
      },
    },
  };

  spec.paths['/api/record'] = {
    post: {
      operationId: 'record',
      summary: 'Start recording an action frame',
      tags: ['meta'],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['name'],
              properties: {
                name: { type: 'string' },
                inputs: { type: 'object', additionalProperties: { type: 'string' } },
              },
            },
          },
        },
      },
      responses: {
        '200': { description: 'Recording started' },
      },
    },
  };

  spec.paths['/api/stop'] = {
    post: {
      operationId: 'stop',
      summary: 'Stop recording and generate skills',
      tags: ['meta'],
      responses: {
        '200': { description: 'Recording stopped' },
      },
    },
  };

  spec.paths['/api/health'] = {
    get: {
      operationId: 'health',
      summary: 'Health check',
      tags: ['meta'],
      responses: {
        '200': { description: 'Server healthy' },
      },
    },
  };

  spec.paths['/api/audit'] = {
    get: {
      operationId: 'auditLog',
      summary: 'View audit log',
      tags: ['meta'],
      responses: {
        '200': { description: 'Audit log entries' },
      },
    },
  };
}

// ─── Path Helpers ────────────────────────────────────────────────

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// ─── Security Schemes ────────────────────────────────────────────

function addSecuritySchemes(spec: OpenApiSpec, skills: SkillSpec[]): void {
  const authTypes = new Set(skills.map((s) => s.authType).filter(Boolean));

  if (authTypes.has('bearer')) {
    spec.components.securitySchemes['bearerAuth'] = {
      type: 'http',
      scheme: 'bearer',
    };
  }

  if (authTypes.has('api_key')) {
    spec.components.securitySchemes['apiKeyAuth'] = {
      type: 'apiKey',
      in: 'header',
      name: 'X-API-Key',
    };
  }

  if (authTypes.has('cookie')) {
    spec.components.securitySchemes['cookieAuth'] = {
      type: 'apiKey',
      in: 'cookie',
      name: 'session',
    };
  }

  if (authTypes.has('oauth2')) {
    spec.components.securitySchemes['oauth2Auth'] = {
      type: 'oauth2',
      flows: {
        authorizationCode: {
          authorizationUrl: '/auth/authorize',
          tokenUrl: '/auth/token',
          scopes: {},
        },
      },
    };
  }
}
