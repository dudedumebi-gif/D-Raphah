import type { IncomingMessage, ServerResponse } from "node:http";
import { verifyPackage, sha256CanonicalJson } from "@raphah/handoff-contract";
export default async function handler(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  res.statusCode = 200;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ ok: typeof verifyPackage === "function" && typeof sha256CanonicalJson === "function" }));
}
