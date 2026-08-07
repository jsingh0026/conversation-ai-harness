import { pino } from 'pino';
import { env } from '../config/env.js';

/**
 * Operational logger (distinct from per-turn execution Traces, which live in
 * src/trace). Pretty in dev, structured JSON everywhere else.
 */
export const logger = pino({
  level: env.LOG_LEVEL,
  transport:
    env.NODE_ENV === 'development'
      ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss.l' } }
      : undefined,
});

export type Logger = typeof logger;
