import { randomUUID } from 'node:crypto';
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
import { SchruteService } from '../app/service.js';
import type { SkillStatusName } from '../skill/types.js';
import { getSkillExecutability, searchAndProjectSkills } from './skill-helpers.js';
import { getShapedStatus } from './status-response.js';
import { withTimeout } from '../core/utils.js';

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

const recoverExploreBody = {
  type: 'object',
  required: ['resumeToken'],
  properties: {
    resumeToken: { type: 'string' },
    waitMs: { type: 'number' },
  },
} as const;

const siteIdParam = {
  type: 'object',
  required: ['id'],
  properties: {
    id: { type: 'string' },
  },
} as const;

const pipelineJobParam = {
  type: 'object',
  required: ['jobId'],
  properties: {
    jobId: { type: 'string' },
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

// ─── Caller Identity ────────────────────────────────────────────

function getCallerId(request: { headers: Record<string, unknown> }): string {
  const header = request.headers['x-caller-id'];
  if (typeof header === 'string' && header.length > 0 && header.length <= 128) {
    return `rest:${header}`;
  }
  return 'rest-unknown';
}

function requireAdmin(config: { server: { network: boolean } }, reply: { code: (c: number) => { send: (body: unknown) => void } }): boolean {
  if (config.server.network) {
    reply.code(403).send({ error: 'Admin operation not available over network. Use CLI or daemon socket.' });
    return false;
  }
  return true;
}

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
  const appService = new SchruteService({ engine, skillRepo, siteRepo, config, confirmation });

  // Security invariant: network mode requires auth token — fail-closed.
  // This prevents alternate entry paths (e.g., direct createRestServer() calls)
  // from starting unauthenticated. Both mcp-http.ts and rest-server.ts enforce this independently.
  if (config.server.network && !config.server.authToken) {
    throw new Error(
      'REST server requires config.server.authToken when network mode is enabled. ' +
      'Set it with: schrute config set server.authToken <your-secret>',
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

      const result = await router.executeSkill(siteId, skillName, params ?? {}, getCallerId(request));
      routerResultToReply(result, reply);
    },
  );

  // WS-12: GET skill proxy with method guard
  app.get<{ Params: { id: string; name: string }; Querystring: Record<string, string> }>(
    '/api/sites/:id/skills/:name',
    { schema: { params: siteSkillParams } },
    async (request, reply) => {
      const { id: siteId, name: skillName } = request.params;
      // Method guard: GET proxy only executes GET skills (slug-tolerant to match router)
      const slugify = (n: string) => n.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
      const skills = skillRepo.getBySiteId(siteId);
      const skill = skills.find(s =>
        (s.name === skillName || slugify(s.name) === slugify(skillName)) && s.status === 'active',
      );
      if (skill && skill.method !== 'GET') {
        return reply.code(405).send({ error: `Skill '${skill.name}' is ${skill.method}, not GET. Use POST.` });
      }
      if (!skill) {
        return reply.code(404).send({ error: `Active skill '${skillName}' not found for site '${siteId}'` });
      }
      const result = await router.executeSkill(siteId, skillName, request.query ?? {}, getCallerId(request));
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
      if (!requireAdmin(config, reply)) return;
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
      if (!requireAdmin(config, reply)) return;
      const result = await router.startRecording(request.body.name, request.body.inputs);
      routerResultToReply(result, reply);
    },
  );

  app.post('/api/stop', async (_request, reply) => {
    if (!requireAdmin(config, reply)) return;
    const result = await withTimeout(router.stopRecording(), 30_000, 'stopRecording');
    routerResultToReply(result, reply);
  });

  app.get<{ Params: { jobId: string } }>(
    '/api/pipeline/:jobId',
    { schema: { params: pipelineJobParam } },
    async (request, reply) => {
      if (!requireAdmin(config, reply)) return;
      const result = router.getPipelineStatus(request.params.jobId);
      routerResultToReply(result, reply);
    },
  );

  app.post<{ Body: { resumeToken: string; waitMs?: number } }>(
    '/api/recover-explore',
    { schema: { body: recoverExploreBody } },
    async (request, reply) => {
      if (!requireAdmin(config, reply)) return;
      if (config.server.network) {
        reply.code(403).send({ error: 'Automatic Chrome handoff is only supported in local desktop mode. Use schrute_connect_cdp manually on the local machine.' });
        return;
      }
      const result = await router.recoverExplore(request.body.resumeToken, request.body.waitMs);
      routerResultToReply(result, reply);
    },
  );

  // ─── Sessions ──────────────────────────────────────────
  app.get('/api/sessions', async (_request, reply) => {
    if (!requireAdmin(config, reply)) return;
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
      if (!requireAdmin(config, reply)) return;
      const { name } = request.params;
      const force = (request.query as Record<string, string>)?.force === 'true';
      const multiSession = engine.getMultiSessionManager();
      try {
        const expectedId = name === DEFAULT_SESSION_NAME && force
          ? engine.getActiveSessionId()
          : null;
        await multiSession.close(name, { engineMode: engine.getMode(), force });
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
      if (!requireAdmin(config, reply)) return;
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
      if (!requireAdmin(config, reply)) return;
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
        // Same flow as schrute_connect_cdp: connect under throwaway synthetic ID,
        // derive real siteId, overlay CDP policy, clean up synthetic.
        const tmpSiteId = sanitizeSiteId(`cdp-tmp-${name}`);
        let policyPersisted = setupCdpSitePolicy(tmpSiteId, userDomains, config).persisted;

        const multiSession = engine.getMultiSessionManager();
        let session;
        try {
          session = await multiSession.connectCDP(
            name, { port, wsEndpoint, host, autoDiscover: autoDiscover === true }, tmpSiteId,
          );
        } catch (connectErr) {
          // Clean up temporary policy on failed connect
          const { invalidatePolicyCache } = await import('../core/policy.js');
          invalidatePolicyCache(tmpSiteId, config);
          try {
            const { getDatabase } = await import('../storage/database.js');
            getDatabase(config).run('DELETE FROM policies WHERE site_id = ?', tmpSiteId);
          } catch (err) { log.debug({ err, tmpSiteId }, 'Policy cleanup failed after connect error'); }
          throw connectErr;
        }

        // Determine final siteId (user-provided or derived from active page)
        let finalSiteId = userSiteId ? sanitizeSiteId(userSiteId) : tmpSiteId;
        if (!userSiteId) {
          try {
            const browser = session.browserManager.getBrowser();
            if (browser) {
              for (const ctx of browser.contexts()) {
                for (const page of ctx.pages()) {
                  const pageUrl = page.url();
                  if (pageUrl && pageUrl !== 'about:blank') {
                    const derivedHost = new URL(pageUrl).hostname;
                    if (derivedHost) { finalSiteId = sanitizeSiteId(derivedHost); break; }
                  }
                }
                if (finalSiteId !== tmpSiteId) break;
              }
            }
          } catch (err) { log.debug({ err }, 'SiteId derivation from browser pages failed'); }
        }

        // Capture pre-connect policy, overlay CDP fields, store prior for restore on close
        const { getSitePolicy, mergeSitePolicy, invalidatePolicyCache, sanitizeImplicitAllowlist } = await import('../core/policy.js');
        const priorPolicy = getSitePolicy(finalSiteId, config);
        const mergeResult = mergeSitePolicy(finalSiteId, {
          domainAllowlist: [...new Set([
            ...priorPolicy.domainAllowlist,
            '127.0.0.1', 'localhost', '[::1]',
            ...(userDomains ? sanitizeImplicitAllowlist(userDomains) : []),
          ])],
          executionBackend: 'live-chrome' as const,
          executionSessionName: name,
        }, config);
        if (!mergeResult.persisted) policyPersisted = false;
        session.cdpPriorPolicyState = {
          domainAllowlist: priorPolicy.domainAllowlist,
          executionBackend: priorPolicy.executionBackend,
          executionSessionName: priorPolicy.executionSessionName,
        };

        // Rebind from synthetic to final and clean up synthetic policy.
        // Only when we actually derived a different ID — if tmpSiteId IS the
        // final ID (no page hostname found), it's the live session's policy.
        if (finalSiteId !== tmpSiteId) {
          multiSession.updateSiteId(name, finalSiteId);
          session.browserManager.rebindSiteId(tmpSiteId, finalSiteId);

          invalidatePolicyCache(tmpSiteId, config);
          try {
            const { getDatabase } = await import('../storage/database.js');
            const db = getDatabase(config);
            db.run('DELETE FROM policies WHERE site_id = ?', tmpSiteId);
          } catch (err) { log.debug({ err, tmpSiteId }, 'Synthetic policy cleanup failed'); }
        }

        const policy = getSitePolicy(finalSiteId, config);
        reply.code(200).send({
          session: name,
          siteId: finalSiteId,
          status: 'connected',
          domains: policy.domainAllowlist,
          ...(!policyPersisted ? { warning: 'Policy applied in-memory but failed to persist to database' } : {}),
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
      if (!requireAdmin(config, reply)) return;
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

  // ─── Execute by ID (legacy — delegates to service for consistent safety) ───
  app.post<{ Body: { skillId: string; params?: Record<string, unknown> } }>(
    '/api/execute',
    async (request, reply) => {
      const { skillId, params } = request.body ?? {};
      if (!skillId) {
        reply.code(400).send({ error: 'skillId is required' });
        return;
      }
      try {
        const outcome = await appService.executeSkill(skillId, params ?? {}, getCallerId(request));
        if (outcome.status === 'confirmation_required') {
          reply.code(202).send(outcome);
          return;
        }
        if (outcome.result.success) {
          reply.code(200).send(outcome.result);
        } else {
          reply.code(422).send(outcome.result);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (message.includes('not found')) {
          reply.code(404).send({ error: message });
        } else if (message.includes('not active')) {
          reply.code(409).send({ error: message });
        } else {
          reply.code(500).send({ error: message });
        }
      }
    },
  );

  // ─── OpenAPI Spec ────────────────────────────────────────
  app.get('/api/openapi.json', async (request, reply) => {
    const host = request.headers.host ?? `localhost:${port}`;
    const rawProto = request.headers['x-forwarded-proto'];
    const firstProto = (Array.isArray(rawProto) ? rawProto[0] : rawProto)?.split(',')[0]?.trim();
    const protocol = firstProto === 'https' ? 'https' : 'http';
    const serverUrl = `${protocol}://${host}`;
    const spec = buildOpenApiSpec(skillRepo, { serverUrl });
    reply.code(200).send(spec);
  });

  // ─── Swagger UI (redirect) ──────────────────────────────
  app.get('/api/docs', async (_request, reply) => {
    // Serve a minimal HTML page that loads Swagger UI from CDN
    const html = `<!DOCTYPE html>
<html>
<head>
  <title>Schrute API Docs</title>
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
  app.get('/api/status', async (request, reply) => {
    const status = await getShapedStatus(engine, config, getCallerId(request));
    reply.code(200).send(status);
  });

  // ─── Versioned API v1 ────────────────────────────────────

  function apiResponse<T>(data: T, requestId: string) {
    return {
      success: true as const,
      data,
      meta: { version: '1.0', timestamp: new Date().toISOString(), requestId },
    };
  }

  function apiError(code: string, message: string, requestId: string, details?: Record<string, unknown>) {
    return {
      success: false as const,
      error: { code, message, requestId, ...details },
      meta: { version: '1.0', timestamp: new Date().toISOString() },
    };
  }

  // Request ID decorator
  function getRequestId(request: { headers: Record<string, unknown> }): string {
    return (request.headers['x-request-id'] as string) || randomUUID();
  }

  app.addHook('onRequest', async (request, reply) => {
    reply.header('X-Request-ID', getRequestId(request));
  });

  app.get('/api/v1/status', async (request, reply) => {
    const reqId = getRequestId(request);
    const status = await getShapedStatus(engine, config, getCallerId(request));
    reply.code(200).send(apiResponse(status, reqId));
  });

  app.get('/api/v1/sites', async (request, reply) => {
    const reqId = getRequestId(request);
    reply.code(200).send(apiResponse(appService.listSites(), reqId));
  });

  app.get<{ Params: { id: string } }>(
    '/api/v1/sites/:id',
    { schema: { params: siteIdParam } },
    async (request, reply) => {
      const reqId = getRequestId(request);
      const site = appService.getSite(request.params.id);
      if (site) {
        reply.code(200).send(apiResponse(site, reqId));
      } else {
        reply.code(404).send(apiError('SITE_NOT_FOUND', `Site '${request.params.id}' not found`, reqId));
      }
    },
  );

  app.get<{ Params: { id: string }; Querystring: { status?: string } }>(
    '/api/v1/sites/:id/skills',
    { schema: { params: siteIdParam, querystring: skillsQuerystring } },
    async (request, reply) => {
      const reqId = getRequestId(request);
      const skills = await appService.listSkills(
        request.params.id,
        request.query.status as SkillStatusName | undefined,
      );
      reply.code(200).send(apiResponse(skills, reqId));
    },
  );

  app.post<{ Body: { url: string; proxy?: Record<string, unknown>; geo?: Record<string, unknown> } }>(
    '/api/v1/explore',
    { schema: { body: exploreBody } },
    async (request, reply) => {
      if (!requireAdmin(config, reply)) return;
      const reqId = getRequestId(request);
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
        const data = await appService.explore(request.body.url, overrides);
        reply.code(200).send(apiResponse(data, reqId));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        reply.code(400).send(apiError('EXPLORE_ERROR', message, reqId));
      }
    },
  );

  app.post<{ Body: { resumeToken: string; waitMs?: number } }>(
    '/api/v1/recover-explore',
    { schema: { body: recoverExploreBody } },
    async (request, reply) => {
      if (!requireAdmin(config, reply)) return;
      const reqId = getRequestId(request);
      if (config.server.network) {
        reply.code(403).send(apiError('RECOVERY_UNSUPPORTED', 'Automatic Chrome handoff is only supported in local desktop mode. Use schrute_connect_cdp manually on the local machine.', reqId));
        return;
      }
      try {
        const data = await appService.recoverExplore(request.body.resumeToken, request.body.waitMs);
        reply.code(200).send(apiResponse(data, reqId));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        reply.code(400).send(apiError('RECOVERY_ERROR', message, reqId));
      }
    },
  );

  app.post<{ Body: { skillId: string; params?: Record<string, unknown> } }>(
    '/api/v1/execute',
    async (request, reply) => {
      const reqId = getRequestId(request);
      const { skillId, params } = request.body ?? {};
      if (!skillId) {
        reply.code(400).send(apiError('VALIDATION_ERROR', 'skillId is required', reqId));
        return;
      }
      try {
        const outcome = await appService.executeSkill(skillId, params ?? {}, getCallerId(request));
        if (outcome.status === 'confirmation_required') {
          reply.code(202).send(apiResponse({
            ...outcome,
            message: 'This skill has not been validated yet. Please confirm execution.',
          }, reqId));
          return;
        }
        // outcome.status === 'executed'
        if (outcome.result.success) {
          reply.code(200).send(apiResponse(outcome.result, reqId));
        } else {
          reply.code(422).send(apiError('EXECUTION_ERROR', outcome.result.error ?? 'Execution failed', reqId, { failureCause: outcome.result.failureCause, failureDetail: outcome.result.failureDetail }));
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (message.includes('not found')) {
          reply.code(404).send(apiError('NOT_FOUND', message, reqId));
        } else if (message.includes('not active')) {
          reply.code(409).send(apiError('SKILL_NOT_ACTIVE', message, reqId));
        } else {
          reply.code(500).send(apiError('EXECUTION_ERROR', message, reqId));
        }
      }
    },
  );

  // ─── List all skills (all statuses) ─────────────────────
  app.get<{ Querystring: { siteId?: string; status?: string } }>(
    '/api/v1/skills',
    async (request, reply) => {
      const reqId = getRequestId(request);
      try {
        const browserManagerList = engine.getSessionManager().getBrowserManager();
        const skills = await appService.listSkills(
          request.query.siteId,
          request.query.status as SkillStatusName | undefined,
        );
        reply.code(200).send(apiResponse(skills.map(s => {
          const execInfo = getSkillExecutability(s, browserManagerList);
          return {
            id: s.id,
            name: s.name,
            siteId: s.siteId,
            method: s.method,
            pathTemplate: s.pathTemplate,
            status: s.status,
            successRate: s.successRate,
            currentTier: s.currentTier,
            executable: execInfo.executable,
            ...(execInfo.blockedReason ? { blockedReason: execInfo.blockedReason } : {}),
          };
        }), reqId));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        reply.code(500).send(apiError('LIST_ERROR', message, reqId));
      }
    },
  );

  app.post<{ Body: { query?: string; siteId?: string; limit?: number; includeInactive?: boolean } }>(
    '/api/v1/skills/search',
    async (request, reply) => {
      const reqId = getRequestId(request);
      const { query, siteId, limit, includeInactive } = request.body ?? {};
      try {
        const browserManagerSearch = engine.getSessionManager().getBrowserManager();
        const k = limit ?? config.toolShortlistK ?? 10;

        const response = searchAndProjectSkills(skillRepo, browserManagerSearch, {
          query, siteId, limit: k, includeInactive: includeInactive ?? false,
        });

        reply.code(200).send(apiResponse(response, reqId));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        reply.code(500).send(apiError('SEARCH_ERROR', message, reqId));
      }
    },
  );

  // WS-12: GET search mirroring POST defaults
  app.get<{ Querystring: { query?: string; siteId?: string; limit?: string; includeInactive?: string } }>(
    '/api/v1/skills/search',
    async (request, reply) => {
      const reqId = getRequestId(request);
      const { query, siteId, limit: limitStr, includeInactive } = request.query;
      const limit = limitStr ? parseInt(limitStr, 10) : (config.toolShortlistK ?? 10);
      const browserManager = engine.getSessionManager().getBrowserManager();
      const result = searchAndProjectSkills(skillRepo, browserManager, {
        query, siteId, limit,
        includeInactive: includeInactive === 'true',
      });
      return reply.send(apiResponse(result, reqId));
    },
  );

  app.get('/api/v1/sessions', async (request, reply) => {
    if (!requireAdmin(config, reply)) return;
    const reqId = getRequestId(request);
    reply.code(200).send(apiResponse(appService.listSessions(), reqId));
  });

  app.post<{ Body: { name: string; inputs?: Record<string, string> } }>(
    '/api/v1/record',
    { schema: { body: recordBody } },
    async (request, reply) => {
      if (!requireAdmin(config, reply)) return;
      const reqId = getRequestId(request);
      try {
        await appService.startRecording(request.body.name, request.body.inputs);
        reply.code(200).send(apiResponse({ recording: request.body.name }, reqId));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        reply.code(400).send(apiError('RECORD_ERROR', message, reqId));
      }
    },
  );

  app.post('/api/v1/stop', async (request, reply) => {
    if (!requireAdmin(config, reply)) return;
    const reqId = getRequestId(request);
    try {
      const result = await withTimeout(appService.stopRecording(), 30_000, 'stopRecording');
      reply.code(200).send(apiResponse(result, reqId));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      reply.code(400).send(apiError('STOP_ERROR', message, reqId));
    }
  });

  app.get<{ Params: { jobId: string } }>(
    '/api/v1/pipeline/:jobId',
    { schema: { params: pipelineJobParam } },
    async (request, reply) => {
      if (!requireAdmin(config, reply)) return;
      const reqId = getRequestId(request);
      const result = router.getPipelineStatus(request.params.jobId);
      if (result.success) {
        reply.code(200).send(apiResponse(result.data, reqId));
      } else if (result.statusCode === 404) {
        reply.code(404).send(apiError('PIPELINE_NOT_FOUND', result.error, reqId));
      } else if (result.statusCode === 501) {
        reply.code(501).send(apiError('PIPELINE_UNSUPPORTED', result.error, reqId));
      } else {
        reply.code(result.statusCode ?? 400).send(apiError('PIPELINE_ERROR', result.error, reqId));
      }
    },
  );

  app.post<{ Body: { token: string; approve: boolean } }>(
    '/api/v1/confirm',
    async (request, reply) => {
      const reqId = getRequestId(request);
      const { token, approve } = request.body ?? {};
      if (!token || typeof approve !== 'boolean') {
        reply.code(400).send(apiError('VALIDATION_ERROR', 'token and approve (boolean) are required', reqId));
        return;
      }
      try {
        const result = appService.confirm(token, approve);
        reply.code(200).send(apiResponse(result, reqId));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        reply.code(400).send(apiError('CONFIRM_ERROR', message, reqId));
      }
    },
  );

  app.post<{ Params: { name: string } }>(
    '/api/v1/sessions/:name/close',
    async (request, reply) => {
      if (!requireAdmin(config, reply)) return;
      const reqId = getRequestId(request);
      try {
        await appService.closeSession(request.params.name);
        reply.code(200).send(apiResponse({ closed: request.params.name }, reqId));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        reply.code(400).send(apiError('SESSION_ERROR', message, reqId));
      }
    },
  );

  app.post<{ Params: { id: string } }>(
    '/api/v1/skills/:id/activate',
    async (request, reply) => {
      const reqId = getRequestId(request);
      try {
        const skill = appService.activateSkill(request.params.id);
        reply.code(200).send(apiResponse(skill, reqId));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (message.includes('not found')) {
          reply.code(404).send(apiError('NOT_FOUND', message, reqId));
        } else {
          reply.code(400).send(apiError('ACTIVATE_ERROR', message, reqId));
        }
      }
    },
  );

  // ─── Revoke Skill Approval ──────────────────────────────
  app.post<{ Params: { id: string } }>(
    '/api/v1/skills/:id/revoke',
    async (request, reply) => {
      const reqId = getRequestId(request);
      try {
        const skill = skillRepo.getById(request.params.id);
        if (!skill) {
          reply.code(404).send(apiError('NOT_FOUND', `Skill '${request.params.id}' not found`, reqId));
          return;
        }
        appService.revokeApproval(request.params.id);
        reply.code(200).send(apiResponse({ revoked: true, skillId: request.params.id }, reqId));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        reply.code(400).send(apiError('REVOKE_ERROR', message, reqId));
      }
    },
  );

  // ─── Skill Amendments ──────────────────────────────────────
  app.get<{ Params: { id: string } }>(
    '/api/v1/skills/:id/amendments',
    { schema: { params: siteIdParam } },
    async (request, reply) => {
      const reqId = getRequestId(request);
      const amendmentRepo = engine.getAmendmentRepo();
      if (!amendmentRepo) {
        reply.code(501).send(apiError('NOT_AVAILABLE', 'Amendment tracking not available', reqId));
        return;
      }
      const amendments = amendmentRepo.getBySkillId(request.params.id);
      reply.code(200).send(apiResponse(amendments, reqId));
    },
  );

  // ─── Skill GEPA Optimization ──────────────────────────────────
  app.post<{ Params: { id: string } }>(
    '/api/v1/skills/:id/optimize',
    { schema: { params: siteIdParam } },
    async (request, reply) => {
      const reqId = getRequestId(request);
      const skillId = request.params.id;
      const skill = skillRepo.getById(skillId);
      if (!skill) {
        reply.code(404).send(apiError('NOT_FOUND', `Skill '${skillId}' not found`, reqId));
        return;
      }
      const amendmentRepo = engine.getAmendmentRepo();
      const exemplarRepo = engine.getExemplarRepo();
      if (!amendmentRepo) {
        reply.code(503).send(apiError('NOT_AVAILABLE', 'Amendment or exemplar tracking not available', reqId));
        return;
      }
      try {
        const { GepaEngine } = await import('../healing/gepa.js');
        const { AmendmentEngine } = await import('../healing/amendment.js');
        const metricsRepo = engine.getMetricsRepo();
        const amendmentEngine = new AmendmentEngine(amendmentRepo, skillRepo, metricsRepo);
        const gepa = new GepaEngine(skillRepo, amendmentRepo, exemplarRepo, amendmentEngine);
        const result = await gepa.optimize(skillId);
        reply.code(200).send(apiResponse(result, reqId));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        reply.code(500).send(apiError('OPTIMIZE_ERROR', message, reqId));
      }
    },
  );

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
