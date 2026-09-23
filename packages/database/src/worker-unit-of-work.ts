import type { Prisma } from './generated/prisma/client.js';
import type { DatabaseClient } from './client.js';
import {
  EscalationRepository,
  type EscalationExpectation,
  type EscalationOutcome,
  type ReconciliationCandidate,
} from './repositories/escalation-repository.js';

export interface WorkerOrganizationContext {
  organizationId: string;
}

export interface WorkerTransaction {
  escalation: EscalationRepository;
  transaction: Prisma.TransactionClient;
}

export class WorkerUnitOfWork {
  public constructor(private readonly client: DatabaseClient) {}

  public withOrganization<T>(
    context: WorkerOrganizationContext,
    operation: (worker: WorkerTransaction) => Promise<T>,
  ): Promise<T> {
    return this.client.$transaction(async (transaction) => {
      await transaction.$executeRawUnsafe('SET LOCAL ROLE incidentbase_worker');
      await transaction.$queryRaw`
        SELECT set_config('app.current_organization_id', ${context.organizationId}, true)
      `;
      return operation({
        escalation: new EscalationRepository(transaction, context.organizationId),
        transaction,
      });
    });
  }

  public process(expectation: EscalationExpectation): Promise<EscalationOutcome> {
    return this.withOrganization({ organizationId: expectation.organizationId }, (worker) =>
      worker.escalation.process(expectation),
    );
  }

  public reconciliationCandidates(
    horizon: Date,
    limit = 1_000,
  ): Promise<ReconciliationCandidate[]> {
    return this.client.$queryRaw<ReconciliationCandidate[]>`
      SELECT organization_id AS "organizationId",
             incident_id AS "incidentId",
             escalation_generation AS "generation",
             current_escalation_step AS "expectedStep",
             next_escalation_at AS "expectedDeadline"
      FROM app.worker_reconciliation_candidates(${horizon}, ${limit})
    `;
  }
}
