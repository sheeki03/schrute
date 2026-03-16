// ─── Discovery Types ─────────────────────────────────────────────────

export interface DiscoveredEndpoint {
  method: string;
  path: string;
  description?: string;
  parameters?: { name: string; in: string; type: string; required?: boolean }[];
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  source: 'openapi' | 'graphql' | 'platform' | 'webmcp' | 'traffic' | 'devtools-mcp';
  trustLevel: 1 | 2 | 3 | 4 | 5; // discrete trust levels, higher = more trusted
  _hasNonJsonBody?: boolean;
  _hasUnresolvedRefs?: boolean;
}

export interface OpenApiScanResult {
  found: boolean;
  specVersion?: string;
  endpoints: DiscoveredEndpoint[];
  rawSpec?: Record<string, unknown>;
}

export interface GraphQLOperation {
  name: string;
  type: 'query' | 'mutation' | 'subscription';
  args: { name: string; type: string }[];
  returnType: string;
}

export interface GraphQLScanResult {
  found: boolean;
  queries: GraphQLOperation[];
  mutations: GraphQLOperation[];
}

export interface PlatformResult {
  platform: string | null;
  confidence: number;
  knownEndpoints: string[];
}

export interface WebMcpTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  declarative?: boolean;
  autoSubmit?: boolean;
  outputSchema?: Record<string, unknown>;
}

export interface WebMcpScanResult {
  available: boolean;
  tools: WebMcpTool[];
}

export type DiscoverySourceType = 'openapi' | 'graphql' | 'platform' | 'webmcp' | 'traffic' | 'sitemap' | 'devtools-mcp';

export interface DiscoverySource {
  type: DiscoverySourceType;
  found: boolean;
  endpointCount: number;
  metadata?: Record<string, unknown>;
}

export interface DiscoveryResult {
  siteId: string;
  sources: DiscoverySource[];
  endpoints: DiscoveredEndpoint[];
  trustRanking: Record<DiscoverySourceType, number>;
  docs?: { markdown: string; sourceUrl: string }[];
}
