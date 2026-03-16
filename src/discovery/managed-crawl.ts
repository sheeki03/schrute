import { getLogger } from '../core/logger.js';

const log = getLogger();

// --- Types ------------------------------------------------------------------

interface CrawlOptions {
  depth?: number;
  maxPages?: number;
  modifiedSince?: string;
  render?: boolean;
}

export interface CrawledPage {
  url: string;
  html?: string;
  markdown?: string;
  statusCode: number;
  lastModified?: string;
}

export interface CrawlJob {
  id: string;
  status: 'processing' | 'completed' | 'failed';
  pages?: CrawledPage[];
}

export interface ManagedCrawlProvider {
  name: string;
  startCrawl(url: string, options?: CrawlOptions): Promise<string>;
  pollStatus(jobId: string): Promise<CrawlJob>;
}

// --- Cloudflare Provider ----------------------------------------------------

interface CloudflareConfig {
  accountId: string;
  apiToken: string;
  maxPages?: number;
  render?: boolean;
}

export class CloudflareCrawlProvider implements ManagedCrawlProvider {
  name = 'cloudflare';
  private config: CloudflareConfig;

  constructor(config: CloudflareConfig) {
    this.config = config;
  }

  async startCrawl(url: string, options?: CrawlOptions): Promise<string> {
    const resp = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${this.config.accountId}/browser-rendering/crawl`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.config.apiToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          url,
          maxPages: options?.maxPages ?? this.config.maxPages ?? 50,
          render: options?.render ?? this.config.render ?? true,
          ...(options?.modifiedSince ? { modifiedSince: options.modifiedSince } : {}),
        }),
        signal: AbortSignal.timeout(30_000),
      },
    );

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Cloudflare crawl start failed (${resp.status}): ${text}`);
    }

    const data = await resp.json() as { result?: { id?: string } };
    const jobId = data.result?.id;
    if (!jobId) throw new Error('Cloudflare crawl: no job ID in response');
    log.info({ jobId, url }, 'Cloudflare crawl started');
    return jobId;
  }

  async pollStatus(jobId: string): Promise<CrawlJob> {
    const resp = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${this.config.accountId}/browser-rendering/crawl/${jobId}`,
      {
        headers: { 'Authorization': `Bearer ${this.config.apiToken}` },
        signal: AbortSignal.timeout(10_000),
      },
    );

    if (!resp.ok) {
      return { id: jobId, status: 'failed' };
    }

    const data = await resp.json() as {
      result?: {
        status?: string;
        pages?: Array<{ url: string; html?: string; markdown?: string; statusCode?: number; lastModified?: string }>;
      };
    };

    const status = data.result?.status === 'completed' ? 'completed'
      : data.result?.status === 'failed' ? 'failed'
      : 'processing';

    return {
      id: jobId,
      status,
      pages: data.result?.pages?.map(p => ({
        url: p.url,
        html: p.html,
        markdown: p.markdown,
        statusCode: p.statusCode ?? 200,
        lastModified: p.lastModified,
      })),
    };
  }
}

// --- Poll Helper ------------------------------------------------------------

export async function pollUntilComplete(
  provider: ManagedCrawlProvider,
  jobId: string,
  timeoutMs = 120_000,
  intervalMs = 3_000,
): Promise<CrawlJob> {
  const deadline = Date.now() + timeoutMs;
  let backoff = intervalMs;

  while (Date.now() < deadline) {
    const job = await provider.pollStatus(jobId);
    if (job.status !== 'processing') return job;
    await new Promise(r => setTimeout(r, backoff));
    backoff = Math.min(backoff * 1.5, 15_000);
  }

  return { id: jobId, status: 'failed' };
}
