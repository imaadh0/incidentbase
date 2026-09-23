import { escalationJobPayloadSchema, type EscalationJobPayload } from '@incidentbase/contracts';
import type { WorkerUnitOfWork } from '@incidentbase/database';

import type { JobHandler } from './job-router.js';
import type { EscalationScheduler } from './escalation-scheduler.js';

export function createEscalationJobHandler(
  unitOfWork: WorkerUnitOfWork,
  scheduler: EscalationScheduler,
): JobHandler<EscalationJobPayload> {
  return {
    payloadSchema: escalationJobPayloadSchema,
    handle: async (envelope) => {
      const outcome = await unitOfWork.process({
        expectedDeadline: new Date(envelope.payload.expectedDeadline),
        expectedStep: envelope.payload.expectedStep,
        generation: envelope.payload.generation,
        incidentId: envelope.payload.incidentId,
        organizationId: envelope.organizationId,
      });
      if (outcome.outcome === 'ESCALATED') {
        await scheduler.schedule(outcome.next);
      }
    },
  };
}
