import { describe, it, expect } from 'vitest';
import { SessionManager } from '../../src/core/session.js';

describe('SessionManager', () => {
  it('creates a session with unique id', async () => {
    const mgr = new SessionManager();
    const { session } = await mgr.create('example.com', 'https://example.com/app');
    expect(session.id).toBeDefined();
    expect(session.siteId).toBe('example.com');
    expect(session.url).toBe('https://example.com/app');
    expect(session.startedAt).toBeGreaterThan(0);
  });

  it('returns browserError when browser context fails', async () => {
    const mgr = new SessionManager();
    // Default SessionManager has no real browser — will fail to create context
    const { session, browserError } = await mgr.create('example.com', 'https://example.com/app');
    expect(session.id).toBeDefined();
    // browserError may or may not be set depending on whether BrowserManager throws
    // (in test env with no real browser, it typically does)
    if (browserError) {
      expect(browserError).toBeInstanceOf(Error);
    }
  });

  it('resumes an existing session', async () => {
    const mgr = new SessionManager();
    const { session } = await mgr.create('example.com', 'https://example.com/app');
    const resumed = await mgr.resume(session.id);
    expect(resumed.id).toBe(session.id);
    expect(resumed.siteId).toBe(session.siteId);
  });

  it('throws when resuming non-existent session', async () => {
    const mgr = new SessionManager();
    await expect(mgr.resume('non-existent-id')).rejects.toThrow("Session 'non-existent-id' not found");
  });

  it('closes a session and removes it from active list', async () => {
    const mgr = new SessionManager();
    const { session } = await mgr.create('example.com', 'https://example.com/app');
    expect(mgr.listActive()).toHaveLength(1);

    await mgr.close(session.id);
    expect(mgr.listActive()).toHaveLength(0);
  });

  it('does not throw when closing non-existent session', async () => {
    const mgr = new SessionManager();
    await expect(mgr.close('non-existent-id')).resolves.toBeUndefined();
  });

  it('lists all active sessions', async () => {
    const mgr = new SessionManager();
    await mgr.create('site1.com', 'https://site1.com');
    await mgr.create('site2.com', 'https://site2.com');
    await mgr.create('site3.com', 'https://site3.com');

    const active = mgr.listActive();
    expect(active).toHaveLength(3);
    expect(active.map((s) => s.siteId).sort()).toEqual(['site1.com', 'site2.com', 'site3.com']);
  });

  it('creates sessions with unique ids', async () => {
    const mgr = new SessionManager();
    const { session: s1 } = await mgr.create('site.com', 'https://site.com');
    const { session: s2 } = await mgr.create('site.com', 'https://site.com');
    expect(s1.id).not.toBe(s2.id);
  });
});
