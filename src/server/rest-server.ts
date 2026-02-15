import Fastify, { type FastifyInstance } from 'fastify';
import { getLogger } from '../core/logger.js';
import { getConfig } from '../core/config.js';
import { Engine } from '../core/engine.js';
import { getDatabase } from '../storage/database.js';
import { SkillRepository } from '../storage/skill-repository.js';
import { SiteRepository } from '../storage/site-repository.js';
import { createRouter, type RouterResult } from './router.js';
import { buildOpenApiSpec } from './openapi-server.js';

const log = getLogger();

// ─── JSON Schema for request validation ─────────────────────────

const executeSkillBody = {
  type: 'object',
  properties: {
    params: { type: 'object', additionalProperties: true },
    confirmationToken: { type: 'string' },
    approve: { type: 'boolean' },
  },
} as const;

const exploreBody = {
  type: 'object',
  required: ['url'],
  properties: {
    url: { type: 'string' },
  },
} as const;

const recordBody = {
  type: 'object',
  required: ['name'],
  properties: {
    name: { type: 'string' },
    inputs: { type: 'object', additionalProperties: { type: 'string' } },
  },
} as const;

const siteIdParam = {
  type: 'object',
  required: ['id'],
  properties: {
    id: { type: 'string' },
  },
} as const;

const siteSkillParams = {
  type: 'object',
  required: ['id', 'name'],
  properties: {
    id: { type: 'string' },
    name: { type: 'string' },
  },
} as const;

const skillsQuerystring = {
  type: 'object',
  properties: {
    status: { type: 'string' },
  },
} as const;

// ─── Helpers ────────────────────────────────────────────────────

function routerResultToReply(
  result: RouterResult,
  reply: { code: (c: number) => { send: (body: unknown) => void } },
): void {
  const statusCode = result.statusCode ?? (result.success ? 200 : 500);
  if (result.success || result.data) {
    reply.code(statusCode).send(result.data);
  } else {
    reply.code(statusCode).send({ error: result.error });
  }
}

// ─── REST Server ────────────────────────────────────────────────

