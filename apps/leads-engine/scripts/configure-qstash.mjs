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
  // LE v4 retired the canary, operations-monitor, and scheduled-discovery
  // schedules (raphah-lead-canary-v1, raphah-lead-monitor-v1,
  // raphah-lead-discovery-v1). The worker tick now also runs the
  // alert/incident reconcile. The retired destinations answer 200
  // {retired: true} for one release so a still-configured schedule does
  // not record false delivery failures; pause the leftover schedules in
  // the Upstash console. The DF dispatch-feedback schedule is managed
  // with the Delivery Factory, not by this script.
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
