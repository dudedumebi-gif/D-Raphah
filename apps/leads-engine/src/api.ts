import { createClient, SupabaseAuthAdapter } from "@neondatabase/neon-js";

const neonAuthUrl = import.meta.env.VITE_NEON_AUTH_URL as string | undefined;
const neonDataApiUrl = import.meta.env.VITE_NEON_DATA_API_URL as
  string | undefined;

export const isNeonConfigured = Boolean(neonAuthUrl && neonDataApiUrl);
export const neonClient = isNeonConfigured
  ? createClient({
      auth: {
        adapter: SupabaseAuthAdapter(),
        url: neonAuthUrl!,
      },
      dataApi: { url: neonDataApiUrl! },
    })
  : null;

export interface Session {
  access_token: string;
  user: { id: string; email?: string | null };
}

export async function apiRequest<T>(
  session: Session,
  workspaceId: string,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${session.access_token}`);
  headers.set("x-workspace-id", workspaceId);
  headers.set("x-correlation-id", crypto.randomUUID());
  if (init.body) headers.set("content-type", "application/json");
  const response = await fetch(path, { ...init, headers });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message =
      (payload as { error?: { message?: string } }).error?.message ??
      `Request failed (${response.status})`;
    throw new Error(message);
  }
  return payload as T;
}

export async function apiRequestText(
  session: Session,
  workspaceId: string,
  path: string,
): Promise<string> {
  const headers = new Headers();
  headers.set("authorization", `Bearer ${session.access_token}`);
  headers.set("x-workspace-id", workspaceId);
  headers.set("x-correlation-id", crypto.randomUUID());
  headers.set("accept", "text/event-stream");
  const response = await fetch(path, { headers });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    const message =
      (payload as { error?: { message?: string } }).error?.message ??
      `Request failed (${response.status})`;
    throw new Error(message);
  }
  return response.text();
}

/** Pollable SSE timeline for one scrape job (one-shot text/event-stream). */
export function fetchJobEventsText(
  session: Session,
  workspaceId: string,
  jobId: string,
): Promise<string> {
  return apiRequestText(
    session,
    workspaceId,
    `/api/v1/scrape-jobs/${jobId}/events`,
  );
}

export function cachedBootstrap(
  workspaceId: string,
  actorId: string,
): BootstrapData | null {
  try {
    const value = localStorage.getItem(
      `raphah.lead.bootstrap.v3.${workspaceId}`,
    );
    const data = value ? (JSON.parse(value) as BootstrapData) : null;
    return data?.actor.id === actorId && data.workspaceId === workspaceId
      ? data
      : null;
  } catch {
    return null;
  }
}

export function cacheBootstrap(workspaceId: string, data: BootstrapData): void {
  try {
    localStorage.setItem(
      `raphah.lead.bootstrap.v3.${workspaceId}`,
      JSON.stringify(data),
    );
  } catch {
    /* Quota/private-mode failure must not turn a successful API request into failure. */
  }
}

export interface Membership {
  workspace_id: string;
  role: string;
  workspaces: { name: string } | Array<{ name: string }> | null;
}

export interface SourceRecord {
  id: string;
  name: string;
  base_url: string;
  collection_method: string;
  business_purpose: string;
  status: string;
  active_policy_id: string | null;
  created_at: string;
}

export interface CampaignRecord {
  id: string;
  source_id: string;
  name: string;
  criteria: Record<string, unknown>;
  interval_minutes: number;
  schedule_enabled: boolean;
  next_run_at: string | null;
  criteria_suggestion?: {
    direction: "loosen" | "hold" | "tighten";
    observedQualifiedLeads: number;
    targetQualifiedLeads: number;
    changes: Record<string, number> & {
      geography?: {
        centreLatitude?: number | null;
        centreLongitude?: number | null;
      };
    };
    rationale: string[];
    autoApply: false;
  };
}

export interface JobRecord {
  id: string;
  source_id: string;
  target_url: string;
  status: string;
  scheduled_for: string;
  started_at: string | null;
  completed_at: string | null;
  attempt_count: number;
  max_attempts: number;
  last_error: string | null;
  created_at: string;
}

export interface LeadRecord {
  id: string;
  title: string;
  stage: string;
  routing: string;
  status: string;
  automation_maturity_score: number;
  opportunity_potential_score: number;
  confidence: number;
  last_refreshed_at: string;
  organizations:
    | { name: string; normalized_domain: string }
    | Array<{ name: string; normalized_domain: string }>
    | null;
}

export interface AuditRecord {
  id: string;
  action: string;
  resource_type: string;
  resource_id: string | null;
  outcome: string;
  reason: string | null;
  actor_id: string | null;
  correlation_id: string | null;
  before_state: Record<string, unknown> | null;
  after_state: Record<string, unknown> | null;
  created_at: string;
}

export interface OperationsRecord {
  jobs: {
    total72h: number;
    byStatus: Record<string, number>;
    scheduledStartP95Ms: number | null;
    scheduledStartTargetMet: boolean;
  };
  canary: {
    hoursCovered: number;
    total: number;
    completed: number;
    completionRate: number;
    p95CompletionMs: number | null;
    passed: boolean;
  };
  workers: Array<{
    id: string;
    status: string;
    runtime: string;
    capabilities: string[];
    last_heartbeat_at: string;
    deployment_id: string | null;
  }>;
}

export interface BootstrapData {
  actor: { id: string; email: string | null; role: string };
  workspaceId: string;
  memberships: Membership[];
  sources: SourceRecord[];
  campaigns: CampaignRecord[];
  jobs: JobRecord[];
  leads: LeadRecord[];
  audit: AuditRecord[];
  operations: OperationsRecord;
}
