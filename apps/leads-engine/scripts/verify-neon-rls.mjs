import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createClient } from "@neondatabase/neon-js";
import { neon } from "@neondatabase/serverless";

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

function subject(token) {
  const payload = JSON.parse(
    Buffer.from(token.split(".")[1], "base64url").toString("utf8"),
  );
  if (typeof payload.sub !== "string") throw new Error("JWT has no sub claim");
  return payload.sub;
}

function dataClient(token) {
  return createClient({
    dataApi: {
      url: required("NEON_DATA_API_URL"),
      getToken: async () => token,
    },
  });
}

const database = neon(required("DATABASE_URL"));
const tokenA = required("NEON_TEST_USER_A_TOKEN");
const tokenB = required("NEON_TEST_USER_B_TOKEN");
const userA = subject(tokenA);
const userB = subject(tokenB);
assert.notEqual(userA, userB, "RLS test requires two different Neon Auth users");

const clientA = dataClient(tokenA);
const clientB = dataClient(tokenB);
const workspaceA = randomUUID();
const workspaceB = randomUUID();
const sourceA = randomUUID();
const policyA = randomUUID();
const campaignA = randomUUID();
const discoverySourceA = randomUUID();
const discoveryCandidateA = randomUUID();
const key = `neon-rls-${randomUUID()}`;

try {
  await database`
    insert into public.workspaces(id,name,created_by) values
      (${workspaceA}::uuid,'Neon RLS A',${userA}),
      (${workspaceB}::uuid,'Neon RLS B',${userB})
  `;
  await database`
    insert into public.workspace_memberships(workspace_id,user_id,role) values
      (${workspaceA}::uuid,${userA},'owner'),
      (${workspaceB}::uuid,${userB},'owner')
  `;
  await database`
    insert into public.source_definitions(
      id,workspace_id,name,base_url,collection_method,business_purpose,status,created_by
    ) values (
      ${sourceA}::uuid,${workspaceA}::uuid,'Tenant A source','https://example.com',
      'static_html','Neon RLS isolation fixture','active',${userA}
    )
  `;
  await database`
    insert into public.source_policy_versions(
      id,workspace_id,source_id,allowed_domains,user_agent,contact_email,
      collection_method,status,approved_by,approved_at
    ) values (
      ${policyA}::uuid,${workspaceA}::uuid,${sourceA}::uuid,
      ${["example.com"]},'RaphahTestBot/1.0','ops@example.com',
      'static_html','approved',${userA},now()
    )
  `;
  await database`
    update public.source_definitions set active_policy_id=${policyA}::uuid
    where id=${sourceA}::uuid
  `;
  await database`
    insert into public.scrape_campaigns(
      id,workspace_id,source_id,name,criteria,interval_minutes,updated_by
    ) values (
      ${campaignA}::uuid,${workspaceA}::uuid,${sourceA}::uuid,
      'Neon RLS discovery','{}'::jsonb,1440,${userA}
    )
  `;
  await database`
    insert into public.discovery_sources(
      id,workspace_id,name,adapter_id,geo_params,source_id,campaign_id,data_mode
    ) values (
      ${discoverySourceA}::uuid,${workspaceA}::uuid,'Toronto RLS discovery',
      'toronto_open_data','{"city":"Toronto","region":"Ontario","centreLatitude":43.6532,"centreLongitude":-79.3832,"radiusKm":50}'::jsonb,
      ${sourceA}::uuid,${campaignA}::uuid,'pilot'
    )
  `;
  await database`
    insert into public.discovery_candidates(
      id,workspace_id,discovery_source_id,adapter_id,external_id,data_mode,
      name,identity_key,source_url,source_observed_at,evidence_text
    ) values (
      ${discoveryCandidateA}::uuid,${workspaceA}::uuid,${discoverySourceA}::uuid,
      'toronto_open_data','RLS-1','pilot','Tenant A candidate','tenant-a:toronto',
      'https://open.toronto.ca',now(),'Municipal licence category: fixture'
    )
  `;

  const aRead = await clientA
    .from("source_definitions")
    .select("id")
    .eq("id", sourceA);
  assert.equal(aRead.error, null);
  assert.equal(aRead.data?.length, 1, "tenant A must see its source");

  const bRead = await clientB
    .from("source_definitions")
    .select("id")
    .eq("id", sourceA);
  assert.equal(bRead.error, null);
  assert.equal(bRead.data?.length, 0, "tenant B must not see tenant A source");

  const aCandidate = await clientA
    .from("discovery_candidates")
    .select("id,data_mode")
    .eq("id", discoveryCandidateA);
  assert.equal(aCandidate.error, null);
  assert.equal(aCandidate.data?.length, 1, "tenant A must see its candidate");
  assert.equal(aCandidate.data?.[0]?.data_mode, "pilot");

  const bCandidate = await clientB
    .from("discovery_candidates")
    .select("id")
    .eq("id", discoveryCandidateA);
  assert.equal(bCandidate.error, null);
  assert.equal(
    bCandidate.data?.length,
    0,
    "tenant B must not see tenant A discovery candidate",
  );

  const crossTenantWrite = await clientB.from("source_definitions").insert({
    workspace_id: workspaceA,
    name: "Cross tenant source",
    base_url: "https://other.example",
    collection_method: "static_html",
    business_purpose: "RLS write isolation fixture",
    status: "draft",
  });
  assert.ok(crossTenantWrite.error, "tenant B mutation must be rejected");

  const first = await clientA.rpc("queue_scrape_job", {
    p_workspace_id: workspaceA,
    p_source_id: sourceA,
    p_target_url: "https://example.com",
    p_key: key,
    p_max_attempts: 3,
  });
  assert.equal(first.error, null);
  const replay = await clientA.rpc("queue_scrape_job", {
    p_workspace_id: workspaceA,
    p_source_id: sourceA,
    p_target_url: "https://example.com",
    p_key: key,
    p_max_attempts: 3,
  });
  assert.equal(replay.error, null);
  assert.equal(first.data?.id, replay.data?.id, "replay must return the same job");

  const forbiddenWorkerRpc = await clientA.rpc("lease_scrape_jobs", {
    p_worker_id: "browser",
    p_batch_size: 1,
    p_lease_seconds: 240,
    p_now: new Date().toISOString(),
  });
  assert.ok(forbiddenWorkerRpc.error, "browser must not lease worker jobs");

  const audit = await clientA
    .from("audit_events")
    .select("id")
    .eq("workspace_id", workspaceA);
  assert.equal(audit.error, null);
  assert.ok((audit.data?.length ?? 0) >= 5, "state changes must emit audit rows");

  process.stdout.write(
    "PASS: Neon Data API RLS isolation, mutation denial, audit capture, worker RPC denial, and queue idempotency.\n",
  );
} finally {
  await database`delete from public.workspaces where id in (${workspaceA}::uuid,${workspaceB}::uuid)`;
}
