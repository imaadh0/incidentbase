import type { Logger } from 'pino';

interface ShutdownOptions {
  close: () => Promise<void>;
  logger: Logger;
  timeoutMs: number;
}

export function registerShutdownHandlers(options: ShutdownOptions): void {
  let shutdownPromise: Promise<void> | undefined;

  const shutdown = (reason: string, exitCode: number, error?: unknown): Promise<void> => {
    shutdownPromise ??= (async () => {
      if (error === undefined) {
        options.logger.info({ reason }, 'Graceful shutdown started');
      } else {
        options.logger.fatal({ err: error, reason }, 'Fatal process error initiated shutdown');
      }

      const timeout = setTimeout(() => {
        options.logger.fatal('Graceful shutdown timed out');
        process.exitCode = 1;
      }, options.timeoutMs);
      timeout.unref();

      try {
        await options.close();
        process.exitCode = exitCode;
      } catch (shutdownError: unknown) {
        options.logger.fatal({ err: shutdownError }, 'Graceful shutdown failed');
        process.exitCode = 1;
      } finally {
        clearTimeout(timeout);
      }
    })();

    return shutdownPromise;
  };

  process.once('SIGTERM', () => void shutdown('SIGTERM', 0));
  process.once('SIGINT', () => void shutdown('SIGINT', 0));
  process.once('uncaughtException', (error) => void shutdown('uncaughtException', 1, error));
  process.once('unhandledRejection', (error) => void shutdown('unhandledRejection', 1, error));
}
