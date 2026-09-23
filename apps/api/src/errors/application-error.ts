export interface ApplicationErrorOptions {
  cause?: unknown;
  code: string;
  details?: unknown;
  message: string;
  statusCode: number;
}

export class ApplicationError extends Error {
  public readonly code: string;
  public readonly details?: unknown;
  public readonly statusCode: number;

  public constructor(options: ApplicationErrorOptions) {
    super(options.message, { cause: options.cause });
    this.name = 'ApplicationError';
    this.code = options.code;
    this.details = options.details;
    this.statusCode = options.statusCode;
  }
}
