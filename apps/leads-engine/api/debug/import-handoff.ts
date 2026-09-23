import type { IncomingMessage, ServerResponse } from "node:http";
import "../../server/handoff.js";
export default async function handler(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  res.statusCode = 200;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ ok: true, module: "handoff" }));
}
