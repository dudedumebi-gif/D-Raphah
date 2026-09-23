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
    cron: "*/5 * * * *",
    label: "lead-engine-worker",
  },
  {
    scheduleId: "raphah-lead-canary-v1",
    destination: `${baseUrl}/api/v1/canary/run`,
    cron: "0 * * * *",
    label: "lead-engine-canary",
  },
];

for (const schedule of schedules) {
  const result = await client.schedules.create({
    ...schedule,
    method: "POST",
    retries: 3,
    timeout: 300,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ trigger: "qstash", schedule: schedule.scheduleId }),
  });
  process.stdout.write(
    `${schedule.scheduleId}: ${result.scheduleId} -> ${schedule.destination}\n`,
  );
}
