import type { SkillSpec } from '../skill/types.js';
import { ALLOWED_BROWSER_TOOLS, isParamRequired } from '../skill/types.js';
import { extractPathParams } from '../core/utils.js';

// ─── Tool Shortlist Ranking ──────────────────────────────────────

export function rankToolsByIntent(
  skills: SkillSpec[],
  intent: string | undefined,
  k: number,
  opts?: { preFiltered?: boolean },
): SkillSpec[] {
  if (!intent) {
    return skills.slice(0, k);
  }

  const intentLower = intent.toLowerCase();
  const words = intentLower.split(/\s+/);

  // Detect HTTP method in query for method+path combo bonus
  const HTTP_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options']);
  const queryMethod = words.find(w => HTTP_METHODS.has(w));
  const queryPathWords = words.filter(w => !HTTP_METHODS.has(w));

  const scored = skills.map((skill) => {
    let relevance = 0; // lexical matches only
    let quality = 0;   // non-textual boosts (tie-breakers)
    const nameLower = (skill.name ?? '').toLowerCase();
    const descLower = (skill.description ?? '').toLowerCase();
    const idLower = skill.id.toLowerCase();
    const pathLower = (skill.pathTemplate ?? '').toLowerCase();
    const siteIdLower = (skill.siteId ?? '').toLowerCase();
    const methodLower = (skill.method ?? '').toLowerCase();
    const pathSegments = pathLower.split('/').filter(Boolean);

    for (const word of words) {
      if (nameLower.includes(word)) relevance += 3;
      if (descLower.includes(word)) relevance += 2;
      if (idLower.includes(word)) relevance += 1;
      if (pathLower.includes(word)) relevance += 3;
      if (siteIdLower.includes(word)) relevance += 1;
      // Exact method match gets +2, substring match gets +1
      if (methodLower === word) {
        relevance += 2;
      } else if (methodLower.includes(word)) {
        relevance += 1;
      }
      // Whole-path-segment bonus
      if (pathSegments.includes(word)) relevance += 2;
    }

    // Method+path combo bonus: if query has e.g. "GET users", boost skills matching both
    if (queryMethod && queryPathWords.length > 0 && methodLower === queryMethod) {
      const pathMatch = queryPathWords.some(pw => pathSegments.includes(pw));
      if (pathMatch) relevance += 3;
    }

    // Boost by success rate and recency
    quality += skill.successRate * 2;
    if (skill.lastUsed) {
      const ageHours = (Date.now() - skill.lastUsed) / (1000 * 60 * 60);
      if (ageHours < 24) quality += 1;
    }

    // Boost direct-proven skills
    if (skill.currentTier === 'tier_1') quality += 1;
    // Boost lower latency
    const avgLatencyMs = 'avgLatencyMs' in skill ? (skill as unknown as Record<string, unknown>).avgLatencyMs : undefined;
    if (typeof avgLatencyMs === 'number' && avgLatencyMs < 500) quality += 1;

    return { skill, relevance, quality, score: relevance + quality };
  });

  // When intent is provided and skills are NOT pre-filtered (e.g., by FTS),
  // require at least one lexical match. Pre-filtered skills (from FTS with
  // porter stemming) are already relevance-validated.
  const candidates = opts?.preFiltered ? scored : scored.filter(s => s.relevance > 0);
  candidates.sort((a, b) => b.score - a.score);
  return candidates.slice(0, k).map((s) => s.skill);
}

// ─── Parameter Key Sanitization ─────────────────────────────────

export const PARAM_KEY_PATTERN = /^[a-zA-Z0-9_.-]{1,64}$/;

/**
 * Sanitize a parameter name to match the API requirement: ^[a-zA-Z0-9_.-]{1,64}$
 * Replaces invalid characters (colons, brackets, spaces, etc.) with underscores.
 */
export function sanitizeParamKey(name: string): string {
  if (PARAM_KEY_PATTERN.test(name)) return name;
  const sanitized = name
    .replace(/[^a-zA-Z0-9_.-]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^[_.-]+/, '')
    .replace(/[_.-]+$/, '');
  // Truncate to 64 chars
  const truncated = sanitized.slice(0, 64);
  return truncated || 'param';
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
    .filter(isParamRequired)
    .map(p => p.name);
  if (userInputParams.length > 0) {
    parts.push(`Inputs: ${userInputParams.join(', ')}`);
  }

  return parts.join(' — ');
}

