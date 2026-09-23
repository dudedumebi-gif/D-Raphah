import https from "node:https";

const token = process.env.VERCEL_TOKEN;
const expectedProjects = (
  process.env.VERCEL_EXPECTED_PROJECTS ??
  "d-raphah,d-raphah-leads-engine,d-raphah-delivery-factory"
)
  .split(",")
  .map((name) => name.trim())
  .filter(Boolean);

if (!token) {
  console.error("VERCEL_TOKEN is not set.");
  process.exit(1);
}

function requestJson(path) {
  return new Promise((resolve, reject) => {
    const request = https.request(
      {
        hostname: "api.vercel.com",
        path,
        method: "GET",
        family: 4,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
          "User-Agent": "D-Raphah-Vercel-Verification/1.0",
        },
        timeout: 30_000,
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");
          if (
            !response.statusCode ||
            response.statusCode < 200 ||
            response.statusCode >= 300
          ) {
            reject(
              new Error(
                `Vercel API ${path} returned HTTP ${response.statusCode ?? "unknown"}`,
              ),
            );
            return;
          }

          try {
            resolve(JSON.parse(body));
          } catch {
            reject(new Error(`Vercel API ${path} returned invalid JSON`));
          }
        });
      },
    );

    request.on("timeout", () =>
      request.destroy(new Error("Vercel API request timed out")),
    );
    request.on("error", reject);
    request.end();
  });
}

try {
  await requestJson("/v2/user");
  const projectsResponse = await requestJson("/v9/projects?limit=100");
  const names = new Set(
    Array.isArray(projectsResponse.projects)
      ? projectsResponse.projects.map((project) => project.name)
      : [],
  );
  const missing = expectedProjects.filter((name) => !names.has(name));

  if (missing.length > 0) {
    console.error(
      `Authenticated, but missing required Vercel projects: ${missing.join(", ")}`,
    );
    process.exit(2);
  }

  console.log(
    "PASS: Vercel token authenticated and required projects are accessible.",
  );
  for (const name of expectedProjects) console.log(`- ${name}`);
} catch (error) {
  console.error(
    `Vercel verification failed: ${error instanceof Error ? error.message : "unknown error"}`,
  );
  process.exit(1);
}
