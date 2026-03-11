import Fastify, { type FastifyInstance } from 'fastify';
import { getLogger } from '../core/logger.js';
import { verifyBearerToken } from '../shared/auth-utils.js';
import { getConfig } from '../core/config.js';
import { Engine } from '../core/engine.js';
import { getDatabase } from '../storage/database.js';
import { SkillRepository } from '../storage/skill-repository.js';
import { SiteRepository } from '../storage/site-repository.js';
import { ConfirmationManager } from './confirmation.js';
import { DEFAULT_SESSION_NAME } from '../browser/multi-session.js';
import { createRouter, type RouterDeps, type RouterResult } from './router.js';
import { buildOpenApiSpec } from './openapi-server.js';
import { sanitizeSiteId } from '../core/utils.js';
import { setupCdpSitePolicy, validateProxyConfig, validateGeoConfig } from './shared-validation.js';

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
    proxy: { type: 'object' },
    geo: { type: 'object' },
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
  if (result.success) {
    reply.code(200).send(result.data);
  } else {
    const statusCode = result.statusCode ?? 500;
    if (result.data) {
      reply.code(statusCode).send(result.data);
    } else {
      reply.code(statusCode).send({ error: result.error });
    }
  }
}

// ─── REST Server ────────────────────────────────────────────────

