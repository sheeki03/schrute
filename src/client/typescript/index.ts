// ─── OneAgent TypeScript Client SDK ─────────────────────────────────

export type {
  OneAgentClientOptions,
  SiteManifestResponse,
  SkillSummary,
  ExecuteSkillResponse,
  ConfirmationRequired,
  DryRunResponse,
  ValidateResponse,
  ExploreResponse,
  RecordResponse,
  StopResponse,
  HealthResponse,
  OpenApiSpec,
} from './types.js';

import type {
  OneAgentClientOptions,
  SiteManifestResponse,
  SkillSummary,
  ExecuteSkillResponse,
  DryRunResponse,
  ValidateResponse,
  ExploreResponse,
  RecordResponse,
  StopResponse,
  HealthResponse,
  OpenApiSpec,
} from './types.js';

// ─── Error Class ────────────────────────────────────────────────────

export class OneAgentError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly body?: unknown,
  ) {
    super(message);
    this.name = 'OneAgentError';
  }
}

// ─── Client ─────────────────────────────────────────────────────────

export class OneAgentClient {
  private readonly baseUrl: string;
  private readonly headers: Record<string, string>;

  constructor(options: OneAgentClientOptions) {
    // Strip trailing slash
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.headers = {
      'Content-Type': 'application/json',
    };
    if (options.apiKey) {
      this.headers['Authorization'] = `Bearer ${options.apiKey}`;
    }
  }

  // ─── Sites ──────────────────────────────────────────────────────

  async listSites(): Promise<SiteManifestResponse[]> {
    return this.get<SiteManifestResponse[]>('/api/sites');
  }

  async getSite(id: string): Promise<SiteManifestResponse> {
    return this.get<SiteManifestResponse>(`/api/sites/${encodeURIComponent(id)}`);
  }

  // ─── Skills ─────────────────────────────────────────────────────

  async listSkills(siteId?: string, status?: string): Promise<SkillSummary[]> {
    if (!siteId) {
      // List all skills across all sites — fetch sites first
      const sites = await this.listSites();
      const all: SkillSummary[] = [];
      for (const site of sites) {
        const skills = await this.listSkills(site.id, status);
        all.push(...skills);
      }
      return all;
    }
    const params = new URLSearchParams();
    if (status) params.set('status', status);
    const qs = params.toString();
    const path = `/api/sites/${encodeURIComponent(siteId)}/skills${qs ? `?${qs}` : ''}`;
    return this.get<SkillSummary[]>(path);
  }

  // ─── Execute ────────────────────────────────────────────────────

  async executeSkill(
    siteId: string,
    name: string,
    params: Record<string, unknown> = {},
  ): Promise<ExecuteSkillResponse> {
    return this.post<ExecuteSkillResponse>(
      `/api/sites/${encodeURIComponent(siteId)}/skills/${encodeURIComponent(name)}`,
      { params },
    );
  }

  // ─── Dry Run ────────────────────────────────────────────────────

  async dryRun(
    siteId: string,
    name: string,
    params: Record<string, unknown> = {},
  ): Promise<DryRunResponse> {
    return this.post<DryRunResponse>(
      `/api/sites/${encodeURIComponent(siteId)}/skills/${encodeURIComponent(name)}/dry-run`,
      { params },
    );
  }

  // ─── Validate ───────────────────────────────────────────────────

  async validate(
    siteId: string,
    name: string,
    params: Record<string, unknown> = {},
  ): Promise<ValidateResponse> {
    return this.post<ValidateResponse>(
      `/api/sites/${encodeURIComponent(siteId)}/skills/${encodeURIComponent(name)}/validate`,
      { params },
    );
  }

  // ─── Explore ────────────────────────────────────────────────────

  async explore(url: string): Promise<ExploreResponse> {
    return this.post<ExploreResponse>('/api/explore', { url });
  }

  // ─── Record ─────────────────────────────────────────────────────

  async record(
    name: string,
    inputs?: Record<string, string>,
  ): Promise<RecordResponse> {
    return this.post<RecordResponse>('/api/record', { name, inputs });
  }

  // ─── Stop ───────────────────────────────────────────────────────

  async stop(): Promise<StopResponse> {
    return this.post<StopResponse>('/api/stop', {});
  }

  // ─── Health ─────────────────────────────────────────────────────

  async getHealth(): Promise<HealthResponse> {
    return this.get<HealthResponse>('/api/health');
  }

  // ─── OpenAPI Spec ───────────────────────────────────────────────

  async getOpenApiSpec(): Promise<OpenApiSpec> {
    return this.get<OpenApiSpec>('/api/openapi.json');
  }

  // ─── HTTP Helpers ───────────────────────────────────────────────

  private async get<T>(path: string): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const response = await fetch(url, {
      method: 'GET',
      headers: this.headers,
    });
    return this.handleResponse<T>(response);
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify(body),
    });
    return this.handleResponse<T>(response);
  }

  private async handleResponse<T>(response: Response): Promise<T> {
    const body = await response.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      parsed = body;
    }

    if (!response.ok) {
      const message =
        parsed && typeof parsed === 'object' && 'error' in parsed
          ? String((parsed as { error: unknown }).error)
          : `HTTP ${response.status}`;
      throw new OneAgentError(message, response.status, parsed);
    }

    return parsed as T;
  }
}
