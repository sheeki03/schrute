import { createHash, randomBytes, createHmac } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { getLogger } from '../core/logger.js';
import { getConfig } from '../core/config.js';
import { Engine } from '../core/engine.js';
import { getDatabase } from '../storage/database.js';
import { SkillRepository } from '../storage/skill-repository.js';
import { SiteRepository } from '../storage/site-repository.js';
import type {
  SkillSpec,
  ConfirmationToken,
  OneAgentConfig,
} from '../skill/types.js';
import {
  SkillStatus,
  ALLOWED_BROWSER_TOOLS,
  BLOCKED_BROWSER_TOOLS,
} from '../skill/types.js';
import { dryRun } from '../replay/dry-run.js';
import {
  rankToolsByIntent,
  skillToToolName,
  skillToToolDefinition,
  getBrowserToolDefinitions,
  META_TOOLS,
} from './tool-registry.js';

const log = getLogger();

// ─── Confirmation Token Store ────────────────────────────────────

const HMAC_SECRET = randomBytes(32);
const pendingConfirmations = new Map<string, ConfirmationToken>();

function generateConfirmationToken(
  skillId: string,
  params: Record<string, unknown>,
  tier: string,
  config: OneAgentConfig,
): ConfirmationToken {
  const nonce = randomBytes(16).toString('hex');
  const paramsHash = createHash('sha256')
    .update(JSON.stringify(params))
    .digest('hex');
  const now = Date.now();

  const token: ConfirmationToken = {
    nonce,
    skillId,
    paramsHash,
    tier,
    createdAt: now,
    expiresAt: now + config.confirmationExpiryMs,
    consumed: false,
  };

  // Sign with HMAC
  const hmacPayload = `${skillId}|${paramsHash}|${tier}|${token.expiresAt}|${nonce}`;
  const hmac = createHmac('sha256', HMAC_SECRET).update(hmacPayload).digest('hex');
  const tokenId = hmac;

  pendingConfirmations.set(tokenId, token);
  return { ...token, nonce: tokenId };
}

function verifyConfirmationToken(
  tokenId: string,
  config: OneAgentConfig,
): { valid: boolean; token?: ConfirmationToken; error?: string } {
  const token = pendingConfirmations.get(tokenId);
  if (!token) {
    return { valid: false, error: 'Token not found' };
  }

  if (token.consumed) {
    return { valid: false, error: 'Token already consumed' };
  }

  if (Date.now() > token.expiresAt) {
    pendingConfirmations.delete(tokenId);
    return { valid: false, error: 'Token expired' };
  }

  return { valid: true, token };
}

function consumeToken(tokenId: string): void {
  const token = pendingConfirmations.get(tokenId);
  if (token) {
    token.consumed = true;
    token.consumedAt = Date.now();
  }
}

// Tool definitions (rankToolsByIntent, skillToToolName, skillToToolDefinition,
// getBrowserToolDefinitions, META_TOOLS) are imported from ./tool-registry.js

// ─── MCP Server ──────────────────────────────────────────────────

