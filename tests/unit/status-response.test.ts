import { describe, expect, it, vi } from 'vitest';
import { getShapedStatus } from '../../src/server/status-response.js';

describe('getShapedStatus', () => {
  const baseStatus = {
    mode: 'exploring',
    activeSession: { id: 'sess-1', siteId: 'example.com', url: 'https://example.com', startedAt: Date.now() },
    activeNamedSession: { name: 'default', siteId: 'example.com', isCdp: false },
    currentRecording: {
      id: 'rec-1',
      name: 'login',
      siteId: 'example.com',
      startedAt: Date.now(),
      requestCount: 2,
      inputs: { password: 'secret' },
    },
    pendingRecovery: {
      reason: 'cloudflare_challenge' as const,
      recoveryMode: 'real_browser_cdp' as const,
      siteId: 'example.com',
      url: 'https://example.com/cdn-cgi/challenge-platform',
      hint: 'Cloudflare challenge detected.',
      resumeToken: 'recovery-token',
    },
    warnings: ['warning'],
    uptime: 1000,
    skillSummary: { total: 1, executable: 1, blocked: 0 },
  };

  it('redacts sensitive status fields for non-admin callers', async () => {
    const engine = {
      getStatus: vi.fn().mockReturnValue(structuredClone(baseStatus)),
      getMultiSessionManager: vi.fn(),
    } as any;
    const config = {
      server: { network: true },
      features: { webmcp: false },
    } as any;

    const result = await getShapedStatus(engine, config, 'rest:user');
    expect(result.activeSession).toBeNull();
    expect(result.activeNamedSession).toBeUndefined();
    expect(result.warnings).toBeUndefined();
    expect((result.currentRecording as any).inputs).toBeUndefined();
    expect(result.pendingRecovery?.resumeToken).toBeUndefined();
    expect(result.pendingRecovery?.siteId).toBe('example.com');
  });

  it('preserves pending recovery token for local admin callers', async () => {
    const engine = {
      getStatus: vi.fn().mockReturnValue(structuredClone(baseStatus)),
      getMultiSessionManager: vi.fn(),
    } as any;
    const config = {
      server: { network: false },
      features: { webmcp: false },
    } as any;

    const result = await getShapedStatus(engine, config, 'stdio');
    expect(result.pendingRecovery?.resumeToken).toBe('recovery-token');
    expect(result.activeSession).toEqual(baseStatus.activeSession);
  });
});
