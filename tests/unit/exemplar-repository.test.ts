import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { AgentDatabase } from '../../src/storage/database.js';
import { ExemplarRepository, type SkillExemplar } from '../../src/storage/exemplar-repository.js';

describe('ExemplarRepository', () => {
  let db: AgentDatabase;
  let repo: ExemplarRepository;
  const testDataDir = '/tmp/schrute-exemplar-test-' + Math.random().toString(36).slice(2);

  beforeEach(() => {
    db = new AgentDatabase({
      dataDir: testDataDir,
      daemon: { port: 19420, autoStart: false },
    } as any);
    db.open();
    repo = new ExemplarRepository(db);
  });

  afterEach(() => {
    db.close();
    try {
      const fs = require('node:fs');
      fs.rmSync(testDataDir, { recursive: true });
    } catch {}
  });

  function makeExemplar(overrides?: Partial<SkillExemplar>): SkillExemplar {
    return {
      skillId: 'example.com.get_users.v1',
      responseStatus: 200,
      responseSchemaHash: 'abc123',
      redactedResponseBody: '{"users":[]}',
      capturedAt: Date.now(),
      ...overrides,
    };
  }

  it('saves and retrieves an exemplar', () => {
    repo.save(makeExemplar());
    const result = repo.get('example.com.get_users.v1');
    expect(result).toBeDefined();
    expect(result!.responseStatus).toBe(200);
    expect(result!.redactedResponseBody).toBe('{"users":[]}');
  });

  it('overwrites previous exemplar on save', () => {
    repo.save(makeExemplar({ redactedResponseBody: 'old' }));
    repo.save(makeExemplar({ redactedResponseBody: 'new' }));
    const result = repo.get('example.com.get_users.v1');
    expect(result!.redactedResponseBody).toBe('new');
  });

  it('returns undefined for non-existent skill', () => {
    expect(repo.get('nonexistent')).toBeUndefined();
  });

  it('deletes an exemplar', () => {
    repo.save(makeExemplar());
    repo.delete('example.com.get_users.v1');
    expect(repo.get('example.com.get_users.v1')).toBeUndefined();
  });

  it('prunes old exemplars', () => {
    const old = Date.now() - 100_000;
    repo.save(makeExemplar({ capturedAt: old }));
    repo.save(makeExemplar({ skillId: 'other.v1', capturedAt: Date.now() }));

    const pruned = repo.pruneOlderThan(Date.now() - 50_000);
    expect(pruned).toBe(1);
    expect(repo.get('example.com.get_users.v1')).toBeUndefined();
    expect(repo.get('other.v1')).toBeDefined();
  });
});
