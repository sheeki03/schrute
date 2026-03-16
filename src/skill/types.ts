import { z } from 'zod';

// ─── Capability Enum ───────────────────────────────────────────────
export const Capability = {
  NET_FETCH_DIRECT: 'net.fetch.direct',
  NET_FETCH_BROWSER_PROXIED: 'net.fetch.browserProxied',
  BROWSER_AUTOMATION: 'browser.automation',
  BROWSER_MODEL_CONTEXT: 'browser.modelContext',
  STORAGE_WRITE: 'storage.write',
  EXPORT_SKILLS: 'export.skills',
  SECRETS_USE: 'secrets.use',
} as const;

export type CapabilityName = (typeof Capability)[keyof typeof Capability];

export const V01_DEFAULT_CAPABILITIES: CapabilityName[] = [
  Capability.NET_FETCH_DIRECT,
  Capability.NET_FETCH_BROWSER_PROXIED,
  Capability.BROWSER_AUTOMATION,
  Capability.STORAGE_WRITE,
  Capability.SECRETS_USE,
];

export const DISABLED_BY_DEFAULT_CAPABILITIES: CapabilityName[] = [
  Capability.EXPORT_SKILLS,
];

// ─── Failure Taxonomy ──────────────────────────────────────────────
// Evaluated in STRICT PRECEDENCE ORDER — first match wins, disjoint
export const FailureCause = {
  RATE_LIMITED: 'rate_limited',
  BUDGET_DENIED: 'budget_denied',
  ENDPOINT_REMOVED: 'endpoint_removed',
  POLICY_DENIED: 'policy_denied',
  JS_COMPUTED_FIELD: 'js_computed_field',
  PROTOCOL_SENSITIVITY: 'protocol_sensitivity',
  SIGNED_PAYLOAD: 'signed_payload',
  SCHEMA_DRIFT: 'schema_drift',
  AUTH_EXPIRED: 'auth_expired',
  COOKIE_REFRESH: 'cookie_refresh',
  FETCH_ERROR: 'fetch_error',
  UNKNOWN: 'unknown',
} as const;

export type FailureCauseName = (typeof FailureCause)[keyof typeof FailureCause];

const FAILURE_CAUSE_PRECEDENCE: FailureCauseName[] = [
  FailureCause.RATE_LIMITED,
  FailureCause.BUDGET_DENIED,
  FailureCause.ENDPOINT_REMOVED,
  FailureCause.POLICY_DENIED,
  FailureCause.JS_COMPUTED_FIELD,
  FailureCause.PROTOCOL_SENSITIVITY,
  FailureCause.SIGNED_PAYLOAD,
  FailureCause.SCHEMA_DRIFT,
  FailureCause.AUTH_EXPIRED,
  FailureCause.COOKIE_REFRESH,
  FailureCause.FETCH_ERROR,
  FailureCause.UNKNOWN,
];

export const INFRA_FAILURE_CAUSES = new Set<FailureCauseName>([
  FailureCause.POLICY_DENIED,
  FailureCause.RATE_LIMITED,
  FailureCause.BUDGET_DENIED,
  FailureCause.FETCH_ERROR,
]);

// ─── Tier States ───────────────────────────────────────────────────
export const TierState = {
  TIER_3_DEFAULT: 'tier_3',
  TIER_1_PROMOTED: 'tier_1',
} as const;

export type TierStateName = (typeof TierState)[keyof typeof TierState];

export interface PermanentTierLock {
  type: 'permanent';
  reason: 'js_computed_field' | 'protocol_sensitivity' | 'signed_payload' | 'webmcp_requires_browser';
  evidence: string;
}

export interface TemporaryDemotion {
  type: 'temporary_demotion';
  since: string;
  demotions: number;
}

export type TierLock = PermanentTierLock | TemporaryDemotion | null;

// ─── Skill Lifecycle ───────────────────────────────────────────────
export const SkillStatus = {
  DRAFT: 'draft',
  ACTIVE: 'active',
  STALE: 'stale',
  BROKEN: 'broken',
} as const;

export type SkillStatusName = (typeof SkillStatus)[keyof typeof SkillStatus];

// ─── Confirmation States ───────────────────────────────────────────
const ConfirmationStatus = {
  PENDING: 'pending',
  APPROVED: 'approved',
  DENIED: 'denied',
} as const;

type ConfirmationStatusName = (typeof ConfirmationStatus)[keyof typeof ConfirmationStatus];

