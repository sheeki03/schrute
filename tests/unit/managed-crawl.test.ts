import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─── Mock logger ─────────────────────────────────────────────────
vi.mock('../../src/core/logger.js', () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import {
  CloudflareCrawlProvider,
  pollUntilComplete,
  type ManagedCrawlProvider,
  type CrawlJob,
} from '../../src/discovery/managed-crawl.js';

describe('CloudflareCrawlProvider', () => {
  let provider: CloudflareCrawlProvider;
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);

    provider = new CloudflareCrawlProvider({
      accountId: 'test-account',
      apiToken: 'test-token',
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('startCrawl', () => {
    it('sends POST request and returns job ID', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ result: { id: 'job-123' } }),
      });

      const jobId = await provider.startCrawl('https://example.com');

      expect(jobId).toBe('job-123');
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/browser-rendering/crawl'),
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            Authorization: 'Bearer test-token',
            'Content-Type': 'application/json',
          }),
        }),
      );
    });

    it('includes crawl options in request body', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ result: { id: 'job-456' } }),
      });

      await provider.startCrawl('https://example.com', {
        maxPages: 100,
        render: false,
        modifiedSince: '2025-01-01',
      });

      const call = mockFetch.mock.calls[0];
      const body = JSON.parse(call[1].body);
      expect(body.url).toBe('https://example.com');
      expect(body.maxPages).toBe(100);
      expect(body.render).toBe(false);
      expect(body.modifiedSince).toBe('2025-01-01');
    });

    it('uses default maxPages and render from config', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ result: { id: 'job-789' } }),
      });

      await provider.startCrawl('https://example.com');

      const call = mockFetch.mock.calls[0];
      const body = JSON.parse(call[1].body);
      expect(body.maxPages).toBe(50); // default
      expect(body.render).toBe(true); // default
    });

    it('throws on non-ok response', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 403,
        text: async () => 'Forbidden',
      });

      await expect(provider.startCrawl('https://example.com')).rejects.toThrow(
        /Cloudflare crawl start failed.*403.*Forbidden/,
      );
    });

    it('throws when response has no job ID', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ result: {} }),
      });

      await expect(provider.startCrawl('https://example.com')).rejects.toThrow(
        'no job ID in response',
      );
    });
  });

  describe('pollStatus', () => {
    it('returns completed job with pages', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          result: {
            status: 'completed',
            pages: [
              { url: 'https://example.com', html: '<p>hi</p>', statusCode: 200 },
              { url: 'https://example.com/about', markdown: '# About', statusCode: 200 },
            ],
          },
        }),
      });

      const job = await provider.pollStatus('job-123');

      expect(job.id).toBe('job-123');
      expect(job.status).toBe('completed');
      expect(job.pages).toHaveLength(2);
      expect(job.pages![0].url).toBe('https://example.com');
      expect(job.pages![0].statusCode).toBe(200);
    });

    it('returns processing status', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ result: { status: 'processing' } }),
      });

      const job = await provider.pollStatus('job-123');

      expect(job.status).toBe('processing');
    });

    it('returns failed on non-ok response', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
      });

      const job = await provider.pollStatus('job-123');

      expect(job.status).toBe('failed');
      expect(job.id).toBe('job-123');
    });

    it('defaults statusCode to 200 when missing', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          result: {
            status: 'completed',
            pages: [{ url: 'https://example.com' }],
          },
        }),
      });

      const job = await provider.pollStatus('job-123');

      expect(job.pages![0].statusCode).toBe(200);
    });
  });
});

describe('pollUntilComplete', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns immediately when job is already completed', async () => {
    const mockProvider: ManagedCrawlProvider = {
      name: 'test',
      startCrawl: vi.fn(),
      pollStatus: vi.fn().mockResolvedValue({
        id: 'job-1',
        status: 'completed',
        pages: [],
      } satisfies CrawlJob),
    };

    const result = await pollUntilComplete(mockProvider, 'job-1');

    expect(result.status).toBe('completed');
    expect(mockProvider.pollStatus).toHaveBeenCalledTimes(1);
  });

  it('returns immediately when job has failed', async () => {
    const mockProvider: ManagedCrawlProvider = {
      name: 'test',
      startCrawl: vi.fn(),
      pollStatus: vi.fn().mockResolvedValue({
        id: 'job-1',
        status: 'failed',
      } satisfies CrawlJob),
    };

    const result = await pollUntilComplete(mockProvider, 'job-1');

    expect(result.status).toBe('failed');
    expect(mockProvider.pollStatus).toHaveBeenCalledTimes(1);
  });

  it('polls until completed', async () => {
    const mockProvider: ManagedCrawlProvider = {
      name: 'test',
      startCrawl: vi.fn(),
      pollStatus: vi.fn()
        .mockResolvedValueOnce({ id: 'job-1', status: 'processing' } satisfies CrawlJob)
        .mockResolvedValueOnce({ id: 'job-1', status: 'processing' } satisfies CrawlJob)
        .mockResolvedValueOnce({ id: 'job-1', status: 'completed', pages: [] } satisfies CrawlJob),
    };

    const promise = pollUntilComplete(mockProvider, 'job-1', 120_000, 100);

    // Advance timers past the first two intervals
    await vi.advanceTimersByTimeAsync(100); // first wait
    await vi.advanceTimersByTimeAsync(150); // second wait (100 * 1.5 backoff)

    const result = await promise;

    expect(result.status).toBe('completed');
    expect(mockProvider.pollStatus).toHaveBeenCalledTimes(3);
  });

  it('returns failed on timeout', async () => {
    const mockProvider: ManagedCrawlProvider = {
      name: 'test',
      startCrawl: vi.fn(),
      pollStatus: vi.fn().mockResolvedValue({
        id: 'job-1',
        status: 'processing',
      } satisfies CrawlJob),
    };

    // Use a very short timeout so it expires quickly
    const promise = pollUntilComplete(mockProvider, 'job-1', 50, 10);

    // Advance time past the timeout
    await vi.advanceTimersByTimeAsync(200);

    const result = await promise;

    expect(result.status).toBe('failed');
    expect(result.id).toBe('job-1');
  });
});
