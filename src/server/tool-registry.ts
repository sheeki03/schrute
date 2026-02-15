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

export function skillToToolName(skill: SkillSpec): string {
  const action = skill.name
    .replace(/[^a-zA-Z0-9_]/g, '_')
    .replace(/_+/g, '_')
    .toLowerCase();
  const site = skill.siteId
    .replace(/[^a-zA-Z0-9_]/g, '_')
    .replace(/_+/g, '_')
    .toLowerCase();
  return `${site}.${action}.v${skill.version}`;
}

export function skillToToolDefinition(skill: SkillSpec) {
  return {
    name: skillToToolName(skill),
    description: skill.description ?? `${skill.method} ${skill.pathTemplate}`,
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
] as const;

// ─── Browser Tool Proxy Definition ───────────────────────────────

export function getBrowserToolDefinitions() {
  return ALLOWED_BROWSER_TOOLS.map((name) => ({
    name,
    description: `Playwright browser tool: ${name.replace('browser_', '').replace(/_/g, ' ')}`,
    inputSchema: {
      type: 'object' as const,
      properties: {},
      additionalProperties: true,
    },
  }));
}
