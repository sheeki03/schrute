import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs';

const { mockSetSitePolicy } = vi.hoisted(() => ({
  mockSetSitePolicy: vi.fn().mockReturnValue({ persisted: true }),
}));

vi.mock('node:fs');

vi.mock('../../src/storage/import-validator.js', () => ({
  validateImportableSkill: vi.fn().mockReturnValue({ valid: true, errors: [] }),
  validateImportableSite: vi.fn().mockReturnValue({ valid: true, errors: [] }),
}));

vi.mock('../../src/core/policy.js', () => ({
  getSitePolicy: vi.fn().mockReturnValue({
    siteId: 'example.com',
    maxConcurrent: 2,
    maxQps: 5,
    readOnlyDefault: false,
    allowedMethods: ['GET', 'POST'],
    requireConfirmation: [],
    domainAllowlist: [],
    redactionRules: [],
    capabilities: [],
  }),
  setSitePolicy: mockSetSitePolicy,
}));

import { performImport } from '../../src/app/import-service.js';
import { validateImportableSkill, validateImportableSite } from '../../src/storage/import-validator.js';
import { getSitePolicy } from '../../src/core/policy.js';

function makeBundle(overrides: Record<string, unknown> = {}) {
  return {
    version: '0.2.0',
    site: {
      id: 'example.com',
      displayName: 'Example',
      rootUrls: ['https://example.com'],
      firstSeen: Date.now(),
      lastVisited: Date.now(),
      masteryLevel: 'novice',
      ...((overrides.site as Record<string, unknown>) ?? {}),
    },
    skills: overrides.skills ?? [
      {
        id: 'example.com.get_data.v1',
        name: 'get_data',
        siteId: 'example.com',
        method: 'GET',
        pathTemplate: '/api/data',
        allowedDomains: ['example.com'],
        status: 'active',
        currentTier: 'tier_3',
        inputSchema: {},
        sideEffectClass: 'read-only',
        confidence: 0.9,
        consecutiveValidations: 3,
        sampleCount: 10,
        successRate: 0.95,
        version: 1,
        isComposite: false,
        directCanaryEligible: false,
        directCanaryAttempts: 0,
        validationsSinceLastCanary: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    ],
    ...overrides,
  };
}

function makeDeps() {
  return {
    db: {
      transaction: vi.fn((fn: () => void) => fn()),
    } as any,
    skillRepo: {
      getById: vi.fn().mockReturnValue(undefined),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    } as any,
    siteRepo: {
      getById: vi.fn().mockReturnValue(undefined),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    } as any,
    config: { logLevel: 'silent' },
  };
}

describe('performImport', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockSetSitePolicy.mockReturnValue({ persisted: true });
    (validateImportableSkill as any).mockReturnValue({ valid: true, errors: [] });
    (validateImportableSite as any).mockReturnValue({ valid: true, errors: [] });
    (getSitePolicy as any).mockReturnValue({
      siteId: 'example.com',
      maxConcurrent: 2,
      maxQps: 5,
      readOnlyDefault: false,
      allowedMethods: ['GET', 'POST'],
      requireConfirmation: [],
      domainAllowlist: [],
      redactionRules: [],
      capabilities: [],
    });
  });

  it('creates site and skills for a new import', async () => {
    const bundle = makeBundle();
    (fs.existsSync as any).mockReturnValue(true);
    (fs.readFileSync as any).mockReturnValue(JSON.stringify(bundle));

    const deps = makeDeps();
    const result = await performImport('test.json', deps, { yes: true });

    expect(result.siteAction).toBe('created');
    expect(result.created).toBe(1);
    expect(result.updated).toBe(0);
    expect(deps.siteRepo.create).toHaveBeenCalledOnce();
    expect(deps.skillRepo.create).toHaveBeenCalledOnce();
  });

  it('updates existing site and skills', async () => {
    const bundle = makeBundle();
    (fs.existsSync as any).mockReturnValue(true);
    (fs.readFileSync as any).mockReturnValue(JSON.stringify(bundle));

    const deps = makeDeps();
    deps.siteRepo.getById.mockReturnValue(bundle.site);
    deps.skillRepo.getById.mockReturnValue(bundle.skills[0]);

    const result = await performImport('test.json', deps, { yes: true });

    expect(result.siteAction).toBe('updated');
    expect(result.created).toBe(0);
    expect(result.updated).toBe(1);
  });

  it('skips invalid skills', async () => {
    const bundle = makeBundle({
      skills: [
        { id: 'good', siteId: 'example.com', method: 'GET', pathTemplate: '/ok', allowedDomains: ['example.com'] },
        { id: 'bad', siteId: 'example.com', method: 'GET', pathTemplate: '/bad', allowedDomains: ['example.com'] },
      ],
    });
    (fs.existsSync as any).mockReturnValue(true);
    (fs.readFileSync as any).mockReturnValue(JSON.stringify(bundle));

    (validateImportableSkill as any)
      .mockReturnValueOnce({ valid: true, errors: [] })
      .mockReturnValueOnce({ valid: false, errors: ['missing field'] });

    const deps = makeDeps();
    const result = await performImport('test.json', deps, { yes: true });

    expect(result.created).toBe(1);
    expect(result.skipped).toBe(1);
  });

  it('fills defaults for skills missing NOT NULL fields', async () => {
    const bundle = makeBundle({
      skills: [
        {
          id: 'example.com.minimal.v1',
          siteId: 'example.com',
          method: 'GET',
          pathTemplate: '/api/minimal',
          allowedDomains: ['example.com'],
        },
      ],
    });
    (fs.existsSync as any).mockReturnValue(true);
    (fs.readFileSync as any).mockReturnValue(JSON.stringify(bundle));

    const deps = makeDeps();
    const result = await performImport('test.json', deps, { yes: true });

    expect(result.created).toBe(1);
    const created = deps.skillRepo.create.mock.calls[0][0];
    expect(created.status).toBe('draft');
    expect(created.currentTier).toBe('tier_3');
    expect(created.confidence).toBe(0);
    expect(created.name).toBe('minimal');
  });

  it('handles corrupt site rows gracefully', async () => {
    const bundle = makeBundle();
    (fs.existsSync as any).mockReturnValue(true);
    (fs.readFileSync as any).mockReturnValue(JSON.stringify(bundle));

    const deps = makeDeps();
    deps.siteRepo.getById.mockImplementation(() => { throw new Error('corrupt'); });

    const result = await performImport('test.json', deps, { yes: true });
    expect(result.siteAction).toBe('created');
    // Corrupt site delete attempted before create
    expect(deps.siteRepo.delete).toHaveBeenCalledWith('example.com');
    expect(deps.siteRepo.create).toHaveBeenCalledOnce();
  });

  it('handles corrupt skill rows — counts as updated', async () => {
    const bundle = makeBundle();
    (fs.existsSync as any).mockReturnValue(true);
    (fs.readFileSync as any).mockReturnValue(JSON.stringify(bundle));

    const deps = makeDeps();
    deps.skillRepo.getById.mockImplementation(() => { throw new Error('corrupt'); });

    const result = await performImport('test.json', deps, { yes: true });
    expect(result.updated).toBe(1);
    expect(result.created).toBe(0);
    // Corrupt skill deleted then recreated
    expect(deps.skillRepo.delete).toHaveBeenCalledWith('example.com.get_data.v1');
    expect(deps.skillRepo.create).toHaveBeenCalledOnce();
  });

  it('rejects in non-TTY without --yes when overwrites exist', async () => {
    const bundle = makeBundle();
    (fs.existsSync as any).mockReturnValue(true);
    (fs.readFileSync as any).mockReturnValue(JSON.stringify(bundle));

    // Make it look like overwrite (existing site)
    const deps = makeDeps();
    deps.siteRepo.getById.mockReturnValue(bundle.site);

    const origIsTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });

    try {
      await expect(performImport('test.json', deps)).rejects.toThrow('Non-interactive terminal');
    } finally {
      Object.defineProperty(process.stdin, 'isTTY', { value: origIsTTY, configurable: true });
    }
  });

  it('throws for missing file', async () => {
    (fs.existsSync as any).mockReturnValue(false);
    const deps = makeDeps();
    await expect(performImport('missing.json', deps, { yes: true })).rejects.toThrow("File 'missing.json' not found");
  });

  it('throws for invalid bundle format', async () => {
    (fs.existsSync as any).mockReturnValue(true);
    (fs.readFileSync as any).mockReturnValue(JSON.stringify({ version: '0.2.0' }));
    (validateImportableSite as any).mockReturnValue({ valid: true, errors: [] });

    const deps = makeDeps();
    await expect(performImport('bad.json', deps, { yes: true })).rejects.toThrow('Invalid bundle format');
  });

  it('detects authType and reports hasAuthSkills', async () => {
    const bundle = makeBundle({
      skills: [
        {
          id: 'example.com.auth_api.v1',
          siteId: 'example.com',
          method: 'GET',
          pathTemplate: '/api/auth',
          allowedDomains: ['example.com'],
          authType: 'bearer',
        },
      ],
    });
    (fs.existsSync as any).mockReturnValue(true);
    (fs.readFileSync as any).mockReturnValue(JSON.stringify(bundle));

    const deps = makeDeps();
    const result = await performImport('test.json', deps, { yes: true });
    expect(result.hasAuthSkills).toBe(true);
  });

  it('wraps site + skill writes in a transaction', async () => {
    const bundle = makeBundle();
    (fs.existsSync as any).mockReturnValue(true);
    (fs.readFileSync as any).mockReturnValue(JSON.stringify(bundle));

    const deps = makeDeps();
    await performImport('test.json', deps, { yes: true });

    expect(deps.db.transaction).toHaveBeenCalledOnce();
  });

  it('persists policy via setSitePolicy when bundle has policy', async () => {
    const bundle = makeBundle({
      policy: {
        siteId: 'example.com',
        maxConcurrent: 5,
        maxQps: 10,
        readOnlyDefault: true,
        allowedMethods: ['GET'],
        requireConfirmation: [],
        domainAllowlist: ['example.com'],
        redactionRules: [],
        capabilities: [],
      },
    });
    (fs.existsSync as any).mockReturnValue(true);
    (fs.readFileSync as any).mockReturnValue(JSON.stringify(bundle));

    const deps = makeDeps();
    await performImport('test.json', deps, { yes: true });

    expect(mockSetSitePolicy).toHaveBeenCalledOnce();
    expect(mockSetSitePolicy.mock.calls[0][0].siteId).toBe('example.com');
  });

  it('warns when setSitePolicy throws instead of failing import', async () => {
    const bundle = makeBundle({
      policy: {
        siteId: 'example.com',
        maxConcurrent: 5,
        executionSessionName: 'test',
        executionBackend: 'invalid',
      },
    });
    (fs.existsSync as any).mockReturnValue(true);
    (fs.readFileSync as any).mockReturnValue(JSON.stringify(bundle));
    mockSetSitePolicy.mockImplementation(() => { throw new Error('validation failed'); });

    const deps = makeDeps();
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const result = await performImport('test.json', deps, { yes: true });

    // Import still succeeds — policy failure is a warning
    expect(result.created).toBe(1);
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('policy import failed'));
    consoleSpy.mockRestore();
  });

  it('warns when policy siteId mismatches bundle site', async () => {
    const bundle = makeBundle({
      policy: { siteId: 'other.com', maxConcurrent: 5 },
    });
    (fs.existsSync as any).mockReturnValue(true);
    (fs.readFileSync as any).mockReturnValue(JSON.stringify(bundle));

    const deps = makeDeps();
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await performImport('test.json', deps, { yes: true });

    expect(mockSetSitePolicy).not.toHaveBeenCalled();
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('does not match site'));
    consoleSpy.mockRestore();
  });

  it('new import with no overwrites skips confirmation even without --yes', async () => {
    // No existing site or skills → no confirmation required → import proceeds
    const bundle = makeBundle();
    (fs.existsSync as any).mockReturnValue(true);
    (fs.readFileSync as any).mockReturnValue(JSON.stringify(bundle));

    const deps = makeDeps();
    // No existing site/skills (defaults), so no confirmation prompt
    const result = await performImport('test.json', deps);
    expect(result.cancelled).toBeUndefined();
    expect(result.created).toBe(1);
    expect(deps.db.transaction).toHaveBeenCalledOnce();
  });
});
