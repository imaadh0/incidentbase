import { z } from 'zod';

export const jobEnvelopeSchema = z.object({
  organizationId: z.uuid(),
  payload: z.unknown(),
  requestId: z.uuid(),
  version: z.literal(1),
});

export type JobEnvelope = z.infer<typeof jobEnvelopeSchema>;
