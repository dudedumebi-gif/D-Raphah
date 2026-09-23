import type { IncomingMessage, ServerResponse } from "node:http";
import "../_lib/feedback-copy.js";
export default async function handler(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  res.statusCode = 200;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ ok: true }));
}
