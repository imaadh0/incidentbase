import type { ErrorRequestHandler } from 'express';

import { ApplicationError } from '../errors/application-error.js';

export const errorHandler: ErrorRequestHandler = (error: unknown, _request, response, _next) => {
  void _next;

  if (error instanceof ApplicationError) {
    response.locals.logger.warn(
      { errorCode: error.code, statusCode: error.statusCode },
      'Request failed',
    );
    response.status(error.statusCode).json({
      error: {
        code: error.code,
        message: error.message,
        requestId: response.locals.requestId,
      },
    });
    return;
  }

  response.locals.logger.error({ err: error }, 'Unhandled request error');
  response.status(500).json({
    error: {
      code: 'INTERNAL_SERVER_ERROR',
      message: 'An unexpected error occurred.',
      requestId: response.locals.requestId,
    },
  });
};
