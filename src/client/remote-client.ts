export class RemoteClient {
  private baseUrl: string;
  private token?: string;
  private timeoutMs: number;

  constructor(baseUrl: string, token?: string, timeoutMs = 30_000) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.token = token;
    this.timeoutMs = timeoutMs;
  }

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (this.token) {
      headers['Authorization'] = `Bearer ${this.token}`;
    }

    const resp = await fetch(`${this.baseUrl}/api/v1${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error(`HTTP ${resp.status}: ${text || resp.statusText}`);
    }

    const data = await resp.json() as { success: boolean; data?: T; error?: { message: string } };
    if (!data.success) {
      throw new Error(data.error?.message ?? `Request failed: ${resp.status}`);
    }
    return data.data as T;
  }

  async explore(url: string): Promise<unknown> {
    return this.request('POST', '/explore', { url });
  }

  async listSites(): Promise<unknown> {
    return this.request('GET', '/sites');
  }

  async listSessions(): Promise<unknown> {
    return this.request('GET', '/sessions');
  }

  async getStatus(): Promise<unknown> {
    return this.request('GET', '/status');
  }

  async executeSkill(skillId: string, params: Record<string, unknown>): Promise<unknown> {
    return this.request('POST', '/execute', { skillId, params });
  }

  async confirm(token: string, approve: boolean): Promise<unknown> {
    return this.request('POST', '/confirm', { token, approve });
  }

  async listSkills(siteId?: string, status?: string): Promise<unknown> {
    const params = new URLSearchParams();
    if (siteId) params.set('siteId', siteId);
    if (status) params.set('status', status);
    const qs = params.toString();
    return this.request('GET', `/skills${qs ? `?${qs}` : ''}`);
  }

  async revokeApproval(skillId: string): Promise<unknown> {
    return this.request('POST', `/skills/${skillId}/revoke`, {});
  }

  async searchSkills(query?: string, limit?: number, siteId?: string): Promise<unknown> {
    return this.request('POST', '/skills/search', { query, limit, siteId });
  }

  async startRecording(name: string, inputs?: Record<string, string>): Promise<unknown> {
    return this.request('POST', '/record', { name, inputs });
  }

  async stopRecording(): Promise<unknown> {
    return this.request('POST', '/stop', {});
  }
}
