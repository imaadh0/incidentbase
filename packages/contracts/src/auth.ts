import { z } from 'zod';

export const emailSchema = z.string().trim().toLowerCase().pipe(z.email().max(320));
export const passwordSchema = z.string().min(12).max(128);
export const organizationRoleSchema = z.enum(['OWNER', 'ADMIN', 'RESPONDER', 'REPORTER']);
export const membershipStatusSchema = z.enum(['INVITED', 'ACTIVE', 'SUSPENDED']);

export const registerRequestSchema = z.object({
  displayName: z.string().trim().min(1).max(100),
  email: emailSchema,
  organizationName: z.string().trim().min(1).max(120),
  organizationSlug: z
    .string()
    .trim()
    .min(3)
    .max(63)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u),
  password: passwordSchema,
});

export const loginRequestSchema = z.object({
  email: emailSchema,
  password: z.string().min(1).max(128),
});

export const invitationRequestSchema = z.object({
  email: emailSchema,
  role: organizationRoleSchema,
});

export const membershipUpdateRequestSchema = z
  .object({
    role: organizationRoleSchema.optional(),
    status: membershipStatusSchema.optional(),
  })
  .refine((value) => value.role !== undefined || value.status !== undefined, {
    message: 'At least one membership field is required.',
  });

export type InvitationRequest = z.infer<typeof invitationRequestSchema>;
export type LoginRequest = z.infer<typeof loginRequestSchema>;
export type MembershipUpdateRequest = z.infer<typeof membershipUpdateRequestSchema>;
export type RegisterRequest = z.infer<typeof registerRequestSchema>;
