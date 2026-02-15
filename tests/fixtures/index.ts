import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SkillSpec } from '../../src/skill/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── HAR File Loaders ────────────────────────────────────────────────
const harDir = join(__dirname, 'har-files');

export function loadHar(name: string): { log: { version: string; creator: { name: string; version: string }; entries: unknown[] } } {
  return JSON.parse(readFileSync(join(harDir, name), 'utf8'));
}

export const harFiles = {
  simpleRestApi: () => loadHar('simple-rest-api.har'),
  graphqlApi: () => loadHar('graphql-api.har'),
  authFlow: () => loadHar('auth-flow.har'),
  noisySession: () => loadHar('noisy-session.har'),
} as const;

// ─── Skill Fixture Loaders ───────────────────────────────────────────
const skillDir = join(__dirname, 'generated-skills');

export function loadSkill(name: string): SkillSpec {
  return JSON.parse(readFileSync(join(skillDir, name), 'utf8'));
}

export const skillFixtures = {
  getUsersSkill: () => loadSkill('get-users-skill.json'),
  createUserSkill: () => loadSkill('create-user-skill.json'),
  graphqlSkill: () => loadSkill('graphql-skill.json'),
  staleSkill: () => loadSkill('stale-skill.json'),
} as const;

// ─── Mock Server Re-exports ─────────────────────────────────────────
export { createRestMockServer } from './mock-sites/rest-mock-server.js';
export { createGraphQLMockServer } from './mock-sites/graphql-mock-server.js';
export { createAuthMockServer } from './mock-sites/auth-mock-server.js';
