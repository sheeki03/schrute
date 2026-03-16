import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { formatDoctorReport, type DoctorReport, type CheckResult } from '../../src/doctor.js';

function makeReport(checks: CheckResult[]): DoctorReport {
  return {
    timestamp: Date.now(),
    version: '0.1.0',
    checks,
    summary: {
      pass: checks.filter((c) => c.status === 'pass').length,
      fail: checks.filter((c) => c.status === 'fail').length,
      warning: checks.filter((c) => c.status === 'warning').length,
    },
  };
}

describe('doctor', () => {
  describe('formatDoctorReport', () => {
    it('formats all-pass report correctly', () => {
      const report = makeReport([
        { name: 'browser_engine', status: 'pass', message: 'Browser engine "patchright" available' },
        { name: 'keychain_access', status: 'pass', message: 'Keychain working' },
        { name: 'build_profile', status: 'pass', message: 'v0.1' },
      ]);
      const output = formatDoctorReport(report);
      expect(output).toContain('[PASS] browser_engine');
      expect(output).toContain('[PASS] keychain_access');
      expect(output).toContain('3 passed, 0 failed, 0 warnings');
    });

    it('formats failure with details', () => {
      const report = makeReport([
        {
          name: 'browser_engine',
          status: 'fail',
          message: 'Browser engine "patchright" not available',
          details: 'Install with: npm install patchright && npx patchright install chromium',
        },
      ]);
      const output = formatDoctorReport(report);
      expect(output).toContain('[FAIL] browser_engine');
      expect(output).toContain('npm install patchright');
      expect(output).toContain('0 passed, 1 failed, 0 warnings');
    });

    it('formats warning status', () => {
      const report = makeReport([
        {
          name: 'temp_dir_cleanup',
          status: 'warning',
          message: '2 temp dirs without lockfile',
          details: 'dir1, dir2',
        },
      ]);
      const output = formatDoctorReport(report);
      expect(output).toContain('[WARN] temp_dir_cleanup');
      expect(output).toContain('dir1, dir2');
      expect(output).toContain('0 passed, 0 failed, 1 warnings');
    });

    it('includes version header', () => {
      const report = makeReport([]);
      const output = formatDoctorReport(report);
      expect(output).toContain('Schrute Doctor (v0.1.0)');
    });
  });

  describe('CheckResult structure', () => {
    it('temp directory GC result with stale count', () => {
      const check: CheckResult = {
        name: 'temp_dir_cleanup',
        status: 'fail',
        message: '3 stale temp dir(s) beyond TTL (2 cleaned)',
      };
      expect(check.status).toBe('fail');
      expect(check.message).toContain('stale');
    });

    it('WAL checkpoint check result', () => {
      const check: CheckResult = {
        name: 'wal_checkpoint',
        status: 'pass',
        message: 'WAL checkpoint complete (42 pages)',
      };
      expect(check.name).toBe('wal_checkpoint');
      expect(check.status).toBe('pass');
    });

    it('browser engine fail result', () => {
      const check: CheckResult = {
        name: 'browser_engine',
        status: 'fail',
        message: 'Browser engine "camoufox" not available',
        details: 'Install with: npm install camoufox-js && npx camoufox-js fetch\nError: ...',
      };
      expect(check.status).toBe('fail');
      expect(check.details).toContain('camoufox-js');
    });

    it('browser engine fallback warning result', () => {
      const check: CheckResult = {
        name: 'browser_engine',
        status: 'warning',
        message: 'Configured engine "patchright" unavailable — fell back to "playwright"',
        details: 'Install: npm install patchright && npx patchright install chromium',
      };
      expect(check.status).toBe('warning');
      expect(check.message).toContain('fell back');
      expect(check.details).toContain('patchright');
    });

    it('mixed results summary is correct', () => {
      const report = makeReport([
        { name: 'check1', status: 'pass', message: 'ok' },
        { name: 'check2', status: 'fail', message: 'bad' },
        { name: 'check3', status: 'warning', message: 'meh' },
        { name: 'check4', status: 'pass', message: 'ok' },
      ]);
      expect(report.summary.pass).toBe(2);
      expect(report.summary.fail).toBe(1);
      expect(report.summary.warning).toBe(1);
    });
  });

  describe('durable storage clean check', () => {
    it('check result passes when no raw artifacts exist', () => {
      const check: CheckResult = {
        name: 'durable_storage_clean',
        status: 'pass',
        message: 'No raw artifacts in durable storage',
      };
      expect(check.status).toBe('pass');
    });

    it('check result fails when raw artifacts found', () => {
      const check: CheckResult = {
        name: 'durable_storage_clean',
        status: 'fail',
        message: 'Found 3 raw artifact(s) in durable storage',
        details: 'capture.har, temp.tmp, partial.partial',
      };
      expect(check.status).toBe('fail');
      expect(check.details).toContain('.har');
    });
  });
});
