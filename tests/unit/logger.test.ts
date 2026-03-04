import { describe, it, expect, vi, beforeEach } from 'vitest';

describe('logger', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  describe('createLogger', () => {
    it('accepts valid pino log levels without throwing', async () => {
      const { createLogger } = await import('../../src/core/logger.js');
      const validLevels = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'];
      for (const level of validLevels) {
        expect(() => createLogger(level)).not.toThrow();
      }
    });

    it('falls back to "info" for invalid log level', async () => {
      const { createLogger } = await import('../../src/core/logger.js');
      // This previously threw: "default level:42 must be included in custom levels"
      const logger = createLogger('42');
      expect(logger.level).toBe('info');
    });

    it('falls back to "info" for empty string log level', async () => {
      const { createLogger } = await import('../../src/core/logger.js');
      const logger = createLogger('');
      expect(logger.level).toBe('info');
    });

    it('falls back to "info" for nonsense log level', async () => {
      const { createLogger } = await import('../../src/core/logger.js');
      const logger = createLogger('banana');
      expect(logger.level).toBe('info');
    });

    it('uses the requested level when valid', async () => {
      const { createLogger } = await import('../../src/core/logger.js');
      const logger = createLogger('debug');
      expect(logger.level).toBe('debug');
    });
  });
});
