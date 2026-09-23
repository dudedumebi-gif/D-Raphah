import type { IncomingMessage, ServerResponse } from "node:http";
export default async function handler(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  res.setHeader("content-type", "application/json");
  const results: Record<string, string> = {};
  for (const mod of ["../../server/feedback.js", "../../server/collection.js", "../../server/worker.js"]) {
    try {
      const m = await import(mod);
      results[mod] = "OK keys=" + Object.keys(m).slice(0,5).join(",");
    } catch (e) {
      results[mod] = "FAIL: " + (e as Error).message.slice(0, 300);
    }
  }
  res.statusCode = 200;
  res.end(JSON.stringify(results, null, 2));
}
