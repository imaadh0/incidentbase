import { z } from 'zod';

export const realtimeIncidentEventSchema = z.object({
  auditId: z.string().regex(/^\d+$/u),
  eventId: z.uuid(),
  eventType: z.string().min(1).max(120),
  incidentId: z.uuid(),
  organizationId: z.uuid(),
  recipientUserId: z.uuid().optional(),
  referenceNumber: z.number().int().positive(),
  status: z.enum(['OPEN', 'ACKNOWLEDGED', 'INVESTIGATING', 'RESOLVED']),
  title: z.string().min(1).max(200),
  version: z.number().int().positive(),
});

export type RealtimeIncidentEvent = z.infer<typeof realtimeIncidentEventSchema>;

export const REALTIME_REDIS_CHANNEL = 'incidentbase:realtime:v1';
export const REALTIME_INCIDENT_EVENT = 'incident:invalidate';
export const REALTIME_TOAST_EVENT = 'notification:toast';
