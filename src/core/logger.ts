import pino from 'pino';

let logger: pino.Logger | null = null;

export function getLogger(): pino.Logger {
  if (!logger) {
    logger = createLogger('info');
  }
  return logger;
}

const VALID_PINO_LEVELS = new Set(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']);

export function createLogger(level: string): pino.Logger {
  // MCP stdio transport uses stdout for JSON-RPC — logger MUST write to stderr
  const destination = pino.destination({ dest: 2, sync: false });
  const safeLevel = VALID_PINO_LEVELS.has(level) ? level : 'info';
  logger = pino({
    level: safeLevel,
    transport: process.env.NODE_ENV !== 'production'
      ? { target: 'pino-pretty', options: { colorize: true, destination: 2 } }
      : undefined,
    base: { service: 'oneagent' },
    timestamp: pino.stdTimeFunctions.isoTime,
  }, process.env.NODE_ENV === 'production' ? destination : undefined);
  return logger;
}

export function setLogLevel(level: string): void {
  getLogger().level = level;
}
