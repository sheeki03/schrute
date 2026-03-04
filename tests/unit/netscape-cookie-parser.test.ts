import { describe, it, expect, vi } from 'vitest';

vi.mock('../../src/core/logger.js', () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { parseNetscapeCookieString } from '../../src/browser/netscape-cookie-parser.js';

describe('Netscape Cookie Parser', () => {
  it('parses standard cookie file', () => {
    const content = [
      '# Netscape HTTP Cookie File',
      '.example.com\tTRUE\t/\tTRUE\t1700000000\tsession_id\tabc123',
      'api.example.com\tFALSE\t/api\tFALSE\t0\tapi_key\txyz789',
    ].join('\n');

    const cookies = parseNetscapeCookieString(content);
    expect(cookies).toHaveLength(2);

    expect(cookies[0]).toEqual({
      domain: '.example.com',
      includeSubdomains: true,
      path: '/',
      secure: true,
      expires: 1700000000,
      name: 'session_id',
      value: 'abc123',
      httpOnly: false,
    });

    expect(cookies[1]).toEqual({
      domain: 'api.example.com',
      includeSubdomains: false,
      path: '/api',
      secure: false,
      expires: 0,
      name: 'api_key',
      value: 'xyz789',
      httpOnly: false,
    });
  });

  it('skips comments', () => {
    const content = [
      '# This is a comment',
      '# Another comment',
      '.example.com\tTRUE\t/\tFALSE\t0\tname\tvalue',
    ].join('\n');

    const cookies = parseNetscapeCookieString(content);
    expect(cookies).toHaveLength(1);
    expect(cookies[0].name).toBe('name');
  });

  it('skips malformed lines (fewer than 7 fields)', () => {
    const content = [
      '.example.com\tTRUE\t/\tFALSE',  // only 4 fields
      '.example.com\tTRUE\t/\tFALSE\t0\tname\tvalue', // valid
    ].join('\n');

    const cookies = parseNetscapeCookieString(content);
    expect(cookies).toHaveLength(1);
    expect(cookies[0].name).toBe('name');
  });

  it('handles #HttpOnly_ prefix', () => {
    const content = '#HttpOnly_.example.com\tTRUE\t/\tTRUE\t1700000000\tsecure_cookie\tsecret';

    const cookies = parseNetscapeCookieString(content);
    expect(cookies).toHaveLength(1);
    expect(cookies[0]).toEqual({
      domain: '.example.com',
      includeSubdomains: true,
      path: '/',
      secure: true,
      expires: 1700000000,
      name: 'secure_cookie',
      value: 'secret',
      httpOnly: true,
    });
  });

  it('handles empty file', () => {
    const cookies = parseNetscapeCookieString('');
    expect(cookies).toHaveLength(0);
  });

  it('handles empty lines', () => {
    const content = [
      '',
      '.example.com\tTRUE\t/\tFALSE\t0\tname\tvalue',
      '',
      '',
    ].join('\n');

    const cookies = parseNetscapeCookieString(content);
    expect(cookies).toHaveLength(1);
  });

  it('handles value containing tabs', () => {
    const content = '.example.com\tTRUE\t/\tFALSE\t0\tname\tval\twith\ttabs';

    const cookies = parseNetscapeCookieString(content);
    expect(cookies).toHaveLength(1);
    expect(cookies[0].value).toBe('val\twith\ttabs');
  });

  it('caps at 500 cookies', () => {
    const lines: string[] = [];
    for (let i = 0; i < 501; i++) {
      lines.push(`.example.com\tTRUE\t/\tFALSE\t0\tcookie${i}\tvalue${i}`);
    }
    const content = lines.join('\n');

    const cookies = parseNetscapeCookieString(content);
    expect(cookies).toHaveLength(500);
  });
});