export async function createRestServer(options?: {
  host?: string;
  port?: number;
  deps?: RouterDeps;
}): Promise<FastifyInstance> {
  // Use injected deps if provided, otherwise create standalone deps (for backward compat / tests)
  let engine: Engine;
  let skillRepo: SkillRepository;
  let siteRepo: SiteRepository;
  let config;
  let ownEngine = false;

  if (options?.deps) {
    ({ engine, skillRepo, siteRepo, config } = options.deps);
  } else {
    config = getConfig();
    engine = new Engine(config);
    const db = getDatabase(config);
    skillRepo = new SkillRepository(db);
    siteRepo = new SiteRepository(db);
    ownEngine = true;
  }

  const confirmation = options?.deps?.confirmation ?? new ConfirmationManager(getDatabase(config), config);
  const router = createRouter({ engine, skillRepo, siteRepo, config, confirmation });

  // Security invariant: network mode requires auth token — fail-closed.
  // This prevents alternate entry paths (e.g., direct createRestServer() calls)
  // from starting unauthenticated. Both mcp-http.ts and rest-server.ts enforce this independently.
  if (config.server.network && !config.server.authToken) {
    throw new Error(
      'REST server requires config.server.authToken when network mode is enabled. ' +
      'Set it with: oneagent config set server.authToken <your-secret>',
    );
  }

  const host = options?.host ?? '127.0.0.1';
  const port = options?.port ?? 3000;

  const app = Fastify({
    logger: false,
  });

  // ─── Bearer Token Auth ────────────────────────────────────
  if (config.server.network && config.server.authToken) {
    app.addHook('onRequest', async (request, reply) => {
      // Health endpoint is public (used for probes)
      if (request.url === '/api/health') return;

      if (!verifyBearerToken(request.raw, config.server.authToken!)) {
        reply.code(401).send({ error: 'Unauthorized. Provide Authorization: Bearer <token>' });
        return;
      }
    });
  }

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

      const result = await router.dryRunSkill(siteId, skillName, params ?? {}, mode);
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
  app.post<{ Body: { url: string; proxy?: Record<string, unknown>; geo?: Record<string, unknown> } }>(
    '/api/explore',
    { schema: { body: exploreBody } },
    async (request, reply) => {
      try {
        let proxy;
        if (request.body.proxy) {
          proxy = validateProxyConfig(request.body.proxy);
        }
        let geo;
        if (request.body.geo) {
          geo = validateGeoConfig(request.body.geo);
        }
        const overrides = proxy || geo ? { proxy, geo } : undefined;
        const result = await router.explore(request.body.url, overrides);
        routerResultToReply(result, reply);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        reply.code(400).send({ error: message });
      }
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

  // ─── Sessions ──────────────────────────────────────────
  app.get('/api/sessions', async (_request, reply) => {
    const multiSession = engine.getMultiSessionManager();
    const sessions = multiSession.list().map(s => ({
      name: s.name,
      siteId: s.siteId,
      isCdp: s.isCdp,
      active: s.name === multiSession.getActive(),
    }));
    reply.code(200).send(sessions);
  });

  app.delete<{ Params: { name: string } }>(
    '/api/sessions/:name',
    async (request, reply) => {
      const { name } = request.params;
      const force = (request.query as Record<string, string>)?.force === 'true';
      const multiSession = engine.getMultiSessionManager();
      try {
        const expectedId = name === DEFAULT_SESSION_NAME && force
          ? engine.getActiveSessionId()
          : null;
        await multiSession.close(name, { engineMode: engine.getStatus().mode, force });
        if (name === DEFAULT_SESSION_NAME && force) {
          engine.resetExploreState(expectedId);
        }
        reply.code(200).send({ closed: name });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        reply.code(400).send({ error: message });
      }
    },
  );

  app.post<{ Params: { name: string } }>(
    '/api/sessions/:name/switch',
    async (request, reply) => {
      const { name } = request.params;
      const multiSession = engine.getMultiSessionManager();
      try {
        multiSession.setActive(name);
        reply.code(200).send({ active: name });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        reply.code(400).send({ error: message });
      }
    },
  );

  // ─── CDP Connect ──────────────────────────────────────
  app.post<{ Body: { name: string; port?: number; wsEndpoint?: string; host?: string; siteId?: string; domains?: string[]; autoDiscover?: boolean } }>(
    '/api/cdp/connect',
    async (request, reply) => {
      const { name, port, wsEndpoint, host, siteId: userSiteId, domains: userDomains, autoDiscover } = request.body ?? {};
      if (!name) {
        reply.code(400).send({ error: 'name is required' });
        return;
      }
      if (name === DEFAULT_SESSION_NAME) {
        reply.code(400).send({ error: 'Cannot use "default" for CDP sessions. The default session is reserved for launch-based browser automation.' });
        return;
      }
      // Validate domains before policy setup
      if (userDomains !== undefined) {
        if (!Array.isArray(userDomains)) {
          reply.code(400).send({ error: 'domains must be an array' });
          return;
        }
        if (!userDomains.every((d: unknown) => typeof d === 'string')) {
          reply.code(400).send({ error: 'domains must be an array of strings' });
          return;
        }
      }
      try {
        const siteId = sanitizeSiteId(userSiteId ?? `cdp-${name}`);
        setupCdpSitePolicy(siteId, userDomains, config);

        const multiSession = engine.getMultiSessionManager();
        const session = await multiSession.connectCDP(
          name, { port, wsEndpoint, host, autoDiscover: autoDiscover === true }, siteId,
        );

        const { getSitePolicy } = await import('../core/policy.js');
        const policy = getSitePolicy(siteId, config);

        reply.code(200).send({
          session: name,
          siteId: session.siteId,
          status: 'connected',
          domains: policy.domainAllowlist,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        reply.code(400).send({ error: message });
      }
    },
  );

  // ─── Confirm ──────────────────────────────────────────
  app.post<{ Body: { confirmationToken: string; approve: boolean } }>(
    '/api/confirm',
    async (request, reply) => {
      const { confirmationToken, approve } = request.body ?? {};
      if (!confirmationToken || typeof approve !== 'boolean') {
        reply.code(400).send({ error: 'confirmationToken and approve (boolean) are required' });
        return;
      }
      const result = router.confirm(confirmationToken, approve);
      routerResultToReply(result, reply);
    },
  );

  // ─── Import Cookies ───────────────────────────────────
  app.post<{ Body: { siteId: string; cookieFile: string } }>(
    '/api/import-cookies',
    async (request, reply) => {
      const { siteId, cookieFile } = request.body ?? {};
      if (!siteId || !cookieFile) {
        reply.code(400).send({ error: 'siteId and cookieFile are required' });
        return;
      }
      try {
        const safeSiteId = sanitizeSiteId(siteId);
        const browserManager = engine.getSessionManager().getBrowserManager();
        const count = await browserManager.importCookies(safeSiteId, cookieFile);
        reply.code(200).send({ imported: count, siteId: safeSiteId });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        reply.code(400).send({ error: message });
      }
    },
  );

  // ─── Skills (all) ─────────────────────────────────────
  app.get<{ Querystring: { status?: string } }>(
    '/api/skills',
    async (request, reply) => {
      const status = request.query.status;
      let skills;
      if (status) {
        skills = skillRepo.getByStatus(status as import('../skill/types.js').SkillStatusName);
      } else {
        skills = skillRepo.getAll();
      }
      const summary = skills.map(s => ({
        id: s.id,
        name: s.name,
        status: s.status,
        siteId: s.siteId,
        method: s.method,
        pathTemplate: s.pathTemplate,
        successRate: s.successRate,
        currentTier: s.currentTier,
      }));
      reply.code(200).send(summary);
    },
  );

  // ─── Execute by ID ────────────────────────────────────
  app.post<{ Body: { skillId: string; params?: Record<string, unknown> } }>(
    '/api/execute',
    async (request, reply) => {
      const { skillId, params } = request.body ?? {};
      if (!skillId) {
        reply.code(400).send({ error: 'skillId is required' });
        return;
      }
      try {
        const result = await engine.executeSkill(skillId, params ?? {});
        if (result.success) {
          reply.code(200).send(result);
        } else {
          reply.code(422).send(result);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        reply.code(500).send({ error: message });
      }
    },
  );

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
    // Only close engine if we created it (standalone mode)
    if (ownEngine) {
      await engine.close();
    }
    log.info('REST server closed');
  });

  log.info({ host, port }, 'REST server created');

  return app;
}

// ─── Standalone Entry Point ──────────────────────────────────────

export async function startRestServer(options?: {
  host?: string;
  port?: number;
  deps?: RouterDeps;
}): Promise<FastifyInstance> {
  const host = options?.host ?? '127.0.0.1';
  const port = options?.port ?? 3000;

  const app = await createRestServer(options);

  await app.listen({ host, port });
  log.info({ host, port }, 'REST server listening');

  return app;
}
