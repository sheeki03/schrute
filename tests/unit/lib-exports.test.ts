import { describe, it, expect, vi } from 'vitest';

// Mock heavy dependencies to allow import without side effects
vi.mock('playwright', () => ({
  chromium: { launch: vi.fn(), connectOverCDP: vi.fn() },
  firefox: { launch: vi.fn() },
}));

vi.mock('../../src/core/logger.js', () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: () => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    }),
  }),
}));

vi.mock('../../src/storage/database.js', () => ({
  getDatabase: vi.fn().mockReturnValue({
    prepare: vi.fn().mockReturnValue({
      run: vi.fn(),
      get: vi.fn(),
      all: vi.fn(),
    }),
    exec: vi.fn(),
    close: vi.fn(),
  }),
  closeDatabase: vi.fn(),
}));

describe('Library Exports (src/lib.ts)', () => {
  it('exports all expected named exports', async () => {
    const lib = await import('../../src/lib.js');

    // Core
    expect(lib.Engine).toBeDefined();

    // Browser
    expect(lib.BrowserManager).toBeDefined();
    expect(lib.MultiSessionManager).toBeDefined();

    // Storage
    expect(lib.SkillRepository).toBeDefined();
    expect(lib.SiteRepository).toBeDefined();
    expect(lib.getDatabase).toBeDefined();
    expect(lib.closeDatabase).toBeDefined();

    // Config
    expect(lib.getConfig).toBeDefined();
    expect(lib.loadConfig).toBeDefined();
    expect(lib.ensureDirectories).toBeDefined();

    // Server factories
    expect(lib.startMcpServer).toBeDefined();

    // Version
    expect(lib.VERSION).toBeDefined();
  });

  it('exports SkillStatus as an enum-like object with expected values', async () => {
    const { SkillStatus } = await import('../../src/lib.js');

    expect(typeof SkillStatus).toBe('object');
    expect(SkillStatus).not.toBeNull();
    expect(SkillStatus.DRAFT).toBe('draft');
    expect(SkillStatus.ACTIVE).toBe('active');
    expect(SkillStatus.STALE).toBe('stale');
    expect(SkillStatus.BROKEN).toBe('broken');
  });

  it('exports ExecutionTier as an enum-like object with expected values', async () => {
    const { ExecutionTier } = await import('../../src/lib.js');

    expect(typeof ExecutionTier).toBe('object');
    expect(ExecutionTier).not.toBeNull();
    expect(ExecutionTier.DIRECT).toBe('direct');
    expect(ExecutionTier.FULL_BROWSER).toBe('full_browser');
    expect(ExecutionTier.SIGNED_AGENT).toBe('signed_agent');
  });

  it('exports Capability as an enum-like object with expected values', async () => {
    const { Capability } = await import('../../src/lib.js');

    expect(typeof Capability).toBe('object');
    expect(Capability).not.toBeNull();
    expect(Capability.NET_FETCH_DIRECT).toBe('net.fetch.direct');
    expect(Capability.BROWSER_AUTOMATION).toBe('browser.automation');
    expect(Capability.STORAGE_WRITE).toBe('storage.write');
  });

  it('VERSION is a semver-like string', async () => {
    const { VERSION } = await import('../../src/lib.js');

    expect(typeof VERSION).toBe('string');
    expect(VERSION.length).toBeGreaterThan(0);
    // Should look like a version string (digits and dots)
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('Engine, BrowserManager, SkillRepository are constructor functions or classes', async () => {
    const lib = await import('../../src/lib.js');

    expect(typeof lib.Engine).toBe('function');
    expect(typeof lib.BrowserManager).toBe('function');
    expect(typeof lib.SkillRepository).toBe('function');
  });

  it('getConfig, loadConfig, ensureDirectories are functions', async () => {
    const lib = await import('../../src/lib.js');

    expect(typeof lib.getConfig).toBe('function');
    expect(typeof lib.loadConfig).toBe('function');
    expect(typeof lib.ensureDirectories).toBe('function');
  });

  it('startMcpServer is a function', async () => {
    const { startMcpServer } = await import('../../src/lib.js');

    expect(typeof startMcpServer).toBe('function');
  });

  it('does not contain process.exit calls in the lib entry point', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const libPath = path.resolve(import.meta.dirname, '../../src/lib.ts');
    const source = fs.readFileSync(libPath, 'utf-8');

    expect(source).not.toContain('process.exit');
  });
});
