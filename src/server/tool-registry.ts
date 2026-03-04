import type { SkillSpec } from '../skill/types.js';
import { ALLOWED_BROWSER_TOOLS } from '../skill/types.js';

// ─── Tool Shortlist Ranking ──────────────────────────────────────

export function rankToolsByIntent(
  skills: SkillSpec[],
  intent: string | undefined,
  k: number,
): SkillSpec[] {
  if (!intent || skills.length <= k) {
    return skills.slice(0, k);
  }

  const intentLower = intent.toLowerCase();
  const words = intentLower.split(/\s+/);

  const scored = skills.map((skill) => {
    let score = 0;
    const nameLower = (skill.name ?? '').toLowerCase();
    const descLower = (skill.description ?? '').toLowerCase();
    const idLower = skill.id.toLowerCase();

    for (const word of words) {
      if (nameLower.includes(word)) score += 3;
      if (descLower.includes(word)) score += 2;
      if (idLower.includes(word)) score += 1;
    }

    // Boost by success rate and recency
    score += skill.successRate * 2;
    if (skill.lastUsed) {
      const ageHours = (Date.now() - skill.lastUsed) / (1000 * 60 * 60);
      if (ageHours < 24) score += 1;
    }

    return { skill, score };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, k).map((s) => s.skill);
}

// ─── Skill → MCP Tool Conversion ────────────────────────────────

let _metaToolNames: Set<string> | null = null;
function getMetaToolNames(): Set<string> {
  if (!_metaToolNames) {
    _metaToolNames = new Set(META_TOOLS.map(t => t.name));
  }
  return _metaToolNames;
}

export function skillToToolName(skill: SkillSpec): string {
  const action = skill.name
    .replace(/[^a-zA-Z0-9_]/g, '_')
    .replace(/_+/g, '_')
    .toLowerCase();
  const site = skill.siteId
    .replace(/[^a-zA-Z0-9_]/g, '_')
    .replace(/_+/g, '_')
    .toLowerCase();
  const name = `${site}.${action}.v${skill.version}`;

  // Prevent collision with meta tools
  if (getMetaToolNames().has(name)) {
    return `skill_${name}`;
  }
  return name;
}

function buildAutoDescription(skill: SkillSpec): string {
  const parts: string[] = [];
  parts.push(`${skill.method} ${skill.pathTemplate}`);
  if (skill.authType) parts.push(`(auth: ${skill.authType})`);
  parts.push(`[${skill.sideEffectClass}]`);

  const userInputParams = skill.parameters
    .filter(p => p.source === 'user_input')
    .map(p => p.name);
  if (userInputParams.length > 0) {
    parts.push(`Inputs: ${userInputParams.join(', ')}`);
  }

  return parts.join(' — ');
}

export function skillToToolDefinition(skill: SkillSpec) {
  return {
    name: skillToToolName(skill),
    description: skill.description ?? buildAutoDescription(skill),
    inputSchema: {
      type: 'object' as const,
      properties: Object.fromEntries(
        skill.parameters.map((p) => [
          p.name,
          { type: p.type, description: `Source: ${p.source}` },
        ]),
      ),
      required: skill.parameters
        .filter((p) => p.source === 'user_input')
        .map((p) => p.name),
    },
  };
}

// ─── Meta Tool Definitions ──────────────────────────────────────

export const META_TOOLS = [
  {
    name: 'oneagent_explore',
    description: 'Start a browser session to explore a website',
    inputSchema: {
      type: 'object' as const,
      properties: {
        url: { type: 'string', description: 'URL to navigate to' },
        proxy: {
          type: 'object',
          description: 'Proxy for this session (e.g. { "server": "socks5://proxy:1080" })',
          properties: {
            server: { type: 'string' },
            bypass: { type: 'string' },
            username: { type: 'string' },
            password: { type: 'string' },
          },
          required: ['server'],
        },
        geo: {
          type: 'object',
          description: 'Geolocation/locale/timezone for this session',
          properties: {
            geolocation: {
              type: 'object',
              properties: {
                latitude: { type: 'number' },
                longitude: { type: 'number' },
                accuracy: { type: 'number' },
              },
              required: ['latitude', 'longitude'],
            },
            timezoneId: { type: 'string' },
            locale: { type: 'string' },
          },
        },
      },
      required: ['url'],
    },
  },
  {
    name: 'oneagent_record',
    description: 'Start recording an action frame for skill generation',
    inputSchema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'Name for the action frame' },
        inputs: {
          type: 'object',
          description: 'Optional input key-value pairs',
          additionalProperties: { type: 'string' },
        },
      },
      required: ['name'],
    },
  },
  {
    name: 'oneagent_stop',
    description: 'Stop recording, process HAR, and generate skills',
    inputSchema: {
      type: 'object' as const,
      properties: {},
    },
  },
  {
    name: 'oneagent_sites',
    description: 'List all known sites',
    inputSchema: {
      type: 'object' as const,
      properties: {},
    },
  },
  {
    name: 'oneagent_skills',
    description: 'List skills, optionally filtered by site',
    inputSchema: {
      type: 'object' as const,
      properties: {
        siteId: { type: 'string', description: 'Filter by site ID' },
      },
    },
  },
  {
    name: 'oneagent_status',
    description: 'Get current session and engine status',
    inputSchema: {
      type: 'object' as const,
      properties: {},
    },
  },
  {
    name: 'oneagent_dry_run',
    description: 'Preview a request for a skill without executing it',
    inputSchema: {
      type: 'object' as const,
      properties: {
        skillId: { type: 'string', description: 'Skill ID to preview' },
        params: {
          type: 'object',
          description: 'Parameters for the skill',
          additionalProperties: true,
        },
      },
      required: ['skillId'],
    },
  },
  {
    name: 'oneagent_confirm',
    description: 'Confirm or deny first-run of a newly-active skill',
    inputSchema: {
      type: 'object' as const,
      properties: {
        confirmationToken: {
          type: 'string',
          description: 'The confirmation token received from a skill execution',
        },
        approve: {
          type: 'boolean',
          description: 'Whether to approve (true) or deny (false) the execution',
        },
      },
      required: ['confirmationToken', 'approve'],
    },
  },
  {
    name: 'oneagent_connect_cdp',
    description: 'Connect to an Electron app or existing browser via Chrome DevTools Protocol. Domains are host-only (port-agnostic).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'Session name (cannot be "default")' },
        port: { type: 'number', description: 'CDP debugging port (1024-65535)' },
        wsEndpoint: { type: 'string', description: 'WebSocket endpoint URL (alternative to port)' },
        host: { type: 'string', description: 'Host address (default: 127.0.0.1)' },
        siteId: { type: 'string', description: 'Optional site ID for policy' },
        domains: {
          type: 'array',
          items: { type: 'string' },
          description: 'Additional domains to allowlist',
        },
        autoDiscover: {
          type: 'boolean',
          description: 'Scan common CDP ports if no port/wsEndpoint given',
        },
      },
      required: ['name'],
    },
  },
  {
    name: 'oneagent_sessions',
    description: 'List all named browser sessions',
    inputSchema: {
      type: 'object' as const,
      properties: {},
    },
  },
  {
    name: 'oneagent_close_session',
    description: 'Close a named browser session',
    inputSchema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'Session name to close' },
        force: { type: 'boolean', description: 'Force close during exploring mode (blocked during recording to protect HAR capture)' },
      },
      required: ['name'],
    },
  },
  {
    name: 'oneagent_switch_session',
    description: 'Switch active browser session for tool routing',
    inputSchema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'Session name to activate' },
      },
      required: ['name'],
    },
  },
  {
    name: 'oneagent_import_cookies',
    description: 'Import cookies from a Netscape/Mozilla cookie file into a browser context',
    inputSchema: {
      type: 'object' as const,
      properties: {
        siteId: { type: 'string', description: 'Site ID for the browser context' },
        cookieFile: { type: 'string', description: 'Path to Netscape cookie file' },
      },
      required: ['siteId', 'cookieFile'],
    },
  },
  {
    name: 'oneagent_execute',
    description: 'Execute any skill by ID (cross-site)',
    inputSchema: {
      type: 'object' as const,
      properties: {
        skillId: { type: 'string', description: 'Skill ID to execute' },
        params: { type: 'object', description: 'Parameters for the skill', additionalProperties: true },
      },
      required: ['skillId'],
    },
  },
  {
    name: 'oneagent_activate',
    description: 'Manually activate a DRAFT skill (first execution still requires confirmation)',
    inputSchema: {
      type: 'object' as const,
      properties: {
        skillId: { type: 'string', description: 'Skill ID to activate' },
      },
      required: ['skillId'],
    },
  },
  {
    name: 'oneagent_doctor',
    description: 'Run diagnostic checks on browser engine, config, database, etc.',
    inputSchema: {
      type: 'object' as const,
      properties: {},
    },
  },
  {
    name: 'oneagent_export_cookies',
    description: 'Export cookies from a browser context',
    inputSchema: {
      type: 'object' as const,
      properties: {
        siteId: { type: 'string', description: 'Site ID for the browser context' },
      },
      required: ['siteId'],
    },
  },
  {
    name: 'oneagent_webmcp_call',
    description: 'Call a WebMCP tool discovered on the current site. Use oneagent_status to see available tools.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        toolName: { type: 'string', description: 'Name of the WebMCP tool to call' },
        args: { type: 'object', description: 'Arguments to pass to the tool', default: {} },
      },
      required: ['toolName'],
    },
  },
] as const;

