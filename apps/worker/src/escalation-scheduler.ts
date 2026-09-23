import { randomUUID } from 'node:crypto';

import type { Queue } from 'bullmq';

import type { EscalationExpectation, ReconciliationCandidate } from '@incidentbase/database';

export const ESCALATION_JOB_NAME = 'incident.escalate';

interface ReconciliationSource {
  reconciliationCandidates: (horizon: Date, limit?: number) => Promise<ReconciliationCandidate[]>;
}

export class EscalationScheduler {
  public constructor(
    private readonly queue: Queue,
    private readonly unitOfWork: ReconciliationSource,
    private readonly scheduleHorizonSeconds: number,
  ) {}

  public async schedule(expectation: EscalationExpectation): Promise<void> {
    const delay = Math.max(0, expectation.expectedDeadline.getTime() - Date.now());
    await this.queue.add(
      ESCALATION_JOB_NAME,
      {
        organizationId: expectation.organizationId,
        payload: {
          expectedDeadline: expectation.expectedDeadline.toISOString(),
          expectedStep: expectation.expectedStep,
          generation: expectation.generation,
          incidentId: expectation.incidentId,
        },
        requestId: randomUUID(),
        version: 1,
      },
      {
        attempts: 5,
        backoff: { delay: 1_000, type: 'exponential' },
        delay,
        jobId: escalationJobId(expectation),
        removeOnComplete: true,
        removeOnFail: { count: 1_000 },
      },
    );
  }

  public async reconcile(): Promise<number> {
    const horizon = new Date(Date.now() + this.scheduleHorizonSeconds * 1_000);
    const candidates = await this.unitOfWork.reconciliationCandidates(horizon);
    await Promise.all(candidates.map((candidate) => this.schedule(candidate)));
    return candidates.length;
  }
}

export function escalationJobId(expectation: EscalationExpectation): string {
  return [
    'escalate',
    expectation.incidentId,
    expectation.generation,
    expectation.expectedStep,
    expectation.expectedDeadline.getTime(),
  ].join('_');
}
