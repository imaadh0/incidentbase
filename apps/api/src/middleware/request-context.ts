import { randomUUID } from 'node:crypto';

import type { RequestHandler } from 'express';
import type { Logger } from 'pino';
import { z } from 'zod';

const trustedRequestIdSchema = z.uuid();

export function createRequestContextMiddleware(logger: Logger): RequestHandler {
  return (request, response, next) => {
    const incomingRequestId = trustedRequestIdSchema.safeParse(request.header('x-request-id'));
    const requestId = incomingRequestId.success ? incomingRequestId.data : randomUUID();

    response.locals.requestId = requestId;
    response.locals.logger = logger.child({ requestId });
    response.setHeader('x-request-id', requestId);
    next();
  };
}
