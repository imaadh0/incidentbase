import pino, { type Logger } from 'pino';

const redactedPaths = [
  'password',
  '*.password',
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers.set-cookie',
  '*.accessToken',
  '*.refreshToken',
  '*.invitationToken',
  '*.webhookUrl',
  '*.apiKey',
];

export interface LoggerConfiguration {
  level: string;
  service: string;
}

export function createLogger(configuration: LoggerConfiguration): Logger {
  return pino({
    base: { service: configuration.service },
    level: configuration.level,
    redact: {
      paths: redactedPaths,
      censor: '[REDACTED]',
    },
    timestamp: pino.stdTimeFunctions.isoTime,
  });
}
