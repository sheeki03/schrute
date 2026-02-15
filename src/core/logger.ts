import pino from 'pino';

let logger: pino.Logger | null = null;

export function getLogger(): pino.Logger {
  if (!logger) {
    logger = createLogger('info');
  }
  return logger;
}

export function createLogger(level: string): pino.Logger {
  logger = pino({
    level,
    transport: process.env.NODE_ENV !== 'production'
      ? { target: 'pino-pretty', options: { colorize: true } }
      : undefined,
    base: { service: 'oneagent' },
    timestamp: pino.stdTimeFunctions.isoTime,
  });
  return logger;
}

export function setLogLevel(level: string): void {
  getLogger().level = level;
}
