import type { Logger } from 'pino';

declare global {
  namespace Express {
    interface Locals {
      logger: Logger;
      requestId: string;
    }
  }
}

export {};
