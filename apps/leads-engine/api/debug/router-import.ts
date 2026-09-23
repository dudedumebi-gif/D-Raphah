import type { IncomingMessage, ServerResponse } from "node:http";
import { handleApiRequest } from "../../server/router.js";
export default async function handler(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  res.statusCode = 200;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ routerImported: typeof handleApiRequest === "function" }));
}
