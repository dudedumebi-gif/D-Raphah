import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");
const checks = [];

function check(name, condition, detail) {
  checks.push({ name, ok: Boolean(condition), detail });
  if (!condition) process.exitCode = 1;
}

const [
  pkg,
  ci,
  leWorker,
  leMigration,
  leDomain,
  dfMigration,
  dfReady,
  postman,
] = await Promise.all([
  read("package.json"),
  read(".github/workflows/ci.yml"),
  read("apps/leads-engine/api/_lib/worker.ts"),
  read(
    "apps/leads-engine/neon/migrations/202609270001_source_budget_and_audit.sql",
  ),
  read("apps/leads-engine/api/_lib/domain.ts"),
  read("apps/delivery-factory/neon/migrations/202609270001_delivery_audit.sql"),
  read("apps/delivery-factory/api/ready.ts"),
  read(
    "apps/leads-engine/postman/Lead_Engine_Production.postman_collection.json",
  ),
]);

check(
  "root regression includes both products",
  pkg.includes("@raphah/delivery-factory-app test"),
);
check("CI builds Lead Engine", ci.includes("@raphah/leads-engine-app build"));
check("release branches run CI", ci.includes('"release/**"'));
check(
  "persistent source budget",
  leMigration.includes("source_collection_reservations"),
);
check(
  "atomic source reservation",
  leMigration.includes("reserve_source_collection"),
);
check("operational retention", leWorker.includes("prune_operational_history"));
check(
  "ICP scoring uses observed profile",
  leDomain.includes("inferBusinessProfile"),
);
check(
  "Delivery Factory state is audited",
  dfMigration.includes("capture_delivery_audit_event"),
);
check(
  "Delivery Factory readiness fails closed",
  dfReady.includes("DELIVERY_DATABASE_URL"),
);
check(
  "Postman covers signed handoff",
  postman.includes("Signed Delivery Factory handoff"),
);

if (process.argv.includes("--live")) {
  const targets = [
    ["lead-engine", process.env.LEAD_ENGINE_PRODUCTION_URL, "lead-engine"],
    [
      "delivery-factory",
      process.env.DELIVERY_FACTORY_PRODUCTION_URL,
      "delivery-factory",
    ],
  ];
  for (const [name, base, service] of targets) {
    check(`${name} URL configured`, base, "production workflow variable");
    if (!base) continue;
    for (const endpoint of ["live", "ready"]) {
      const path =
        name === "delivery-factory" && endpoint === "live"
          ? "health"
          : endpoint;
      const url = `${base.replace(/\/$/, "")}/api/${name === "lead-engine" ? `health/${path}` : path}`;
      try {
        const response = await fetch(url, {
          signal: AbortSignal.timeout(15_000),
        });
        const body = await response.json();
        check(
          `${name} ${endpoint}`,
          response.ok && body.service === service,
          `${response.status} ${url}`,
        );
      } catch (error) {
        check(
          `${name} ${endpoint}`,
          false,
          error instanceof Error ? error.message : String(error),
        );
      }
    }
  }
}

for (const item of checks)
  console.log(
    `${item.ok ? "PASS" : "FAIL"} ${item.name}${item.detail ? ` — ${item.detail}` : ""}`,
  );
if (process.exitCode)
  throw new Error("Production readiness verification failed");
