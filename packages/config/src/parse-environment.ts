import type { ZodType } from 'zod';
import { ZodError } from 'zod';

export class ConfigurationError extends Error {
  public readonly issues: readonly string[];

  public constructor(serviceName: string, issues: readonly string[]) {
    super(
      `Invalid ${serviceName} configuration:\n${issues.map((issue) => `- ${issue}`).join('\n')}`,
    );
    this.name = 'ConfigurationError';
    this.issues = issues;
  }
}

export function parseEnvironment<T>(
  serviceName: string,
  schema: ZodType<T>,
  environment: NodeJS.ProcessEnv,
): T {
  try {
    return schema.parse(environment);
  } catch (error: unknown) {
    if (error instanceof ZodError) {
      const issues = error.issues.map((issue) => {
        const field = issue.path.length > 0 ? issue.path.join('.') : 'environment';
        return `${field}: ${issue.message}`;
      });
      throw new ConfigurationError(serviceName, issues);
    }

    throw error;
  }
}
