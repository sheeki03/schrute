// ─── Schrute TypeScript Client SDK ─────────────────────────────────

export type {
  SchruteClientOptions,
  SiteManifestResponse,
  SkillSummary,
  ExecuteSkillResponse,
  ConfirmationRequired,
  DryRunResponse,
  ValidateResponse,
  ExploreResponse,
  RecoverExploreResponse,
  RecordResponse,
  StopResponse,
  PipelineJobResponse,
  HealthResponse,
  OpenApiSpec,
  SkillSearchResult,
  SkillSearchResponse,
} from './types.js';

import type {
  SchruteClientOptions,
  SiteManifestResponse,
  SkillSummary,
  ExecuteSkillResponse,
  DryRunResponse,
  ValidateResponse,
  ExploreResponse,
  RecoverExploreResponse,
  RecordResponse,
  StopResponse,
  PipelineJobResponse,
  HealthResponse,
  OpenApiSpec,
  SkillSearchResponse,
} from './types.js';

// ─── Error Class ────────────────────────────────────────────────────

export class SchruteError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly body?: unknown,
  ) {
    super(message);
    this.name = 'SchruteError';
  }
}

// ─── Client ─────────────────────────────────────────────────────────

export class SchruteClient {
  private readonly baseUrl: string;
  private readonly headers: Record<string, string>;

  constructor(options: SchruteClientOptions) {
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

  async recoverExplore(resumeToken: string, waitMs?: number): Promise<RecoverExploreResponse> {
    return this.post<RecoverExploreResponse>('/api/recover-explore', {
      resumeToken,
      ...(waitMs !== undefined ? { waitMs } : {}),
    });
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

  async getPipelineStatus(jobId: string): Promise<PipelineJobResponse> {
    return this.get<PipelineJobResponse>(`/api/pipeline/${encodeURIComponent(jobId)}`);
  }

  // ─── Health ─────────────────────────────────────────────────────

  async getHealth(): Promise<HealthResponse> {
    return this.get<HealthResponse>('/api/health');
  }

  // ─── OpenAPI Spec ───────────────────────────────────────────────

  async getOpenApiSpec(): Promise<OpenApiSpec> {
    return this.get<OpenApiSpec>('/api/openapi.json');
  }

  // ─── Search ───────────────────────────────────────────────────────

  async searchSkills(opts?: { query?: string; siteId?: string; limit?: number; includeInactive?: boolean }): Promise<SkillSearchResponse> {
    return this.postV1<SkillSearchResponse>('/api/v1/skills/search', opts ?? {});
  }

  // ─── HTTP Helpers ───────────────────────────────────────────────

  private async postV1<T>(path: string, body: unknown): Promise<T> {
    const envelope = await this.post<{ success: boolean; data: T; meta: unknown }>(path, body);
    return envelope.data;
  }

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
      throw new SchruteError(message, response.status, parsed);
    }

    return parsed as T;
  }
}