// ─── Side Effect Classification ────────────────────────────────────
export const SideEffectClass = {
  READ_ONLY: 'read-only',
  IDEMPOTENT: 'idempotent',
  NON_IDEMPOTENT: 'non-idempotent',
} as const;

export type SideEffectClassName = (typeof SideEffectClass)[keyof typeof SideEffectClass];

// ─── Mastery Level ─────────────────────────────────────────────────
export const MasteryLevel = {
  EXPLORE: 'explore',
  PARTIAL: 'partial',
  FULL: 'full',
} as const;

export type MasteryLevelName = (typeof MasteryLevel)[keyof typeof MasteryLevel];

// ─── Execution Tier ────────────────────────────────────────────────
export const ExecutionTier = {
  SIGNED_AGENT: 'signed_agent',   // Tier 0
  DIRECT: 'direct',               // Tier 1 (1-50ms)
  COOKIE_REFRESH: 'cookie_refresh', // Tier 2 (5-100ms)
  BROWSER_PROXIED: 'browser_proxied', // Tier 3 (100-500ms)
  FULL_BROWSER: 'full_browser',    // Tier 4 (1-10s)
} as const;

export type ExecutionTierName = (typeof ExecutionTier)[keyof typeof ExecutionTier];

// ─── Request Classification ────────────────────────────────────────
export const RequestClassification = {
  NOISE: 'noise',
  SIGNAL: 'signal',
  AMBIGUOUS: 'ambiguous',
} as const;

export type RequestClassificationName = (typeof RequestClassification)[keyof typeof RequestClassification];

// ─── Sealed Fetch (no raw JS execution) ────────────────────────────
export interface SealedFetchRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

export interface SealedFetchResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

// ─── Sealed WebMCP (Phase 5, feature-flagged) ──────────────────────
export interface SealedModelContextRequest {
  toolName: string;
  args: Record<string, unknown>;
}

export interface SealedModelContextResponse {
  result: unknown;
  error?: string;
  hasStructuredResponse?: boolean;
}

// ─── Browser Provider Interface ────────────────────────────────────
// ─── Snapshot Events ──────────────────────────────────────────────
export type SnapshotEvent =
  | { type: 'console'; level: 'error' | 'warning' | 'info' | 'debug'; text: string }
  | { type: 'download'; filename: string; finished: boolean };

export interface PageSnapshot {
  url: string;
  title: string;
  content: string; // accessibility tree or DOM
  version?: number;
  interactiveCount?: number;
  incremental?: boolean;
  mode?: 'annotated' | 'full' | 'none';
  recentEvents?: SnapshotEvent[];
  screenshot?: string | null; // base64 PNG or JPEG, null when screenshot fails but snapshot succeeds
  screenshotMimeType?: string; // 'image/jpeg' or 'image/png'
  screenshotError?: string; // error message when screenshot fails
  pagination?: { totalChars: number; offset: number; hasMore: boolean };
}

export interface NetworkEntry {
  url: string;
  method: string;
  status: number;
  requestHeaders: Record<string, string>;
  responseHeaders: Record<string, string>;
  requestBody?: string;
  responseBody?: string;
  resourceType?: string;
  timing: {
    startTime: number;
    endTime: number;
    duration: number;
  };
}

export interface BrowserProvider {
  navigate(url: string): Promise<void>;
  snapshot(): Promise<PageSnapshot>;
  click(ref: string): Promise<void>;
  type(ref: string, text: string): Promise<void>;
  evaluateFetch(req: SealedFetchRequest): Promise<SealedFetchResponse>;
  screenshot(): Promise<Buffer>;
  networkRequests(): Promise<NetworkEntry[]>;
  evaluateModelContext?(req: SealedModelContextRequest): Promise<SealedModelContextResponse>;
  listModelContextTools?(): Promise<SealedModelContextResponse>;
  getCurrentUrl(): string;
}

// ─── Allowed Playwright MCP Tools (strict allowlist) ───────────────
export const ALLOWED_BROWSER_TOOLS = [
  'browser_navigate',
  'browser_navigate_back',
  'browser_snapshot',
  'browser_click',
  'browser_hover',
  'browser_drag',
  'browser_type',
  'browser_press_key',
  'browser_select_option',
  'browser_fill_form',
  'browser_file_upload',
  'browser_handle_dialog',
  'browser_tabs',
  'browser_take_screenshot',
  'browser_wait_for',
  'browser_close',
  'browser_resize',
  'browser_console_messages',
  'browser_network_requests',
  'browser_batch_actions',
  'browser_snapshot_with_screenshot',
  'browser_debug_trace',
  'browser_load_all',
] as const;

