const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? '/api/v1';

export type Role = 'OWNER' | 'ADMIN' | 'RESPONDER' | 'REPORTER';
export type MembershipStatus = 'INVITED' | 'ACTIVE' | 'SUSPENDED';
export type IncidentStatus = 'OPEN' | 'ACKNOWLEDGED' | 'INVESTIGATING' | 'RESOLVED';
export type IncidentSeverity = 'SEV1' | 'SEV2' | 'SEV3' | 'SEV4';

export interface AccountMembership {
  membershipId: string;
  organizationId: string;
  organizationName: string;
  organizationSlug: string;
  role: Role;
  status: MembershipStatus;
}

export interface Account {
  memberships: AccountMembership[];
  user: { displayName: string; email: string; id: string };
}

export interface Member {
  displayName: string;
  id: string;
  organizationId: string;
  role: Role;
  status: MembershipStatus;
  userId: string;
}

export interface Incident {
  acknowledgedAt: string | null;
  assignedMembershipId: string;
  createdAt: string;
  currentEscalationStep: number;
  description: string;
  escalationExhaustedAt: string | null;
  escalationGeneration: number;
  firstEscalatedAt: string | null;
  id: string;
  investigatingAt: string | null;
  nextEscalationAt: string | null;
  organizationId: string;
  policyVersionId: string;
  referenceNumber: number;
  reporterMembershipId: string;
  resolvedAt: string | null;
  severity: IncidentSeverity;
  status: IncidentStatus;
  title: string;
  updatedAt: string;
  version: number;
}

export interface TimelineEntry {
  action: string;
  actorMembershipId: string | null;
  actorType: 'USER' | 'SYSTEM';
  createdAt: string;
  id: string;
  incidentId: string | null;
  metadata: Record<string, unknown>;
  organizationId: string;
}

export class ApiError extends Error {
  public constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export async function apiRequest<T>(
  path: string,
  init: RequestInit = {},
  retryAuthentication = true,
): Promise<T> {
  const method = init.method?.toUpperCase() ?? 'GET';
  const headers = new Headers(init.headers);
  if (init.body !== undefined && !headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }
  if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) {
    const csrf = readCookie('incidentbase_csrf');
    if (csrf !== undefined) headers.set('x-csrf-token', csrf);
  }

  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    credentials: 'include',
    headers,
  });
  if (response.status === 401 && retryAuthentication && path !== '/auth/refresh') {
    const refreshed = await refreshSession();
    if (refreshed) return apiRequest<T>(path, init, false);
  }
  if (!response.ok) throw await parseError(response);
  if (response.status === 204) return undefined as T;
  const body = (await response.json()) as { data: T };
  return body.data;
}

async function refreshSession(): Promise<boolean> {
  const csrf = readCookie('incidentbase_csrf');
  if (csrf === undefined) return false;
  const response = await fetch(`${API_BASE}/auth/refresh`, {
    credentials: 'include',
    headers: { 'x-csrf-token': csrf },
    method: 'POST',
  });
  return response.ok;
}

async function parseError(response: Response): Promise<ApiError> {
  try {
    const body = (await response.json()) as {
      error?: { code?: string; details?: unknown; message?: string };
    };
    return new ApiError(
      response.status,
      body.error?.code ?? 'REQUEST_FAILED',
      body.error?.message ?? 'The request failed.',
      body.error?.details,
    );
  } catch {
    return new ApiError(response.status, 'REQUEST_FAILED', 'The request failed.');
  }
}

function readCookie(name: string): string | undefined {
  if (typeof document === 'undefined') return undefined;
  for (const segment of document.cookie.split(';')) {
    const [candidate, ...value] = segment.trim().split('=');
    if (candidate === name) return decodeURIComponent(value.join('='));
  }
  return undefined;
}
