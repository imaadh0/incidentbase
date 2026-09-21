import { PrismaPg } from '@prisma/adapter-pg';

import { PrismaClient } from './generated/prisma/client.js';

export type DatabaseClient = PrismaClient;

export interface CreateDatabaseClientOptions {
  connectionString: string;
}

export function createDatabaseClient(options: CreateDatabaseClientOptions): DatabaseClient {
  return new PrismaClient({
    adapter: new PrismaPg({ connectionString: options.connectionString }),
  });
}
