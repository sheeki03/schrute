import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

let testDir: string;

export function setup() {
  testDir = path.join(os.tmpdir(), `schrute-test-${crypto.randomUUID()}`);
  fs.mkdirSync(path.join(testDir, 'data'), { recursive: true });
  process.env.SCHRUTE_DATA_DIR = testDir;
}

export function teardown() {
  if (testDir && testDir.includes('schrute-test-')) {
    fs.rmSync(testDir, { recursive: true, force: true });
  }
}