export const BLOCKED_BROWSER_TOOLS = [
  'browser_evaluate',
  'browser_run_code',
  'browser_install',
] as const;

// ─── Header Controls ───────────────────────────────────────────────
export const TIER1_ALLOWED_HEADERS = [
  'user-agent',
  'accept',
  'accept-language',
  'accept-encoding',
  'content-type',
  'authorization', // only if allowlisted domain
  'cookie',        // only if allowlisted domain
] as const;

export const BLOCKED_HOP_BY_HOP_HEADERS = [
  'host',
  'connection',
  'transfer-encoding',
  'upgrade',
  'proxy-authorization',
  'proxy-connection',
  'proxy-authenticate',
  'te',
  'trailer',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
  'x-real-ip',
  'via',
  'keep-alive',
] as const;

// ─── Field Volatility ──────────────────────────────────────────────
export type FieldLocation = 'header' | 'query' | 'body' | 'graphql_variable';

export interface FieldVolatility {
  fieldPath: string;
  fieldLocation: FieldLocation;
  entropy: number;
  changeRate: number;
  looksLikeNonce: boolean;
  looksLikeToken: boolean;
  isStatic: boolean;
}

// ─── Parameter Evidence ────────────────────────────────────────────
export type ParameterClassification = 'parameter' | 'ephemeral' | 'constant';

export interface ParameterEvidence {
  fieldPath: string;
  classification: ParameterClassification;
  observedValues: string[]; // redacted per PII rules
  correlatesWithInput: boolean;
  volatility: number;
}

// ─── Request Chain ─────────────────────────────────────────────────
export interface ChainStepExtraction {
  responsePath: string;
  injectsInto: {
    location: 'header' | 'query' | 'body';
    path: string;
  };
}

export interface ChainStep {
  skillRef: string;
  extractsFrom: ChainStepExtraction[];
}

export interface RequestChain {
  steps: ChainStep[];
  canReplayWithCookiesOnly: boolean;
}

// ─── Auth Recipe ───────────────────────────────────────────────────
export type AuthType = 'bearer' | 'cookie' | 'api_key' | 'oauth2';
export type RefreshTrigger = '401' | '403' | 'redirect_to_login' | 'token_expired_field';
type RefreshMethod = 'browser_relogin' | 'oauth_refresh' | 'manual_user_login';

export interface AuthRecipe {
  type: AuthType;
  injection: {
    location: 'header' | 'cookie' | 'query';
    key: string;
    prefix?: string;
  };
  refreshTriggers: RefreshTrigger[];
  refreshMethod: RefreshMethod;
  refreshFlow?: {
    url: string;
    method: string;
    bodyTemplate: Record<string, string>;
  };
  tokenTtlSeconds?: number;
}

// ─── Skill Spec ────────────────────────────────────────────────────
// Flat interface by design — factory construction and Zod validation are applied at creation boundaries, not enforced by the type itself

export interface SkillParameter {
  name: string;
  type: string;
  source: 'user_input' | 'extracted' | 'constant';
  evidence: string[];
  required?: boolean;
}

export function isParamRequired(p: SkillParameter): boolean {
  if (p.required !== undefined) return p.required;
  return p.source === 'user_input';
}

export interface SkillValidation {
  semanticChecks: string[];
  customInvariants: string[];
}

export interface SkillRedactionInfo {
  piiClassesFound: string[];
  fieldsRedacted: number;
}

export type ReplayStrategy = 'prefer_tier_1' | 'prefer_tier_3' | 'tier_3_only';

export interface SkillSpec {
  id: string;                      // site.action.vN
  version: number;
  status: SkillStatusName;
  currentTier: TierStateName;
  tierLock: TierLock;
  allowedDomains: string[];
  requiredCapabilities: CapabilityName[];
  parameters: SkillParameter[];
  validation: SkillValidation;
  redaction: SkillRedactionInfo;
  replayStrategy: ReplayStrategy;
  sideEffectClass: SideEffectClassName;
  sampleCount: number;
  consecutiveValidations: number;
  // Typed as number without range constraint — TypeScript lacks built-in ranged numeric types. Values constrained to [0,1] at creation/update boundaries.
  confidence: number;

