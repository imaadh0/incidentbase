import type { OrganizationMembership, Prisma } from '../generated/prisma/client.js';

export class MembershipRepository {
  public constructor(private readonly transaction: Prisma.TransactionClient) {}

  public findById(id: string): Promise<OrganizationMembership | null> {
    return this.transaction.organizationMembership.findFirst({ where: { id } });
  }

  public list(): Promise<OrganizationMembership[]> {
    return this.transaction.organizationMembership.findMany({ orderBy: { createdAt: 'asc' } });
  }

  public update(
    organizationId: string,
    id: string,
    data: Pick<Partial<OrganizationMembership>, 'role' | 'status'>,
  ): Promise<OrganizationMembership> {
    return this.transaction.organizationMembership.update({
      where: { organizationId_id: { id, organizationId } },
      data,
    });
  }

  public async delete(organizationId: string, id: string): Promise<void> {
    await this.transaction.organizationMembership.delete({
      where: { organizationId_id: { id, organizationId } },
    });
  }
}
