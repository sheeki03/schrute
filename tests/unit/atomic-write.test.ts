import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { writeFileAtomically } from '../../src/shared/atomic-write.js';

describe('writeFileAtomically', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atomic-write-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('writes file and reads back correctly', () => {
    const filePath = path.join(tmpDir, 'test.json');
    const content = JSON.stringify({ hello: 'world' }, null, 2);

    writeFileAtomically(filePath, content);

    expect(fs.readFileSync(filePath, 'utf-8')).toBe(content);
  });

  it('overwrites existing file atomically', () => {
    const filePath = path.join(tmpDir, 'existing.json');
    fs.writeFileSync(filePath, 'original content');

    writeFileAtomically(filePath, 'new content');

    expect(fs.readFileSync(filePath, 'utf-8')).toBe('new content');
  });

  it('does not leave temp files on success', () => {
    const filePath = path.join(tmpDir, 'clean.json');
    writeFileAtomically(filePath, 'data');

    const files = fs.readdirSync(tmpDir);
    expect(files).toEqual(['clean.json']);
  });

  it('creates parent directories if they do not exist', () => {
    const filePath = path.join(tmpDir, 'nonexistent', 'file.json');

    writeFileAtomically(filePath, 'data');

    expect(fs.readFileSync(filePath, 'utf-8')).toBe('data');
    // No temp files should be left behind
    const files = fs.readdirSync(path.join(tmpDir, 'nonexistent'));
    expect(files.filter(f => f.endsWith('.tmp'))).toEqual([]);
  });

  it('creates deeply nested directories', () => {
    const filePath = path.join(tmpDir, 'a', 'b', 'c', 'file.json');

    writeFileAtomically(filePath, 'nested');

    expect(fs.readFileSync(filePath, 'utf-8')).toBe('nested');
  });

  it('respects mode option', () => {
    const filePath = path.join(tmpDir, 'mode.json');
    writeFileAtomically(filePath, 'secret', { mode: 0o600 });

    const stat = fs.statSync(filePath);
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it('uses default mode 0o644 when no mode specified', () => {
    const filePath = path.join(tmpDir, 'default-mode.json');
    writeFileAtomically(filePath, 'content');

    const stat = fs.statSync(filePath);
    expect(stat.mode & 0o777).toBe(0o644);
  });
});