  // HTTP details
  method: string;
  pathTemplate: string;
  inputSchema: Record<string, unknown>;  // JSON Schema
  outputSchema?: Record<string, unknown>;
  authType?: AuthType;
  requiredHeaders?: Record<string, string>;
  dynamicHeaders?: Record<string, string>;
  isComposite: boolean;
  chainSpec?: RequestChain;
  parameterEvidence?: ParameterEvidence[];

  // Metadata
  siteId: string;
  name: string;
  description?: string;
  skillMd?: string;
  openApiFragment?: string;
  lastVerified?: number;
  lastUsed?: number;
  // Typed as number without range constraint — TypeScript lacks built-in ranged numeric types. Values constrained to [0,1] at creation/update boundaries.
  successRate: number;
  avgLatencyMs?: number;
  lastSuccessfulTier?: string;

  // Canary probe fields (WS-4)
  directCanaryEligible?: boolean;
  directCanaryAttempts?: number;
  validationsSinceLastCanary?: number;
  lastCanaryErrorType?: string;

  reviewRequired?: boolean;

  createdAt: number;
  updatedAt: number;
}

// ─── Site Manifest ─────────────────────────────────────────────────
export interface SiteManifest {
  id: string;
  displayName?: string;
  firstSeen: number;
  lastVisited: number;
  masteryLevel: MasteryLevelName;
  recommendedTier: ExecutionTierName;
  totalRequests: number;
  successfulRequests: number;
  lighthouseScore?: number;
  lighthouseAccessibility?: number;
  defaultOverrides?: { proxy?: { server: string }; geo?: GeoEmulationConfig };
}

// ─── HTTP Methods ───────────────────────────────────────────────────
export type HttpMethod = 'GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'OPTIONS';

// ─── Policy ────────────────────────────────────────────────────────
export interface SitePolicy {
  siteId: string;
  allowedMethods: HttpMethod[];
  maxQps: number;
  maxConcurrent: number;
  readOnlyDefault: boolean;
  requireConfirmation: string[];
  domainAllowlist: string[];
  redactionRules: string[];
  capabilities: CapabilityName[];
  executionBackend?: 'playwright' | 'agent-browser' | 'live-chrome';  // override global default for this site
  executionSessionName?: string;                       // for hard-site shared Playwright
}

// ─── Tool Budget ───────────────────────────────────────────────────
export interface ToolBudgetConfig {
  maxToolCallsPerTask: number;      // default 50
  maxConcurrentCalls: number;       // default 3 (global cap)
  crossDomainCalls: boolean;        // default false (denied)
  secretsToNonAllowlisted: false;   // hard deny, never overridable
}

export interface ParamLimits {
  maxStringLength: number;    // default 10_000
  maxDepth: number;           // default 5
  maxProperties: number;      // default 50
}

export interface PayloadLimits {
  maxResponseBodyBytes: number;     // default 10MB
  maxRequestBodyBytes: number;      // default 5MB
  replayTimeoutMs: {
    tier1: number;                  // 30000
    tier3: number;                  // 60000
    tier4: number;                  // 120000
  };
  harCaptureMaxBodyBytes: number;   // 50MB
  redactorTimeoutMs: number;        // 10000
}

// ─── Audit Entry ───────────────────────────────────────────────────
// PolicyDecision and AuditEntry types are derived from Zod schemas
// via z.infer (see Zod Schemas section below) to prevent drift.

// ─── Action Frame ──────────────────────────────────────────────────
export interface ActionFrame {
  id: string;
  siteId: string;
  name: string;
  redactedArtifactId?: string;
  qualityScore?: number;
  startedAt: number;
  endedAt?: number;
  requestCount: number;
  signalCount: number;
  skillCount: number;
}

interface ActionFrameEntry {
  id?: number;
  frameId: string;
  requestHash: string;
  classification: RequestClassificationName;
  noiseReason?: string;
  clusterId?: string;
  redactionApplied: boolean;
}

// ─── Confirmation Token ────────────────────────────────────────────
export interface ConfirmationToken {
  nonce: string;
  skillId: string;
  paramsHash: string;
  tier: string;
  createdAt: number;
  expiresAt: number;
  consumed: boolean;
  consumedAt?: number;
}