export function skillToToolDefinition(skill: SkillSpec, options?: { maxDescriptionLength?: number }) {
  // Include path template parameters (e.g. {id}) in inputSchema
  const pathParams = extractPathParams(skill.pathTemplate);
  const pathParamEntries: [string, { type: string; description: string }][] =
    pathParams.map((pp) => [pp, { type: 'string', description: 'Path parameter' }]);

  const skillParamEntries: [string, { type: string; description: string }][] =
    skill.parameters.map((p) => [
      sanitizeParamKey(p.name),
      { type: p.type, description: `Source: ${p.source}` },
    ]);

  // Path params first, then skill params (skill params win on collision)
  const properties = Object.fromEntries([...pathParamEntries, ...skillParamEntries]);

  const requiredFromPath = pathParams;
  const requiredFromSkill = skill.parameters
    .filter(isParamRequired)
    .map((p) => sanitizeParamKey(p.name));
  const required = [...new Set([...requiredFromPath, ...requiredFromSkill])];

  let description = skill.description ?? buildAutoDescription(skill);
  const maxLen = options?.maxDescriptionLength;
  if (maxLen !== undefined && description.length > maxLen) {
    description = description.slice(0, maxLen) + '...';
  }

  return {
    name: skillToToolName(skill),
    description,
    inputSchema: {
      type: 'object' as const,
      properties,
      required,
    },
  };
}

// ─── Meta Tool Definitions ──────────────────────────────────────

