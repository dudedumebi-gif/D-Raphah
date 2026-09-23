import { neon } from "@neondatabase/serverless";
import { createClient } from "@neondatabase/neon-js";
import { Receiver } from "@upstash/qstash";

export interface AuthenticatedUser {
  id: string;
  email: string | null;
}

export type DataClient = ReturnType<typeof createClient>;

export interface RequestContext {
  user: AuthenticatedUser;
  workspaceId: string;
  client: DataClient;
  role: "owner" | "administrator" | "analyst" | "reviewer" | "auditor";
}

const runtimeVariables = [
  "DATABASE_URL",
  "NEON_DATA_API_URL",
  "NEON_AUTH_URL",
  "QSTASH_CURRENT_SIGNING_KEY",
  "QSTASH_NEXT_SIGNING_KEY",
] as const;

export function configurationStatus() {
  const missing = runtimeVariables.filter((key) => !process.env[key]);
  return { configured: missing.length === 0, missing };
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

let database: ReturnType<typeof neon> | null = null;

export function createAdminClient(): ReturnType<typeof neon> {
  if (!database) database = neon(requiredEnvironment("DATABASE_URL"));
  return database;
}

export function createUserClient(accessToken: string): DataClient {
  return createClient({
    dataApi: {
      url: requiredEnvironment("NEON_DATA_API_URL"),
      getToken: async () => accessToken,
    },
  });
}

function bearerToken(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (!header?.startsWith("Bearer ")) return null;
  return header.slice(7).trim();
}

function decodeJwtPayload(token: string): Record<string, unknown> {
  const segments = token.split(".");
  if (segments.length !== 3) throw new Error("Malformed access token");
  const normalized = segments[1].replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  return JSON.parse(Buffer.from(padded, "base64").toString("utf8")) as Record<
    string,
    unknown
  >;
}

export async function requireUserContext(
  request: Request,
): Promise<RequestContext> {
  const token = bearerToken(request);
  if (!token)
    throw Object.assign(new Error("Authentication required"), {
      statusCode: 401,
    });
  const workspaceId = request.headers.get("x-workspace-id");
  if (!workspaceId)
    throw Object.assign(new Error("X-Workspace-ID header is required"), {
      statusCode: 400,
    });

  let claims: Record<string, unknown>;
  try {
    claims = decodeJwtPayload(token);
  } catch {
    throw Object.assign(new Error("Invalid access token"), { statusCode: 401 });
  }
  const userId = typeof claims.sub === "string" ? claims.sub : null;
  const expiresAt = typeof claims.exp === "number" ? claims.exp * 1000 : null;
  if (!userId || (expiresAt !== null && expiresAt <= Date.now()))
    throw Object.assign(new Error("Invalid or expired access token"), {
      statusCode: 401,
    });

  const client = createUserClient(token);
  const { data: membership, error: membershipError } = await client
    .from("workspace_memberships")
    .select("role")
    .eq("workspace_id", workspaceId)
    .eq("user_id", userId)
    .eq("status", "active")
    .maybeSingle();
  if (membershipError || !membership)
    throw Object.assign(new Error("Workspace membership required"), {
      statusCode: membershipError ? 401 : 403,
    });

  return {
    user: {
      id: userId,
      email: typeof claims.email === "string" ? claims.email : null,
    },
    workspaceId,
    client,
    role: membership.role,
  } as RequestContext;
}

export function requireRole(
  context: RequestContext,
  allowed: RequestContext["role"][],
): void {
  if (!allowed.includes(context.role))
    throw Object.assign(new Error("Insufficient workspace permission"), {
      statusCode: 403,
    });
}

export async function requireScheduler(request: Request): Promise<void> {
  const signature = request.headers.get("upstash-signature");
  if (signature) {
    const receiver = new Receiver({
      currentSigningKey: requiredEnvironment("QSTASH_CURRENT_SIGNING_KEY"),
      nextSigningKey: requiredEnvironment("QSTASH_NEXT_SIGNING_KEY"),
    });
    const valid = await receiver.verify({
      signature,
      body: await request.clone().text(),
      url: request.url,
    });
    if (valid) return;
  }

  const manualSecret = process.env.WORKER_SECRET;
  if (manualSecret && bearerToken(request) === manualSecret) return;
  throw Object.assign(new Error("Worker authorization failed"), {
    statusCode: 401,
  });
}

export async function assertDatabaseReady(
  client = createAdminClient(),
): Promise<void> {
  const rows = (await client`
    select version
    from public.schema_versions
    where service = 'lead-engine'
    limit 1
  `) as unknown as Array<{ version: string }>;
  if (rows[0]?.version !== "3.0.0")
    throw new Error("Database readiness failed: incompatible schema version");
}
