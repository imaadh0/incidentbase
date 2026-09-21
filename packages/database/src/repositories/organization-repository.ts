import type { Organization, Prisma } from '../generated/prisma/client.js';

export class OrganizationRepository {
  public constructor(private readonly transaction: Prisma.TransactionClient) {}

  public findById(id: string): Promise<Organization | null> {
    return this.transaction.organization.findUnique({ where: { id } });
  }
}
