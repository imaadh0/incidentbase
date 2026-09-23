import { randomUUID } from 'node:crypto';

import type { ErrorRequestHandler } from 'express';
import type { Logger } from 'pino';

import { ApplicationError } from '../errors/application-error.js';

export function createErrorHandler(baseLogger: Logger): ErrorRequestHandler {
  return (error: unknown, _request, response, _next) => {
    void _next;
    const logger = response.locals.logger ?? baseLogger;
    const requestId = response.locals.requestId ?? randomUUID();

    if (error instanceof ApplicationError) {
      logger.warn({ errorCode: error.code, statusCode: error.statusCode }, 'Request failed');
      response.status(error.statusCode).json({
        error: {
          code: error.code,
          ...(error.details === undefined ? {} : { details: error.details }),
          message: error.message,
          requestId,
        },
      });
      return;
    }

    logger.error({ err: error }, 'Unhandled request error');
    response.status(500).json({
      error: {
        code: 'INTERNAL_SERVER_ERROR',
        message: 'An unexpected error occurred.',
        requestId,
      },
    });
  };
}