export const META_TOOLS = [
  {
    name: 'schrute_explore',
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
            userAgent: { type: 'string', description: 'Custom User-Agent string' },
            viewport: {
              type: 'object',
              description: 'Browser viewport dimensions',
              properties: {
                width: { type: 'number' },
                height: { type: 'number' },
              },
            },
          },
        },
      },
      required: ['url'],
    },
  },
  {
    name: 'schrute_record',
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
    name: 'schrute_stop',
    description: 'Stop recording and return a pipeline job ID for background processing',
    inputSchema: {
      type: 'object' as const,
      properties: {},
    },
  },
  {
    name: 'schrute_pipeline_status',
    description: 'Get the status of a background recording pipeline job',
    inputSchema: {
      type: 'object' as const,
      properties: {
        jobId: { type: 'string', description: 'Pipeline job ID returned by schrute_stop' },
      },
      required: ['jobId'],
    },
  },
  {
    name: 'schrute_sites',
    description: 'List all known sites',
    inputSchema: {
      type: 'object' as const,
      properties: {},
    },
  },
  {
    name: 'schrute_skills',
    description: 'List skills, optionally filtered by site',
    inputSchema: {
      type: 'object' as const,
      properties: {
        siteId: { type: 'string', description: 'Filter by site ID' },
      },
    },
  },
  {
    name: 'schrute_status',
    description: 'Get current session and engine status',
    inputSchema: {
      type: 'object' as const,
      properties: {},
    },
  },
  {
    name: 'schrute_dry_run',
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
    name: 'schrute_set_transform',
    description: 'Set or clear an output transform for a skill',
    inputSchema: {
      type: 'object' as const,
      properties: {
        skillId: { type: 'string', description: 'Skill ID to update' },
        transform: {
          type: 'object',
          description: 'Output transform definition',
          additionalProperties: true,
        },
        responseContentType: {
          type: 'string',
          description: 'Optional response content type override, e.g. text/html',
        },
        clear: {
          type: 'boolean',
          description: 'Clear the current transform',
        },
      },
      required: ['skillId'],
    },
  },
  {
    name: 'schrute_export_skill',
    description: 'Export a skill as standalone curl, fetch, Python, or Playwright code',
    inputSchema: {
      type: 'object' as const,
      properties: {
        skillId: { type: 'string', description: 'Skill ID to export' },
        format: {
          type: 'string',
          enum: ['curl', 'fetch.ts', 'requests.py', 'playwright.ts'],
          description: 'Output format',
        },
        params: {
          type: 'object',
          description: 'Optional params used to resolve the request URL, headers, and body',
          additionalProperties: true,
        },
      },
      required: ['skillId', 'format'],
    },
  },
  {
    name: 'schrute_create_workflow',
    description: 'Create a read-only linear workflow skill from existing active GET/HEAD skills',
    inputSchema: {
      type: 'object' as const,
      properties: {
        siteId: { type: 'string', description: 'Site ID that owns the workflow' },
        name: { type: 'string', description: 'Workflow name' },
        description: { type: 'string', description: 'Optional workflow description' },
        workflowSpec: {
          type: 'object',
          description: 'Workflow specification with ordered steps',
          additionalProperties: true,
        },
        outputTransform: {
          type: 'object',
          description: 'Optional transform applied to the final workflow output',
          additionalProperties: true,
        },
      },
      required: ['siteId', 'name', 'workflowSpec'],
    },
  },
  {
    name: 'schrute_confirm',
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
    name: 'schrute_connect_cdp',
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
        tabUrl: { type: 'string', description: 'URL prefix to select a specific tab after connecting' },
        tabTitle: { type: 'string', description: 'Title substring to select a specific tab after connecting' },
      },
      required: ['name'],
    },
  },
  {
    name: 'schrute_recover_explore',
    description: 'Recover an explore session blocked by Cloudflare by handing off to a real local Chrome session',
    inputSchema: {
      type: 'object' as const,
      properties: {
        resumeToken: { type: 'string', description: 'Recovery token returned by schrute_explore when browser handoff is required' },
        waitMs: { type: 'number', description: 'How long to wait for the user to clear the challenge before returning (default 90000, max 300000)' },
      },
      required: ['resumeToken'],
    },
  },
  {
    name: 'schrute_sessions',
    description: 'List all named browser sessions',
    inputSchema: {
      type: 'object' as const,
      properties: {},
    },
  },
  {
    name: 'schrute_close_session',
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
    name: 'schrute_switch_session',
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
    name: 'schrute_import_cookies',
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
    name: 'schrute_execute',
    description: 'Execute any skill by ID (cross-site)',
    inputSchema: {
      type: 'object' as const,
      properties: {
        skillId: { type: 'string', description: 'Skill ID to execute' },
        params: { type: 'object', description: 'Parameters for the skill', additionalProperties: true },
        testMode: { type: 'boolean', description: 'Execute without recording metrics (success rate unaffected)' },
      },
      required: ['skillId'],
    },
  },
  {
    name: 'schrute_activate',
    description: 'Manually activate a DRAFT or BROKEN skill (first execution still requires confirmation)',
    inputSchema: {
      type: 'object' as const,
      properties: {
        skillId: { type: 'string', description: 'Skill ID to activate' },
      },
      required: ['skillId'],
    },
  },
  {
    name: 'schrute_doctor',
    description: 'Run diagnostic checks on browser engine, config, database, etc.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        full: { type: 'boolean', description: 'Run full diagnostic checks (admin only — tests browser, keychain, TLS, WAL)' },
      },
    },
  },
  {
    name: 'schrute_export_cookies',
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
    name: 'schrute_webmcp_call',
    description: 'Call a WebMCP tool discovered on the current site. Use schrute_status to see available tools.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        toolName: { type: 'string', description: 'Name of the WebMCP tool to call' },
        args: { type: 'object', description: 'Arguments to pass to the tool', default: {} },
        refresh: { type: 'boolean', description: 'Re-scan the page for WebMCP tools before calling' },
      },
      required: ['toolName'],
    },
  },
  {
    name: 'schrute_search_skills',
    description: 'Search learned skills by keyword. Returns matching skill IDs, input guidance, and metadata. Use with schrute_execute to run a skill by ID.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Search keywords (matches skill name, description, and ID)' },
        limit: { type: 'number', description: 'Max results (default: 10)' },
        siteId: { type: 'string', description: 'Filter to a specific site' },
        includeInactive: { type: 'boolean', description: 'Include inactive (broken/draft/stale) skills in search results' },
      },
    },
  },
  {
    name: 'schrute_revoke',
    description: 'Revoke permanent approval for a skill (next execution will require confirmation again)',
    inputSchema: {
      type: 'object' as const,
      properties: {
        skillId: { type: 'string', description: 'Skill ID to revoke approval for' },
      },
      required: ['skillId'],
    },
  },
  {
    name: 'schrute_amendments',
    description: 'List amendments for a skill',
    inputSchema: {
      type: 'object' as const,
      properties: {
        skillId: { type: 'string', description: 'Skill ID to get amendments for' },
      },
      required: ['skillId'],
    },
  },
  {
    name: 'schrute_optimize',
    description: 'Run GEPA offline optimization on a broken or degraded skill',
    inputSchema: {
      type: 'object' as const,
      properties: {
        skillId: { type: 'string', description: 'Skill ID to optimize' },
      },
      required: ['skillId'],
    },
  },
  {
    name: 'schrute_delete_skill',
    description: 'Permanently delete a skill and its amendments/exemplars (admin only)',
    inputSchema: {
      type: 'object' as const,
      properties: {
        skillId: { type: 'string', description: 'Skill ID to delete' },
      },
      required: ['skillId'],
    },
  },
  {
    name: 'schrute_list_tabs',
    description: 'List open tabs in a CDP-connected browser session',
    inputSchema: {
      type: 'object' as const,
      properties: {
        session: { type: 'string', description: 'Session name (default: active session)' },
      },
    },
  },
  {
    name: 'schrute_select_tab',
    description: 'Switch to a specific tab by URL or title in a CDP session',
    inputSchema: {
      type: 'object' as const,
      properties: {
        session: { type: 'string', description: 'Session name' },
        tabUrl: { type: 'string', description: 'URL prefix to match' },
        tabTitle: { type: 'string', description: 'Title substring to match' },
      },
    },
  },
  {
    name: 'schrute_capture_recent',
    description: 'Capture recent network activity and generate skills from it. Requires a CDP-connected session (schrute_connect_cdp). Does not work with schrute_explore sessions.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        minutes: { type: 'number', description: 'How many minutes of history to capture (default: 5, max: 10)' },
        name: { type: 'string', description: 'Name for the generated action frame' },
      },
      required: ['name'],
    },
  },
  {
    name: 'schrute_performance_trace',
    description: 'Start/stop performance trace on the current browser session',
    inputSchema: {
      type: 'object' as const,
      properties: {
        action: { type: 'string', enum: ['start', 'stop'], description: 'Start or stop tracing' },
      },
      required: ['action'],
    },
  },
  {
    name: 'schrute_test_webmcp',
    description: 'Test a WebMCP tool with sample inputs and validate the response',
    inputSchema: {
      type: 'object' as const,
      properties: {
        toolName: { type: 'string' },
        testArgs: { type: 'object' },
      },
      required: ['toolName'],
    },
  },
  {
    name: 'schrute_batch_execute',
    description: 'Execute multiple skill calls in sequence with batch confirmation',
    inputSchema: {
      type: 'object' as const,
      properties: {
        actions: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              skillId: { type: 'string' },
              params: { type: 'object' },
            },
            required: ['skillId'],
          },
          maxItems: 50,
        },
      },
      required: ['actions'],
    },
  },
  {
    name: 'schrute_webmcp_directory',
    description: 'Search the local WebMCP tool directory across all known sites',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Search by tool name or description' },
      },
    },
  },
  {
    name: 'schrute_api_coverage',
    description: 'Run discovery on a URL and report API surface coverage against learned skills',
    inputSchema: {
      type: 'object' as const,
      properties: {
        url: { type: 'string', description: 'URL to discover and compute coverage for' },
      },
      required: ['url'],
    },
  },
  {
    name: 'schrute_workflow_suggestions',
    description: 'List pending workflow suggestions for a site',
    inputSchema: {
      type: 'object' as const,
      properties: {
        siteId: { type: 'string', description: 'Site ID to list suggestions for' },
      },
      required: ['siteId'],
    },
  },
  {
    name: 'schrute_accept_suggestion',
    description: 'Accept a workflow suggestion and create the workflow skill',
    inputSchema: {
      type: 'object' as const,
      properties: {
        suggestionId: { type: 'string', description: 'Suggestion ID to accept' },
      },
      required: ['suggestionId'],
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
        description: 'Close the current browser page (NOT the session — use schrute_close_session for that)',
        inputSchema: {
          type: 'object' as const,
          properties: {},
        },
      };
    }

    // Special-case: explicit schema for browser_fill_form
    if (name === 'browser_fill_form') {
      return {
        name,
        description: 'Fill multiple form fields at once. Keys are field labels, input name attributes, or @e refs from browser_snapshot.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            values: {
              type: 'object' as const,
              description: 'Map of field identifiers to values. Keys: label text, input name, or @eN ref.',
              additionalProperties: { type: 'string' as const },
            },
          },
          required: ['values'] as const,
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
