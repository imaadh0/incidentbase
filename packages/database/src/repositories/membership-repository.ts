import type { OrganizationMembership, Prisma } from '../generated/prisma/client.js';

export class MembershipRepository {
  public constructor(private readonly transaction: Prisma.TransactionClient) {}

  public findById(id: string): Promise<OrganizationMembership | null> {
    return this.transaction.organizationMembership.findFirst({ where: { id } });
  }

  public list(): Promise<OrganizationMembership[]> {
    return this.transaction.organizationMembership.findMany({ orderBy: { createdAt: 'asc' } });
  }
}
