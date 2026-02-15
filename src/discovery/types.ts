// ─── Discovery Types ─────────────────────────────────────────────────

export interface DiscoveredEndpoint {
  method: string;
  path: string;
  description?: string;
  parameters?: { name: string; in: string; type: string }[];
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  source: 'openapi' | 'graphql' | 'platform' | 'webmcp' | 'traffic';
  trustLevel: number; // 1-5, higher = more trusted
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
}

export interface WebMcpScanResult {
  available: boolean;
  tools: WebMcpTool[];
}

export type DiscoverySourceType = 'openapi' | 'graphql' | 'platform' | 'webmcp' | 'traffic';

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
}
