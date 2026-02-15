import {
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { getLogger } from '../core/logger.js';
import type { ToolDispatchDeps } from './tool-dispatch.js';
import type { SkillSpec } from '../skill/types.js';
import { SkillStatus } from '../skill/types.js';

const log = getLogger();

// ─── Skill Redaction ────────────────────────────────────────────────

interface SkillSummary {
  id: string;
  name: string;
  siteId: string;
  method: string;
  pathTemplate: string;
  description?: string;
  status: string;
  currentTier: string;
  sideEffectClass: string;
  successRate: number;
  sampleCount: number;
  parameters: Array<{ name: string; required: boolean; description?: string }>;
}

function redactSkill(skill: SkillSpec): SkillSummary {
  return {
    id: skill.id,
    name: skill.name,
    siteId: skill.siteId,
    method: skill.method,
    pathTemplate: skill.pathTemplate,
    description: skill.description,
    status: skill.status,
    currentTier: skill.currentTier,
    sideEffectClass: skill.sideEffectClass,
    successRate: skill.successRate,
    sampleCount: skill.sampleCount,
    parameters: skill.parameters.map((p) => ({
      name: p.name,
      required: p.source === 'user_input',
      description: undefined,
    })),
  };
}

// ─── Truncation ─────────────────────────────────────────────────────

const MAX_ITEMS = 1000;
const MAX_BYTES = 1024 * 1024; // 1MB

interface TruncatedList<T> {
  total: number;
  returned: number;
  truncated: boolean;
  items: T[];
}

function truncateList<T>(items: T[]): TruncatedList<T> {
  const total = items.length;

  // Apply count cap first
  let capped = items.length > MAX_ITEMS ? items.slice(0, MAX_ITEMS) : items;

  // Check serialized size
  let serialized = JSON.stringify(capped);
  if (serialized.length <= MAX_BYTES) {
    return {
      total,
      returned: capped.length,
      truncated: capped.length < total,
      items: capped,
    };
  }

  // Binary search for largest N that fits under 1MB
  let lo = 0;
  let hi = capped.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    const slice = capped.slice(0, mid);
    if (JSON.stringify(slice).length <= MAX_BYTES) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }

  capped = capped.slice(0, lo);
  return {
    total,
    returned: capped.length,
    truncated: true,
    items: capped,
  };
}

// ─── Resources ──────────────────────────────────────────────────────

export function registerResourceHandlers(server: Server, deps: ToolDispatchDeps): void {
  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    return {
      resources: [
        {
          uri: 'oneagent://status',
          name: 'Engine Status',
          mimeType: 'application/json',
          description: 'Engine mode, uptime, and active session info',
        },
        {
          uri: 'oneagent://skills',
          name: 'Skill Catalog',
          mimeType: 'application/json',
          description: 'Redacted skill summaries',
        },
        {
          uri: 'oneagent://sites',
          name: 'Known Sites',
          mimeType: 'application/json',
          description: 'Sites with visit history',
        },
      ],
    };
  });

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const uri = request.params.uri;

    try {
      switch (uri) {
        case 'oneagent://status': {
          const status = deps.engine.getStatus();
          return {
            contents: [
              {
                uri,
                mimeType: 'application/json',
                text: JSON.stringify(status, null, 2),
              },
            ],
          };
        }

        case 'oneagent://skills': {
          const allSkills = typeof deps.skillRepo.getAll === 'function'
            ? deps.skillRepo.getAll()
            : [
              ...deps.skillRepo.getByStatus(SkillStatus.ACTIVE),
              ...deps.skillRepo.getByStatus(SkillStatus.DRAFT),
              ...deps.skillRepo.getByStatus(SkillStatus.STALE),
              ...deps.skillRepo.getByStatus(SkillStatus.BROKEN),
            ];
          // Sort by createdAt desc (newest first)
          allSkills.sort((a, b) => b.createdAt - a.createdAt);
          const redacted = allSkills.map(redactSkill);
          const result = truncateList(redacted);
          return {
            contents: [
              {
                uri,
                mimeType: 'application/json',
                text: JSON.stringify(result, null, 2),
              },
            ],
          };
        }

        case 'oneagent://sites': {
          const allSites = deps.siteRepo.getAll();
          // Already ordered by lastVisited desc from repository
          const siteSummaries = allSites.map((s) => ({
            id: s.id,
            displayName: s.displayName,
            firstSeen: s.firstSeen,
            lastVisited: s.lastVisited,
          }));
          const result = truncateList(siteSummaries);
          return {
            contents: [
              {
                uri,
                mimeType: 'application/json',
                text: JSON.stringify(result, null, 2),
              },
            ],
          };
        }

        default:
          return {
            contents: [
              {
                uri,
                mimeType: 'text/plain',
                text: `Error: Unknown resource URI '${uri}'`,
              },
            ],
          };
      }
    } catch (err) {
      // Log server-side for diagnostics before converting to client-safe text
      log.error({ err, uri }, 'MCP resource handler error');
      // Never throw from resource handlers — always return valid MCP payload shape
      return {
        contents: [
          {
            uri,
            mimeType: 'text/plain',
            text: `Error: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
      };
    }
  });
}

// ─── Prompts ────────────────────────────────────────────────────────

export function registerPromptHandlers(server: Server, deps: ToolDispatchDeps): void {
  server.setRequestHandler(ListPromptsRequestSchema, async () => {
    return {
      prompts: [
        {
          name: 'explore-site',
          description: 'Walk through exploring a website to discover its API',
          arguments: [
            {
              name: 'url',
              description: 'The URL of the website to explore',
              required: true,
            },
          ],
        },
        {
          name: 'record-action',
          description: 'Record a browser action to create a replayable skill',
          arguments: [
            {
              name: 'url',
              description: 'The URL where the action takes place',
              required: true,
            },
            {
              name: 'action_name',
              description: 'A descriptive name for the action being recorded',
              required: true,
            },
          ],
        },
      ],
    };
  });

  server.setRequestHandler(GetPromptRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    switch (name) {
      case 'explore-site': {
        const url = args?.url ?? 'the target website';
        return {
          messages: [
            {
              role: 'user' as const,
              content: {
                type: 'text' as const,
                text:
                  `I want to explore ${url} and discover its API endpoints. ` +
                  `Start by calling oneagent_explore with this URL, then take a browser_snapshot ` +
                  `to see the page. Look for interactive elements (forms, buttons, links) that ` +
                  `might trigger API calls. Suggest which actions would be valuable to record as skills.`,
              },
            },
          ],
        };
      }

      case 'record-action': {
        const url = args?.url ?? 'the target website';
        const actionName = args?.action_name ?? 'the action';
        return {
          messages: [
            {
              role: 'user' as const,
              content: {
                type: 'text' as const,
                text:
                  `I want to record a browser action called "${actionName}" on ${url}. ` +
                  `First, call oneagent_explore with the URL to start a browser session. ` +
                  `Then call oneagent_record with the name "${actionName}". ` +
                  `Perform the action using browser tools (navigate, click, type, etc.). ` +
                  `When the action is complete, call oneagent_stop to process the recording into a skill.`,
              },
            },
          ],
        };
      }

      default:
        throw new Error(`Unknown prompt: ${name}`);
    }
  });
}
