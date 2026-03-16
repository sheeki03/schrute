import { describe, it, expect, vi } from 'vitest';

// ─── Mock logger ─────────────────────────────────────────────────
vi.mock('../../src/core/logger.js', () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { scanSkill } from '../../src/skill/security-scanner.js';

function makeCleanSkill() {
  return {
    pathTemplate: '/api/users/{id}',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } } },
  };
}

describe('Security Scanner', () => {
  it('returns safe for clean skill', () => {
    const result = scanSkill(makeCleanSkill());
    expect(result.safe).toBe(true);
    expect(result.findings).toHaveLength(0);
  });

  describe('SQL injection', () => {
    it('detects DROP statement', () => {
      const result = scanSkill({
        ...makeCleanSkill(),
        pathTemplate: '/api/users; DROP TABLE users',
      });
      expect(result.safe).toBe(false);
      expect(result.findings.some(f => f.category === 'sql_injection')).toBe(true);
    });

    it('detects DELETE statement', () => {
      const result = scanSkill({
        ...makeCleanSkill(),
        pathTemplate: '/api/users; DELETE FROM sessions',
      });
      expect(result.safe).toBe(false);
      expect(result.findings.some(f => f.category === 'sql_injection')).toBe(true);
    });
  });

  describe('XSS', () => {
    it('detects script tags', () => {
      const result = scanSkill({
        ...makeCleanSkill(),
        skillMd: 'Some text <script>alert(1)</script>',
      });
      expect(result.safe).toBe(false);
      expect(result.findings.some(f => f.category === 'xss' && f.detail.includes('Script tag'))).toBe(true);
    });

    it('detects javascript: URI', () => {
      const result = scanSkill({
        ...makeCleanSkill(),
        pathTemplate: 'javascript:void(0)',
      });
      expect(result.safe).toBe(false);
      expect(result.findings.some(f => f.category === 'xss' && f.detail.includes('JavaScript URI'))).toBe(true);
    });
  });

  describe('path traversal', () => {
    it('detects ../ patterns', () => {
      const result = scanSkill({
        ...makeCleanSkill(),
        pathTemplate: '/api/../../etc/passwd',
      });
      expect(result.safe).toBe(false);
      expect(result.findings.some(f => f.category === 'path_traversal')).toBe(true);
    });
  });

  describe('template injection', () => {
    it('detects template literals', () => {
      const result = scanSkill({
        ...makeCleanSkill(),
        // Use a string that contains ${...} pattern
        pathTemplate: '/api/users/$' + '{user.id}',
      });
      expect(result.safe).toBe(false);
      expect(result.findings.some(f => f.category === 'template_injection')).toBe(true);
    });
  });

  describe('code injection', () => {
    // Note: These test strings intentionally contain dangerous patterns
    // because the scanner's job is to DETECT them, not execute them.

    it('detects eval() call', () => {
      const result = scanSkill({
        ...makeCleanSkill(),
        skillMd: 'Use eval (data) to parse',
      });
      expect(result.safe).toBe(false);
      expect(result.findings.some(f => f.category === 'code_injection')).toBe(true);
    });

    it('detects Function constructor', () => {
      const result = scanSkill({
        ...makeCleanSkill(),
        // The scanner detects "Function (" pattern — testing that detection
        skillMd: 'new Function ("return x")',
      });
      expect(result.safe).toBe(false);
      expect(result.findings.some(f => f.category === 'code_injection')).toBe(true);
    });

    it('detects dynamic import', () => {
      const result = scanSkill({
        ...makeCleanSkill(),
        skillMd: 'import ("module")',
      });
      expect(result.safe).toBe(false);
      expect(result.findings.some(f => f.category === 'code_injection')).toBe(true);
    });

    it('detects dynamic require', () => {
      const result = scanSkill({
        ...makeCleanSkill(),
        skillMd: 'require ("module")',
      });
      expect(result.safe).toBe(false);
      expect(result.findings.some(f => f.category === 'code_injection')).toBe(true);
    });
  });

  describe('prototype pollution', () => {
    it('detects __proto__', () => {
      const result = scanSkill({
        ...makeCleanSkill(),
        skillMd: 'Access obj.__proto__ to modify prototype',
      });
      expect(result.safe).toBe(false);
      expect(result.findings.some(f => f.category === 'prototype_pollution')).toBe(true);
    });

    it('detects constructor.prototype', () => {
      const result = scanSkill({
        ...makeCleanSkill(),
        skillMd: 'Access constructor.prototype to modify',
      });
      expect(result.safe).toBe(false);
      expect(result.findings.some(f => f.category === 'prototype_pollution')).toBe(true);
    });
  });

  describe('SSRF', () => {
    it('detects file:// URI', () => {
      const result = scanSkill({
        ...makeCleanSkill(),
        pathTemplate: 'file:///etc/passwd',
      });
      expect(result.safe).toBe(false);
      expect(result.findings.some(f => f.category === 'ssrf')).toBe(true);
    });

    it('detects cloud metadata endpoint', () => {
      const result = scanSkill({
        ...makeCleanSkill(),
        pathTemplate: 'http://169.254.169.254/latest/meta-data/',
      });
      expect(result.safe).toBe(false);
      expect(result.findings.some(f => f.category === 'ssrf' && f.severity === 'critical')).toBe(true);
    });

    it('detects Google metadata endpoint', () => {
      const result = scanSkill({
        ...makeCleanSkill(),
        pathTemplate: 'http://metadata.google.internal/computeMetadata/v1/',
      });
      expect(result.safe).toBe(false);
      expect(result.findings.some(f => f.category === 'ssrf')).toBe(true);
    });
  });

  describe('credential exposure', () => {
    it('detects hardcoded password', () => {
      const result = scanSkill({
        ...makeCleanSkill(),
        requiredHeaders: { 'X-Auth': "password = 'hunter2'" },
      });
      expect(result.safe).toBe(false);
      expect(result.findings.some(f => f.category === 'credential_exposure')).toBe(true);
    });

    it('detects hardcoded api_key', () => {
      const result = scanSkill({
        ...makeCleanSkill(),
        skillMd: 'Set api_key = "abc123" in header',
      });
      expect(result.safe).toBe(false);
      expect(result.findings.some(f => f.category === 'credential_exposure')).toBe(true);
    });
  });

  describe('field scanning', () => {
    it('scans outputSchema', () => {
      const result = scanSkill({
        ...makeCleanSkill(),
        outputSchema: { description: '<script>alert(1)</script>' },
      });
      expect(result.safe).toBe(false);
      expect(result.findings.some(f => f.field === 'outputSchema')).toBe(true);
    });

    it('scans requiredHeaders', () => {
      const result = scanSkill({
        ...makeCleanSkill(),
        requiredHeaders: { 'X-Redirect': 'javascript:void(0)' },
      });
      expect(result.safe).toBe(false);
      expect(result.findings.some(f => f.field === 'requiredHeaders')).toBe(true);
    });

    it('scans dynamicHeaders', () => {
      const result = scanSkill({
        ...makeCleanSkill(),
        dynamicHeaders: { 'X-Data': 'file:///etc/shadow' },
      });
      expect(result.safe).toBe(false);
      expect(result.findings.some(f => f.field === 'dynamicHeaders')).toBe(true);
    });

    it('scans skillMd', () => {
      const result = scanSkill({
        ...makeCleanSkill(),
        skillMd: 'Navigate to 169.254.169.254 for metadata',
      });
      expect(result.safe).toBe(false);
      expect(result.findings.some(f => f.field === 'skillMd')).toBe(true);
    });
  });

  describe('severity classification', () => {
    it('classifies SQL injection as critical', () => {
      const result = scanSkill({
        ...makeCleanSkill(),
        pathTemplate: '/api; DROP TABLE x',
      });
      const finding = result.findings.find(f => f.category === 'sql_injection');
      expect(finding?.severity).toBe('critical');
    });

    it('classifies path traversal as high', () => {
      const result = scanSkill({
        ...makeCleanSkill(),
        pathTemplate: '/api/../secret',
      });
      const finding = result.findings.find(f => f.category === 'path_traversal');
      expect(finding?.severity).toBe('high');
    });
  });

  it('returns multiple findings for multiple violations', () => {
    const result = scanSkill({
      pathTemplate: '/api/../../../etc; DROP TABLE users',
      inputSchema: {},
      skillMd: '<script>alert(1)</script> file:///etc/shadow',
    });
    expect(result.safe).toBe(false);
    expect(result.findings.length).toBeGreaterThanOrEqual(3);
    const categories = new Set(result.findings.map(f => f.category));
    expect(categories.has('path_traversal')).toBe(true);
    expect(categories.has('sql_injection')).toBe(true);
    expect(categories.has('xss')).toBe(true);
  });
});