export async function startMcpServer(): Promise<void> {
  const config = getConfig();
  const engine = new Engine(config);
  const db = getDatabase(config);
  const skillRepo = new SkillRepository(db);
  const siteRepo = new SiteRepository(db);

  // Track which skills are currently exposed
  let lastActiveSkillIds: string[] = [];

  const server = new Server(
    {
      name: 'oneagent',
      version: '0.1.0',
    },
    {
      capabilities: {
        tools: {},
      },
    },
  );

  // ─── List Tools Handler ───────────────────────────────────────

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const tools: Array<{
      name: string;
      description: string;
      inputSchema: Record<string, unknown>;
    }> = [];

    // 1. Meta tools
    tools.push(...META_TOOLS);

    // 2. Browser tools (allowlisted)
    tools.push(...getBrowserToolDefinitions());

    // 3. Active skill tools
    const activeSkills = skillRepo.getByStatus(SkillStatus.ACTIVE);
    const shortlisted = rankToolsByIntent(
      activeSkills,
      undefined,
      config.maxToolsPerSite,
    );

    for (const skill of shortlisted) {
      tools.push(skillToToolDefinition(skill));
    }

    // Track for change detection
    const currentIds = shortlisted.map((s) => s.id).sort();
    if (JSON.stringify(currentIds) !== JSON.stringify(lastActiveSkillIds)) {
      lastActiveSkillIds = currentIds;
      // Notify that tools changed
      try {
        await server.notification({
          method: 'notifications/tools/list_changed',
        });
      } catch {
        // Notification may fail if client doesn't support it
      }
    }

    return { tools };
  });

  // ─── Call Tool Handler ────────────────────────────────────────

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
      // ─── Meta Tools ────────────────────────────────────────
      switch (name) {
        case 'oneagent_explore': {
          const url = args?.url as string;
          if (!url) {
            return { content: [{ type: 'text', text: 'Error: url is required' }], isError: true };
          }
          const result = await engine.explore(url);
          return {
            content: [{
              type: 'text',
              text: JSON.stringify(result, null, 2),
            }],
          };
        }

        case 'oneagent_record': {
          const recordName = args?.name as string;
          if (!recordName) {
            return { content: [{ type: 'text', text: 'Error: name is required' }], isError: true };
          }
          const inputs = args?.inputs as Record<string, string> | undefined;
          const result = await engine.startRecording(recordName, inputs);
          return {
            content: [{
              type: 'text',
              text: JSON.stringify(result, null, 2),
            }],
          };
        }

        case 'oneagent_stop': {
          const result = await engine.stopRecording();
          return {
            content: [{
              type: 'text',
              text: JSON.stringify(result, null, 2),
            }],
          };
        }

        case 'oneagent_sites': {
          const sites = siteRepo.getAll();
          return {
            content: [{
              type: 'text',
              text: JSON.stringify(sites, null, 2),
            }],
          };
        }

        case 'oneagent_skills': {
          const siteId = args?.siteId as string | undefined;
          let skills: SkillSpec[];
          if (siteId) {
            skills = skillRepo.getBySiteId(siteId);
          } else {
            skills = [
              ...skillRepo.getByStatus(SkillStatus.ACTIVE),
              ...skillRepo.getByStatus(SkillStatus.DRAFT),
              ...skillRepo.getByStatus(SkillStatus.STALE),
              ...skillRepo.getByStatus(SkillStatus.BROKEN),
            ];
          }
          const summary = skills.map((s) => ({
            id: s.id,
            name: s.name,
            status: s.status,
            siteId: s.siteId,
            method: s.method,
            pathTemplate: s.pathTemplate,
            successRate: s.successRate,
            currentTier: s.currentTier,
          }));
          return {
            content: [{
              type: 'text',
              text: JSON.stringify(summary, null, 2),
            }],
          };
        }

        case 'oneagent_status': {
          const status = engine.getStatus();
          return {
            content: [{
              type: 'text',
              text: JSON.stringify(status, null, 2),
            }],
          };
        }

        case 'oneagent_dry_run': {
          const skillId = args?.skillId as string;
          if (!skillId) {
            return { content: [{ type: 'text', text: 'Error: skillId is required' }], isError: true };
          }
          const skill = skillRepo.getById(skillId);
          if (!skill) {
            return { content: [{ type: 'text', text: `Error: skill '${skillId}' not found` }], isError: true };
          }
          const params = (args?.params ?? {}) as Record<string, unknown>;
          const mode = (args?.mode as string) === 'developer-debug' ? 'developer-debug' as const : 'agent-safe' as const;

          const preview = dryRun(skill, params, mode);

          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                ...preview,
                note: 'This is a preview only. No request was sent.',
              }, null, 2),
            }],
          };
        }

        case 'oneagent_confirm': {
          const confirmationToken = args?.confirmationToken as string;
          const approve = args?.approve as boolean;
          if (!confirmationToken) {
            return { content: [{ type: 'text', text: 'Error: confirmationToken is required' }], isError: true };
          }
          if (typeof approve !== 'boolean') {
            return { content: [{ type: 'text', text: 'Error: approve must be a boolean' }], isError: true };
          }

          const verification = verifyConfirmationToken(confirmationToken, config);
          if (!verification.valid) {
            return {
              content: [{ type: 'text', text: `Confirmation failed: ${verification.error}` }],
              isError: true,
            };
          }

          consumeToken(confirmationToken);

          if (approve) {
            return {
              content: [{
                type: 'text',
                text: JSON.stringify({
                  status: 'approved',
                  skillId: verification.token!.skillId,
                  tier: verification.token!.tier,
                }),
              }],
            };
          } else {
            return {
              content: [{
                type: 'text',
                text: JSON.stringify({
                  status: 'denied',
                  skillId: verification.token!.skillId,
                }),
              }],
            };
          }
        }
      }

      // ─── Browser Tool Proxy ────────────────────────────────
      if ((ALLOWED_BROWSER_TOOLS as readonly string[]).includes(name)) {
        // Proxy allowed browser tools through the engine's active session
        const status = engine.getStatus();
        if (!status.activeSession) {
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                error: 'No active browser session. Use oneagent_explore first.',
                tool: name,
              }),
            }],
            isError: true,
          };
        }

        // Dispatch to the browser provider via the engine
        // The PlaywrightMcpAdapter validates the tool against the allowlist
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              tool: name,
              sessionId: status.activeSession.id,
              siteId: status.activeSession.siteId,
              args,
              dispatched: true,
            }),
          }],
        };
      }

      // ─── Blocked Browser Tools ─────────────────────────────
      if ((BLOCKED_BROWSER_TOOLS as readonly string[]).includes(name)) {
        return {
          content: [{
            type: 'text',
            text: `BLOCKED: Tool "${name}" is explicitly blocked for security.`,
          }],
          isError: true,
        };
      }

      // ─── Skill Execution ──────────────────────────────────
      // Check if the tool name matches an active skill
      const activeSkills = skillRepo.getByStatus(SkillStatus.ACTIVE);
      const matchedSkill = activeSkills.find(
        (s) => skillToToolName(s) === name,
      );

      if (matchedSkill) {
        const params = (args ?? {}) as Record<string, unknown>;
        const paramsHash = createHash('sha256')
          .update(JSON.stringify(params))
          .digest('hex');

        // First-run confirmation flow for new skills
        if (matchedSkill.consecutiveValidations < 1) {
          const token = generateConfirmationToken(
            matchedSkill.id,
            params,
            matchedSkill.currentTier,
            config,
          );

          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                status: 'confirmation_required',
                message: 'This skill has not been validated yet. Please confirm execution.',
                skillId: matchedSkill.id,
                confirmationToken: token.nonce,
                expiresAt: token.expiresAt,
                sideEffectClass: matchedSkill.sideEffectClass,
                method: matchedSkill.method,
                pathTemplate: matchedSkill.pathTemplate,
              }),
            }],
          };
        }

        // Execute the skill
        const result = await engine.executeSkill(matchedSkill.id, params);
        return {
          content: [{
            type: 'text',
            text: JSON.stringify(result, null, 2),
          }],
        };
      }

      // ─── Unknown Tool ─────────────────────────────────────
      return {
        content: [{
          type: 'text',
          text: `Unknown tool: ${name}`,
        }],
        isError: true,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error({ tool: name, err }, 'Tool execution error');
      return {
        content: [{ type: 'text', text: `Error: ${message}` }],
        isError: true,
      };
    }
  });

  // ─── Periodic Tool List Change Detection ──────────────────────

  const toolRefreshInterval = setInterval(async () => {
    try {
      const activeSkills = skillRepo.getByStatus(SkillStatus.ACTIVE);
      const currentIds = activeSkills.map((s) => s.id).sort();
      if (JSON.stringify(currentIds) !== JSON.stringify(lastActiveSkillIds)) {
        lastActiveSkillIds = currentIds;
        await server.notification({
          method: 'notifications/tools/list_changed',
        });
        log.info('Tool list changed, notified client');
      }
    } catch {
      // Ignore polling errors
    }
  }, 5000);

  // ─── Start Server ─────────────────────────────────────────────

  const transport = new StdioServerTransport();

  log.info('Starting MCP stdio server');

  process.on('SIGINT', async () => {
    clearInterval(toolRefreshInterval);
    await engine.close();
    await server.close();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    clearInterval(toolRefreshInterval);
    await engine.close();
    await server.close();
    process.exit(0);
  });

  await server.connect(transport);
}
