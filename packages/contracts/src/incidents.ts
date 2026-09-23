import { z } from 'zod';

export const incidentSeveritySchema = z.enum(['SEV1', 'SEV2', 'SEV3', 'SEV4']);
export const incidentStatusSchema = z.enum(['OPEN', 'ACKNOWLEDGED', 'INVESTIGATING', 'RESOLVED']);

export const escalationPolicyStepInputSchema = z.object({
  responderMembershipId: z.uuid(),
  waitSeconds: z.number().int().min(1).max(604_800),
});

const policyFields = {
  description: z.string().trim().max(2_000).optional(),
  name: z.string().trim().min(1).max(120),
  steps: z.array(escalationPolicyStepInputSchema).min(1).max(50),
};

export const createEscalationPolicyRequestSchema = z.object({
  ...policyFields,
  makeDefault: z.boolean().optional().default(false),
});

export const createEscalationPolicyRevisionRequestSchema = z.object({
  description: policyFields.description,
  name: policyFields.name,
  steps: policyFields.steps,
});

export const setDefaultEscalationPolicyRequestSchema = z.object({ policyId: z.uuid() });

export const createIncidentRequestSchema = z.object({
  description: z.string().trim().min(1).max(10_000),
  severity: incidentSeveritySchema,
  title: z.string().trim().min(1).max(200),
});

export const updateIncidentRequestSchema = z
  .object({
    description: z.string().trim().min(1).max(10_000).optional(),
    severity: incidentSeveritySchema.optional(),
    title: z.string().trim().min(1).max(200).optional(),
  })
  .refine((value) => Object.values(value).some((field) => field !== undefined));

export const reassignIncidentRequestSchema = z.object({ membershipId: z.uuid() });

export const incidentListQuerySchema = z.object({
  status: incidentStatusSchema.optional(),
});

export const timelineQuerySchema = z.object({
  after: z.string().regex(/^\d+$/u).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export type CreateEscalationPolicyRequest = z.infer<typeof createEscalationPolicyRequestSchema>;
export type CreateEscalationPolicyRevisionRequest = z.infer<
  typeof createEscalationPolicyRevisionRequestSchema
>;
export type CreateIncidentRequest = z.infer<typeof createIncidentRequestSchema>;
export type ReassignIncidentRequest = z.infer<typeof reassignIncidentRequestSchema>;
export type UpdateIncidentRequest = z.infer<typeof updateIncidentRequestSchema>;
