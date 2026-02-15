// ─── TypeScript SDK Response Types ──────────────────────────────────

export interface OneAgentClientOptions {
  baseUrl: string;
  apiKey?: string;
}

export interface SiteManifestResponse {
  id: string;
  displayName?: string;
  firstSeen: number;
  lastVisited: number;
  masteryLevel: string;
  recommendedTier: string;
  totalRequests: number;
  successfulRequests: number;
}

export interface SkillSummary {
  id: string;
  name: string;
  status: string;
  siteId: string;
  method: string;
  pathTemplate: string;
  successRate: number;
  currentTier: string;
}

export interface ExecuteSkillResponse {
  success: boolean;
  data?: unknown;
  error?: string;
}

export interface ConfirmationRequired {
  status: 'confirmation_required';
  message: string;
  skillId: string;
  confirmationToken: string;
  expiresAt: number;
  sideEffectClass: string;
  method: string;
  pathTemplate: string;
}

export interface DryRunResponse {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: unknown;
  sideEffectClass: string;
  currentTier: string;
  note: string;
}

export interface ValidateResponse {
  success: boolean;
  errors?: string[];
  warnings?: string[];
}

export interface ExploreResponse {
  siteId: string;
  sources: Array<{
    type: string;
    found: boolean;
    endpointCount: number;
    metadata?: Record<string, unknown>;
  }>;
  endpoints: Array<{
    method: string;
    path: string;
    description?: string;
    source: string;
    trustLevel: number;
  }>;
}

export interface RecordResponse {
  frameId: string;
  name: string;
  siteId: string;
}

export interface StopResponse {
  frameId: string;
  skills: Array<{
    id: string;
    name: string;
    method: string;
    pathTemplate: string;
  }>;
}

export interface HealthResponse {
  status: string;
  uptime: number;
  mode: string;
}

export type OpenApiSpec = Record<string, unknown>;
