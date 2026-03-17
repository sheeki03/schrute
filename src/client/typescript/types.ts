// ─── TypeScript SDK Response Types ──────────────────────────────────

// Literal union types for SDK consumers (mirrors server-side enums without import dependency)
type SkillStatus = 'draft' | 'active' | 'stale' | 'broken';
type ExecutionTier = 'signed_agent' | 'direct' | 'cookie_refresh' | 'browser_proxied' | 'full_browser';
type TierState = 'tier_1' | 'tier_3';
type MasteryLevel = 'explore' | 'partial' | 'full';
type SideEffectClass = 'read-only' | 'idempotent' | 'non-idempotent';
type HealthStatus = 'ok' | 'degraded' | 'error';
type EngineMode = 'idle' | 'exploring' | 'recording' | 'replaying';
type PipelineJobStatus = 'pending' | 'running' | 'completed' | 'failed';

export interface SchruteClientOptions {
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

export interface ExploreReadyResponse {
  status: 'ready';
  sessionId: string;
  siteId: string;
  url: string;
  reused?: boolean;
  appliedOverrides?: {
    proxy?: { server: string };
    geo?: Record<string, unknown>;
  };
  hint: string;
}

export interface ExploreBrowserHandoffRequiredResponse {
  status: 'browser_handoff_required';
  reason: 'cloudflare_challenge';
  recoveryMode: 'real_browser_cdp';
  siteId: string;
  url: string;
  hint: string;
  resumeToken?: string;
  advisoryHint?: string;
}

export type ExploreResponse =
  | ExploreReadyResponse
  | ExploreBrowserHandoffRequiredResponse;

export interface RecoverExploreResponse {
  status: 'ready' | 'awaiting_user' | 'expired' | 'failed';
  siteId: string;
  url: string;
  session?: string;
  managedBrowser?: boolean;
  hint: string;
}

export interface RecordResponse {
  id: string;
  name: string;
  siteId: string;
  startedAt: number;
  requestCount: number;
  inputs?: Record<string, string>;
}

export interface StopResponse {
  id: string;
  name: string;
  siteId: string;
  startedAt: number;
  requestCount: number;
  pipelineJobId?: string;
  skillsGenerated?: number;
  signalRequests?: number;
  noiseRequests?: number;
  dedupedRequests?: number;
  generatedSkills?: Array<{
    id: string;
    method: string;
    pathTemplate: string;
    status: string;
  }>;
}

export interface PipelineJobResult {
  skillsGenerated: number;
  signalCount: number;
  noiseCount: number;
  totalCount: number;
  warning?: string;
}

export interface PipelineJobResponse {
  jobId: string;
  recordingId: string;
  siteId: string;
  status: PipelineJobStatus;
  startedAt: number;
  completedAt?: number;
  error?: string;
  result?: PipelineJobResult;
}

export interface HealthResponse {
  status: HealthStatus;
  uptime: number;
  mode: EngineMode;
}

export type OpenApiSpec = Record<string, unknown>;

export interface SkillSearchResult {
  id: string;
  name: string;
  siteId: string;
  method: string;
  pathTemplate: string;
  description: string;
  inputSchema: Record<string, unknown>;
  status: string;
  successRate: number;
  currentTier: string;
  executable: boolean;
  blockedReason?: string;
  provenance?: 'learned' | 'webmcp' | 'both';
}

export interface SkillSearchResponse {
  results: SkillSearchResult[];
  matchType?: 'fts' | 'like';
  inactiveMatches?: Array<{ id: string; status: string }>;
  inactiveHint?: string;
}

// ─── Compile-time drift guards ──────────────────────────────────
// If a server enum value is added/removed, one of these lines fails to compile.
import type { SkillStatusName, ExecutionTierName, TierStateName, MasteryLevelName, SideEffectClassName } from '../../skill/types.js';
import type { EngineMode as ServerEngineMode } from '../../core/engine.js';

type _Exact<A, B> = [A] extends [B] ? [B] extends [A] ? true : false : false;
type _Assert<T extends true> = T;

// Each line fails to compile if a server enum gains or loses a member.
type _CheckSkillStatus = _Assert<_Exact<SkillStatus, SkillStatusName>>;
type _CheckExecutionTier = _Assert<_Exact<ExecutionTier, ExecutionTierName>>;
type _CheckTierState = _Assert<_Exact<TierState, TierStateName>>;
type _CheckMasteryLevel = _Assert<_Exact<MasteryLevel, MasteryLevelName>>;
type _CheckSideEffectClass = _Assert<_Exact<SideEffectClass, SideEffectClassName>>;
type _CheckEngineMode = _Assert<_Exact<EngineMode, ServerEngineMode>>;