export async function createRestServer(options?: {
  host?: string;
  port?: number;
}): Promise<FastifyInstance> {
  const config = getConfig();
  const engine = new Engine(config);
  const db = getDatabase(config);
  const skillRepo = new SkillRepository(db);
  const siteRepo = new SiteRepository(db);

  const router = createRouter({ engine, skillRepo, siteRepo, config });

  const host = options?.host ?? '127.0.0.1';
  const port = options?.port ?? 3000;

  const app = Fastify({
    logger: false,
  });

  // ─── Health ──────────────────────────────────────────────
  app.get('/api/health', async (_request, reply) => {
    const result = router.health();
    routerResultToReply(result, reply);
  });

  // ─── Sites ───────────────────────────────────────────────
  app.get('/api/sites', async (_request, reply) => {
    const result = router.listSites();
    routerResultToReply(result, reply);
  });

  app.get<{ Params: { id: string } }>(
    '/api/sites/:id',
    { schema: { params: siteIdParam } },
    async (request, reply) => {
      const result = router.getSite(request.params.id);
      routerResultToReply(result, reply);
    },
  );

  // ─── Skills ──────────────────────────────────────────────
  app.get<{ Params: { id: string }; Querystring: { status?: string } }>(
    '/api/sites/:id/skills',
    { schema: { params: siteIdParam, querystring: skillsQuerystring } },
    async (request, reply) => {
      const result = router.listSkills(request.params.id, request.query.status);
      routerResultToReply(result, reply);
    },
  );

  // ─── Execute Skill ───────────────────────────────────────
  app.post<{
    Params: { id: string; name: string };
    Body: { params?: Record<string, unknown>; confirmationToken?: string; approve?: boolean };
  }>(
    '/api/sites/:id/skills/:name',
    { schema: { params: siteSkillParams, body: executeSkillBody } },
    async (request, reply) => {
      const { id: siteId, name: skillName } = request.params;
      const { params, confirmationToken, approve } = request.body ?? {};

      // Handle confirmation flow
      if (confirmationToken != null && approve != null) {
        const result = router.confirm(confirmationToken, approve);
        routerResultToReply(result, reply);
        return;
      }

      const result = await router.executeSkill(siteId, skillName, params ?? {});
      routerResultToReply(result, reply);
    },
  );

  // ─── Dry Run ─────────────────────────────────────────────
  app.post<{
    Params: { id: string; name: string };
    Body: { params?: Record<string, unknown>; mode?: 'agent-safe' | 'developer-debug' };
  }>(
    '/api/sites/:id/skills/:name/dry-run',
    { schema: { params: siteSkillParams } },
    async (request, reply) => {
      const { id: siteId, name: skillName } = request.params;
      const { params, mode } = request.body ?? {};

      const result = router.dryRunSkill(siteId, skillName, params ?? {}, mode);
      routerResultToReply(result, reply);
    },
  );

  // ─── Validate ────────────────────────────────────────────
  app.post<{
    Params: { id: string; name: string };
    Body: { params?: Record<string, unknown> };
  }>(
    '/api/sites/:id/skills/:name/validate',
    { schema: { params: siteSkillParams } },
    async (request, reply) => {
      const { id: siteId, name: skillName } = request.params;
      const { params } = request.body ?? {};

      const result = await router.validateSkillRoute(siteId, skillName, params ?? {});
      routerResultToReply(result, reply);
    },
  );

  // ─── Explore / Record / Stop ─────────────────────────────
  app.post<{ Body: { url: string } }>(
    '/api/explore',
    { schema: { body: exploreBody } },
    async (request, reply) => {
      const result = await router.explore(request.body.url);
      routerResultToReply(result, reply);
    },
  );

  app.post<{ Body: { name: string; inputs?: Record<string, string> } }>(
    '/api/record',
    { schema: { body: recordBody } },
    async (request, reply) => {
      const result = await router.startRecording(request.body.name, request.body.inputs);
      routerResultToReply(result, reply);
    },
  );

  app.post('/api/stop', async (_request, reply) => {
    const result = await router.stopRecording();
    routerResultToReply(result, reply);
  });

  // ─── OpenAPI Spec ────────────────────────────────────────
  app.get('/api/openapi.json', async (_request, reply) => {
    const spec = buildOpenApiSpec(skillRepo);
    reply.code(200).send(spec);
  });

  // ─── Swagger UI (redirect) ──────────────────────────────
  app.get('/api/docs', async (_request, reply) => {
    // Serve a minimal HTML page that loads Swagger UI from CDN
    const html = `<!DOCTYPE html>
<html>
<head>
  <title>OneAgent API Docs</title>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5/swagger-ui.css" />
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
  <script>
    SwaggerUIBundle({ url: '/api/openapi.json', dom_id: '#swagger-ui' });
  </script>
</body>
</html>`;
    reply.code(200).type('text/html').send(html);
  });

  // ─── Audit ───────────────────────────────────────────────
  app.get('/api/audit', async (_request, reply) => {
    const result = router.getAuditLog();
    routerResultToReply(result, reply);
  });

  // ─── Status ──────────────────────────────────────────────
  app.get('/api/status', async (_request, reply) => {
    const result = router.getStatus();
    routerResultToReply(result, reply);
  });

  // ─── Shutdown Hook ───────────────────────────────────────
  app.addHook('onClose', async () => {
    await engine.close();
    log.info('REST server closed, engine shut down');
  });

  log.info({ host, port }, 'REST server created');

  return app;
}

// ─── Standalone Entry Point ──────────────────────────────────────

export async function startRestServer(options?: {
  host?: string;
  port?: number;
}): Promise<FastifyInstance> {
  const host = options?.host ?? '127.0.0.1';
  const port = options?.port ?? 3000;

  const app = await createRestServer(options);

  await app.listen({ host, port });
  log.info({ host, port }, 'REST server listening');

  return app;
}
