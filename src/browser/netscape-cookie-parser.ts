import * as fs from 'node:fs';
import { getLogger } from '../core/logger.js';

const log = getLogger();

const MAX_COOKIES = 500;

export interface NetscapeCookie {
  domain: string;
  includeSubdomains: boolean;
  path: string;
  secure: boolean;
  expires: number;
  name: string;
  value: string;
  httpOnly: boolean;
}

/**
 * Parse a Netscape/Mozilla cookie file from disk.
 *
 * Format: domain\tincludeSubdomains\tpath\tsecure\texpires\tname\tvalue
 * Lines starting with #HttpOnly_ are parsed as httpOnly cookies.
 * Other lines starting with # are comments. Empty lines are skipped.
 */
export function parseNetscapeCookieFile(filePath: string): NetscapeCookie[] {
  const content = fs.readFileSync(filePath, 'utf-8');
  return parseNetscapeCookieString(content);
}

export function parseNetscapeCookieString(content: string): NetscapeCookie[] {
  const cookies: NetscapeCookie[] = [];
  const lines = content.split('\n');

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line === '') continue;

    let httpOnly = false;
    let cookieLine = line;

    // #HttpOnly_ prefix → parse as httpOnly cookie (curl/libcurl convention)
    if (line.startsWith('#HttpOnly_')) {
      httpOnly = true;
      cookieLine = line.slice('#HttpOnly_'.length);
    } else if (line.startsWith('#')) {
      // Regular comment — skip
      continue;
    }

    const fields = cookieLine.split('\t');
    if (fields.length < 7) {
      // Malformed line — skip
      continue;
    }

    const [domain, includeSubdomains, cookiePath, secure, expires, name, ...valueParts] = fields;
    // Value may contain tabs — rejoin
    const value = valueParts.join('\t');

    cookies.push({
      domain,
      includeSubdomains: includeSubdomains.toUpperCase() === 'TRUE',
      path: cookiePath,
      secure: secure.toUpperCase() === 'TRUE',
      expires: parseInt(expires, 10) || 0,
      name,
      value,
      httpOnly,
    });

    if (cookies.length >= MAX_COOKIES) {
      log.warn({ max: MAX_COOKIES }, 'Cookie file exceeds max cookie count — excess dropped');
      break;
    }
  }

  return cookies;
}