// ─── Evidence Report ───────────────────────────────────────────────
export interface EvidenceReport {
  skillId: string;
  tierEligibility: {
    currentTier: TierStateName;
    tierLock: TierLock;
    volatilityScores: FieldVolatility[];
  };
  parameterEvidence: ParameterEvidence[];
  requestChain?: RequestChain;
  policyRule: string;
  redactionsApplied: {
    piiClassesFound: string[];
    fieldsRedacted: number;
  };
  /** Per-PII-type redaction counts aggregated from skill redaction metadata */
  piiRedactionCounts: Record<string, number>;
  validationHistory: {
    timestamp: number;
    success: boolean;
    semanticCheckDetails: string;
  }[];
  connectPolicyDecision?: {
    resolvedIp: string;
    ipCategory: string;
    allowlistMatch: boolean;
    pinStatus: string;
  };
}

// ─── Browser Engine ──────────────────────────────────────────────
export type BrowserEngine = 'playwright' | 'patchright' | 'camoufox';

// ─── Browser Feature Flags (config shape) ─────────────────────────
interface BrowserFeatureFlagsConfig {
  snapshotMode?: 'annotated' | 'full' | 'none';
  incrementalDiffs?: boolean;
  modalTracking?: boolean;
  screenshotResize?: boolean;
  batchActions?: boolean;
  screenshotFormat?: 'jpeg' | 'png';
  screenshotQuality?: number;
  fingerprintProfile?: boolean;
  referrerSpoofing?: boolean;
  humanCursor?: boolean;
  assetBlocking?: boolean;
}

// ─── Proxy & Geo Emulation ──────────────────────────────────────────
export interface ProxyConfig {
  server: string;
  bypass?: string;
  username?: string;
  password?: string;
}

export interface GeoEmulationConfig {
  geolocation?: { latitude: number; longitude: number; accuracy?: number };
  timezoneId?: string;
  locale?: string;
  userAgent?: string;
  viewport?: { width: number; height: number };
}

// ─── Config ────────────────────────────────────────────────────────
export interface SchruteConfig {
  dataDir: string;               // ~/.schrute
  logLevel: string;              // default: 'info'
  features: {
    webmcp: boolean;             // default: true
    httpTransport: boolean;      // default: false (v0.2+)
    discoveryImport: boolean;    // default: false — gates cold-start → DRAFT skill creation
    respectRobotsTxt: boolean;   // default: true — honor robots.txt during discovery
    sitemapDiscovery: boolean;   // default: true — discover URLs from sitemap.xml
    adaptivePathTrie: boolean;   // default: true — learn variable path segments from cardinality
  };
  browserPool?: {
    endpoints: { wsEndpoint: string; maxSessions?: number }[];
  };
  managedCrawl?: {
    provider: 'cloudflare';
    accountId: string;
    apiToken: string;
    maxPages?: number;
    render?: boolean;
  };
  browser?: {
    engine?: BrowserEngine;
    features?: BrowserFeatureFlagsConfig;
    idleTimeoutMs?: number;
    handlerTimeoutMs?: number;
    proxy?: ProxyConfig;
    geo?: GeoEmulationConfig;
    execution?: {
      backend?: 'playwright' | 'agent-browser' | 'live-chrome';  // default: 'agent-browser'
      engine?: string;                            // which browser engine the backend runs
    };
  };
  capabilities?: {
    enabled?: CapabilityName[];
  };
  toolBudget: ToolBudgetConfig;
  paramLimits: ParamLimits;
  payloadLimits: PayloadLimits;
  audit: {
    strictMode: boolean;         // default: true
    rootHashExport: boolean;     // default: true
  };
  storage: {
    maxPerSiteMb: number;        // default: 500
    maxGlobalMb: number;         // default: 5000
    retentionDays: number;       // default: 90
  };
  server: {
    network: boolean;            // default: false (v0.2+)
    authToken?: string;          // Required when network=true
    httpPort?: number;           // REST server port (default 3000, MCP HTTP = httpPort + 1)
  };
  daemon: {
    port: number;
    autoStart: boolean;
  };
  tempTtlMs: number;            // default: 3600000 (1 hour)
  gcIntervalMs: number;         // default: 900000 (15 minutes)
  confirmationTimeoutMs: number; // default: 30000
  confirmationExpiryMs: number;  // default: 60000
  promotionConsecutivePasses: number; // default: 5
  promotionVolatilityThreshold: number; // default: 0.2
  maxToolsPerSite: number;       // default: 20
  toolShortlistK: number;        // default: 10
  slimMode?: boolean;
}

// ─── Redaction Modes ───────────────────────────────────────────────
export type RedactionMode = 'agent-safe' | 'developer-debug';

