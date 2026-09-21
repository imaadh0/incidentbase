import type { OrganizationInvitation, Prisma } from '../generated/prisma/client.js';

export class InvitationRepository {
  public constructor(private readonly transaction: Prisma.TransactionClient) {}

  public findById(id: string): Promise<OrganizationInvitation | null> {
    return this.transaction.organizationInvitation.findFirst({ where: { id } });
  }
}
