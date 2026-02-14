import * as crypto from 'node:crypto';
import type { IncomingMessage } from 'node:http';

/**
 * Verify a Bearer token from an HTTP request using timing-safe comparison.
 * Returns true if the token matches, false otherwise.
 */
export function verifyBearerToken(req: IncomingMessage, expectedToken: string): boolean {
  const auth = req.headers.authorization;
  if (!auth) return false;
  const match = auth.match(/^Bearer\s+(.+)$/i);
  if (!match) return false;
  const provided = Buffer.from(match[1]);
  const expected = Buffer.from(expectedToken);
  if (provided.length !== expected.length) return false;
  return crypto.timingSafeEqual(provided, expected);
}
