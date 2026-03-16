import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';

/**
 * Write file atomically: write to temp file in same directory, then rename.
 * Prevents partial/corrupt writes on crash.
 */
export function writeFileAtomically(filePath: string, content: string, options?: { mode?: number }): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpName = `.${path.basename(filePath)}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  const tmpPath = path.join(dir, tmpName);

  try {
    fs.writeFileSync(tmpPath, content, { encoding: 'utf-8', mode: options?.mode ?? 0o644 });
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    // Clean up temp file on failure
    try { fs.unlinkSync(tmpPath); } catch { /* best effort */ }
    throw err;
  }
}