// ─── Browser Tool Proxy Definition ───────────────────────────────

// Tools that are NOT allowed inside a batch (inlined to avoid import coupling)
const BATCH_UNSAFE_TOOLS = new Set([
  'browser_close',
  'browser_navigate',
  'browser_batch_actions',
]);

const BATCH_MAX_ACTIONS = 20;

export function getBrowserToolDefinitions() {
  return ALLOWED_BROWSER_TOOLS.map((name) => {
    // Special-case: explicit schema for browser_batch_actions
    if (name === 'browser_batch_actions') {
      const batchableTtools = (ALLOWED_BROWSER_TOOLS as readonly string[])
        .filter(t => !BATCH_UNSAFE_TOOLS.has(t));

      return {
        name,
        description:
          'Execute multiple browser actions in a single call. Returns results array + final snapshot.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            actions: {
              type: 'array' as const,
              items: {
                type: 'object' as const,
                properties: {
                  tool: {
                    type: 'string' as const,
                    enum: batchableTtools,
                    description:
                      'Browser tool name. Only safe, non-nesting tools are allowed in batches.',
                  },
                  args: {
                    type: 'object' as const,
                    description: 'Tool arguments',
                  },
                },
                required: ['tool', 'args'] as const,
              },
              maxItems: BATCH_MAX_ACTIONS,
              description: 'Array of actions to execute sequentially',
            },
          },
          required: ['actions'] as const,
        },
      };
    }

    // Special-case: explicit schema for browser_snapshot
    if (name === 'browser_snapshot') {
      return {
        name,
        description:
          'Capture accessibility snapshot of the page. Use maxChars/offset for large page pagination.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            selector: { type: 'string' as const, description: 'CSS selector to scope snapshot' },
            interactiveOnly: { type: 'boolean' as const, description: 'Only return interactive elements' },
            maxChars: { type: 'number' as const, minimum: 0, description: 'Max characters to return (0 = no pagination)' },
            offset: { type: 'number' as const, minimum: 0, description: 'Character offset for pagination' },
          },
        },
      };
    }

    // Special-case: explicit schema for browser_snapshot_with_screenshot
    if (name === 'browser_snapshot_with_screenshot') {
      return {
        name,
        description:
          'Capture accessibility snapshot + screenshot in one call. Returns snapshot content and screenshot (base64 PNG string or null on failure). ' +
          'Output fields: screenshot (string|null), screenshotError (string, present when screenshot fails).',
        inputSchema: {
          type: 'object' as const,
          properties: {
            selector: { type: 'string' as const, description: 'CSS selector to scope snapshot' },
            interactiveOnly: { type: 'boolean' as const, description: 'Only return interactive elements' },
          },
        },
      };
    }

    // Special-case: explicit schema for browser_take_screenshot
    if (name === 'browser_take_screenshot') {
      return {
        name,
        description: 'Take a screenshot of the current page or a specific element',
        inputSchema: {
          type: 'object' as const,
          properties: {
            ref: { type: 'string' as const, description: 'Element ref to screenshot (optional, screenshots full page if omitted)' },
            format: { type: 'string' as const, enum: ['jpeg', 'png'], description: 'Image format (default: jpeg)' },
            quality: { type: 'number' as const, minimum: 1, maximum: 100, description: 'JPEG quality 1-100 (default: 80, ignored for PNG)' },
          },
        },
      };
    }

    // Special-case: clarify browser_close description
    if (name === 'browser_close') {
      return {
        name,
        description: 'Close the current browser page (NOT the session — use oneagent_close_session for that)',
        inputSchema: {
          type: 'object' as const,
          properties: {},
        },
      };
    }

    // Default: generic schema for all other browser tools
    return {
      name,
      description: `Playwright browser tool: ${name.replace('browser_', '').replace(/_/g, ' ')}`,
      inputSchema: {
        type: 'object' as const,
        properties: {},
        additionalProperties: true,
      },
    };
  });
}