// ─── Locked Mode ───────────────────────────────────────────────────
export interface LockedModeStatus {
  locked: boolean;
  reason?: string;
  availableCapabilities: CapabilityName[];
  unavailableCapabilities: CapabilityName[];
}

// ─── Zod Schemas for Validation ────────────────────────────────────

// Derive Zod enum value tuples from the `as const` objects to prevent
// hardcoded inline arrays from drifting out of sync with the source-of-truth
// const objects above.
const executionTierValues = Object.values(ExecutionTier) as [string, ...string[]];
const failureCauseValues = Object.values(FailureCause) as [string, ...string[]];
const capabilityValues = Object.values(Capability) as [string, ...string[]];

const PolicyDecisionSchema = z.object({
  proposed: z.string(),
  policyResult: z.enum(['allowed', 'blocked', 'confirmed']),
  policyRule: z.string(),
  userConfirmed: z.boolean().nullable(),
  redactionsApplied: z.array(z.string()),
  derivedAllowlist: z.array(z.string()).optional(),
});

/** Derived from PolicyDecisionSchema — use this instead of a manually written interface. */
export type PolicyDecision = z.infer<typeof PolicyDecisionSchema>;

export const AuditEntrySchema = z.object({
  id: z.string(),
  timestamp: z.number(),
  skillId: z.string(),
  executionTier: z.enum(executionTierValues),
  success: z.boolean(),
  latencyMs: z.number(),
  errorType: z.enum(failureCauseValues).optional(),
  capabilityUsed: z.enum(capabilityValues),
  policyDecision: PolicyDecisionSchema,
  previousHash: z.string(),
  entryHash: z.string(),
  signature: z.string().optional(),
  requestSummary: z.object({
    method: z.string(),
    url: z.string(),
  }).optional(),
  responseSummary: z.object({
    status: z.number(),
    schemaMatch: z.boolean(),
  }).optional(),
});

/** Derived from AuditEntrySchema — use this instead of a manually written interface. */
export type AuditEntry = z.infer<typeof AuditEntrySchema>;

// ─── Path Risk Patterns ────────────────────────────────────────────
export const DESTRUCTIVE_GET_PATTERNS = [
  /\/logout/i,
  /\/signout/i,
  /\/sign-out/i,
  /\/unsubscribe/i,
  /\/delete/i,
  /\/remove/i,
  /\/destroy/i,
  /\/toggle/i,
  /\/activate/i,
  /\/deactivate/i,
  /\/api\/.*\/webhook/i,
];

export const DESTRUCTIVE_POST_PATTERNS = [
  /\/mutation/i,
  /\/charge/i,
  /\/delete/i,
  /\/send/i,
  /\/order/i,
  /\/payment/i,
];

// ─── Noise Filter Patterns ─────────────────────────────────────────
export const ANALYTICS_DOMAINS = [
  'segment.io', 'segment.com',
  'google-analytics.com', 'analytics.google.com', 'googletagmanager.com',
  'mixpanel.com',
  'hotjar.com', 'hotjar.io',
  'fullstory.com',
  'amplitude.com',
  'heap.io', 'heapanalytics.com',
  'sentry.io',
  'newrelic.com',
  'datadog-agent',
  'bugsnag.com',
  'logrocket.com',
];

export const FEATURE_FLAG_DOMAINS = [
  'launchdarkly.com',
  'split.io',
  'optimizely.com',
  'flagsmith.com',
  'statsig.com',
];

export const STATIC_ASSET_EXTENSIONS = [
  '.js', '.css', '.png', '.jpg', '.jpeg', '.gif', '.svg', '.ico',
  '.woff', '.woff2', '.ttf', '.eot', '.otf',
  '.map', '.br', '.gz',
];

// ─── Tracking Params to Strip ──────────────────────────────────────
export const TRACKING_PARAMS = [
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
  'fbclid', 'gclid', 'msclkid', 'twclid',
  '_ga', '_gl', '_hsenc', '_hsmi',
  'mc_cid', 'mc_eid',
];

// ─── Enforced Non-Goals (v0.1) ─────────────────────────────────────
const UNSUPPORTED_PROTOCOLS = {
  websocket: 'This endpoint uses WebSockets. Browser-only.',
  sse: 'This endpoint uses Server-Sent Events. Browser-only.',
  binary: 'This endpoint uses binary data. Browser-only.',
  protobuf: 'This endpoint uses protobuf. Browser-only.',
  grpc_web: 'This endpoint uses gRPC-web. Browser-only.',
} as const;
