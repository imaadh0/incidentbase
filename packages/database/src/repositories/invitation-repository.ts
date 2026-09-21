import type { OrganizationInvitation, Prisma } from '../generated/prisma/client.js';

export class InvitationRepository {
  public constructor(private readonly transaction: Prisma.TransactionClient) {}

  public findById(id: string): Promise<OrganizationInvitation | null> {
    return this.transaction.organizationInvitation.findFirst({ where: { id } });
  }

  public create(input: {
    email: string;
    expiresAt: Date;
    invitedByUserId: string;
    organizationId: string;
    role: OrganizationInvitation['role'];
    tokenHash: string;
  }): Promise<OrganizationInvitation> {
    return this.transaction.organizationInvitation.create({ data: input });
  }
}
