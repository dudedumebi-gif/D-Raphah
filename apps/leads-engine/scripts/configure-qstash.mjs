import { Client } from "@upstash/qstash";

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

const baseUrl = required("LEAD_ENGINE_BASE_URL").replace(/\/$/, "");
const client = new Client({ token: required("QSTASH_TOKEN") });

const schedules = [
  {
    scheduleId: "raphah-lead-worker-v1",
    destination: `${baseUrl}/api/v1/worker/tick`,
    // Four-minute cadence leaves measurable headroom below the strict
    // scheduled-start p95 target of five minutes.
    cron: "*/4 * * * *",
    label: "lead-engine-worker",
  },
  {
    scheduleId: "raphah-lead-canary-v1",
    destination: `${baseUrl}/api/v1/canary/run`,
    cron: "0 * * * *",
    label: "lead-engine-canary",
  },
  {
    scheduleId: "raphah-lead-monitor-v1",
    destination: `${baseUrl}/api/v1/operations/evaluate`,
    cron: "*/5 * * * *",
    label: "lead-engine-operations-monitor",
  },
  {
    scheduleId: "raphah-lead-discovery-v1",
    destination: `${baseUrl}/api/v1/discovery/scheduled-run`,
    // Daily at 06:10 UTC, after the canary window — each active discovery
    // source runs at most once per 24h, guarded inside the scheduler.
    cron: "10 6 * * *",
    label: "lead-engine-discovery",
  },
];

for (const schedule of schedules) {
  // Idempotent: delete-then-create so re-runs converge on the current
  // cron/destination instead of 409ing on the stable scheduleId.
  try {
    await client.schedules.delete(schedule.scheduleId);
  } catch {
    // Absent schedule: nothing to delete.
  }
  const result = await client.schedules.create({
    ...schedule,
    method: "POST",
    retries: 3,
    timeout: 300,
    failureCallback: `${baseUrl}/api/v1/qstash/failure`,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ trigger: "qstash", schedule: schedule.scheduleId }),
  });
  process.stdout.write(
    `${schedule.scheduleId}: ${result.scheduleId} -> ${schedule.destination}\n`,
  );
}
