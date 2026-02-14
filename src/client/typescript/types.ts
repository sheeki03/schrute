// ─── TypeScript SDK Response Types ──────────────────────────────────

// Literal union types for SDK consumers (mirrors server-side enums without import dependency)
type SkillStatus = 'draft' | 'active' | 'stale' | 'broken';
type ExecutionTier = 'signed_agent' | 'direct' | 'cookie_refresh' | 'browser_proxied' | 'full_browser';
type TierState = 'tier_1' | 'tier_3';
type MasteryLevel = 'explore' | 'partial' | 'full';
type SideEffectClass = 'read-only' | 'idempotent' | 'non-idempotent';
type HealthStatus = 'ok' | 'degraded' | 'error';
type EngineMode = 'idle' | 'exploring' | 'recording' | 'replaying';

export interface OneAgentClientOptions {
  baseUrl: string;
  apiKey?: string;
}

export interface SiteManifestResponse {
  id: string;
  displayName?: string;
  firstSeen: number;
  lastVisited: number;
  masteryLevel: MasteryLevel;
  recommendedTier: ExecutionTier;
  totalRequests: number;
  successfulRequests: number;
}

export interface SkillSummary {
  id: string;
  name: string;
  status: SkillStatus;
  siteId: string;
  method: string;
  pathTemplate: string;
  successRate: number;
  currentTier: TierState;
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
  sideEffectClass: SideEffectClass;
  method: string;
  pathTemplate: string;
}

export interface DryRunResponse {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: unknown;
  sideEffectClass: SideEffectClass;
  currentTier: TierState;
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
  status: HealthStatus;
  uptime: number;
  mode: EngineMode;
}

export type OpenApiSpec = Record<string, unknown>;
