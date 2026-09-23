import { z } from 'zod';

export const jobEnvelopeSchema = z.object({
  organizationId: z.uuid(),
  payload: z.unknown(),
  requestId: z.uuid(),
  version: z.literal(1),
});

export type JobEnvelope = z.infer<typeof jobEnvelopeSchema>;

export const escalationJobPayloadSchema = z.object({
  expectedDeadline: z.iso.datetime({ offset: true }),
  expectedStep: z.number().int().min(-1),
  generation: z.number().int().nonnegative(),
  incidentId: z.uuid(),
});

export type EscalationJobPayload = z.infer<typeof escalationJobPayloadSchema>;
