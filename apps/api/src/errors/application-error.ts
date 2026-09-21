export interface ApplicationErrorOptions {
  cause?: unknown;
  code: string;
  message: string;
  statusCode: number;
}

export class ApplicationError extends Error {
  public readonly code: string;
  public readonly statusCode: number;

  public constructor(options: ApplicationErrorOptions) {
    super(options.message, { cause: options.cause });
    this.name = 'ApplicationError';
    this.code = options.code;
    this.statusCode = options.statusCode;
  }
}
