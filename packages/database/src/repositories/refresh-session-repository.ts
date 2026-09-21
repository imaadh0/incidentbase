import type { Prisma, RefreshSession } from '../generated/prisma/client.js';

export class RefreshSessionRepository {
  public constructor(private readonly transaction: Prisma.TransactionClient) {}

  public findById(id: string): Promise<RefreshSession | null> {
    return this.transaction.refreshSession.findFirst({ where: { id } });
  }
}
