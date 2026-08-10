import { pino } from 'pino';
import { env } from '../config/env.js';
import { redactPii } from './redact.js';

/**
 * Operational logger (distinct from per-turn execution Traces, which live in
 * src/trace). Pretty in dev, structured JSON everywhere else.
 *
 * PII/secrets are masked two ways: `redact.paths` masks known object keys, and a
 * `logMethod` hook masks emails/phones interpolated into free-text messages
 * (which `redact.paths` can't reach). Note: `name`/`title` are intentionally NOT
 * redacted as keys — they carry tool/model names, not PII.
 */
export const logger = pino({
  level: env.NODE_ENV === 'test' ? 'silent' : env.LOG_LEVEL,
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'req.headers["x-webhook-secret"]',
      'email',
      '*.email',
      '*.password',
      '*.secret',
      '*.token',
      '*.apiKey',
      '*.accessToken',
      '*.refreshToken',
      '*.privateToken',
    ],
    censor: '***MASKED***',
  },
  hooks: {
    logMethod(inputArgs: unknown[], method) {
      for (let i = 0; i < inputArgs.length; i++) {
        if (typeof inputArgs[i] === 'string') inputArgs[i] = redactPii(inputArgs[i] as string);
      }
      return method.apply(this, inputArgs as Parameters<typeof method>);
    },
  },
  transport:
    env.NODE_ENV === 'development'
      ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss.l' } }
      : undefined,
});

export type Logger = typeof logger;
