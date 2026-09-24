import type { OrganizationMembership, Prisma } from '../generated/prisma/client.js';

export interface MembershipDirectoryEntry {
  displayName: string;
  id: string;
  organizationId: string;
  role: OrganizationMembership['role'];
  status: OrganizationMembership['status'];
  userId: string;
}

export class MembershipRepository {
  public constructor(private readonly transaction: Prisma.TransactionClient) {}

  public findById(id: string): Promise<OrganizationMembership | null> {
    return this.transaction.organizationMembership.findFirst({ where: { id } });
  }

  public list(): Promise<MembershipDirectoryEntry[]> {
    return this.transaction.$queryRaw<MembershipDirectoryEntry[]>`
      SELECT membership_id AS id,
             organization_id AS "organizationId",
             user_id AS "userId",
             display_name AS "displayName",
             role,
             status
      FROM app.tenant_member_directory(app.current_organization_id())
    `;
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
