import type { ServerResponse } from "node:http";
import { sendJson, type ApiRequest } from "./_lib/http.js";
import indexHandler from "./_workflows/index.js";
import catalogHandler from "./_workflows/catalog.js";
import workflowByIdHandler from "./_workflows/[id].js";
import executeHandler from "./_workflows/[id]/execute.js";
import workflowRunsHandler from "./_workflows/[id]/runs.js";
import runDetailHandler from "./_workflows/runs/[runId].js";

type Handler = (req: ApiRequest, res: ServerResponse) => Promise<void>;

function pathSegments(req: ApiRequest): string[] {
  const raw = req.query?.path;
  const joined = Array.isArray(raw) ? raw.join("/") : (raw ?? "");
  return joined
    .split("/")
    .map((s) => {
      try {
        return decodeURIComponent(s);
      } catch {
        return s;
      }
    })
    .filter(Boolean);
}

/**
 * Single-function dispatcher for every /api/workflows/* path.
 *
 * The Hobby plan caps a deployment at 12 serverless functions, so a
 * vercel.json rewrite maps /api/workflows/:path* to this function with the
 * remainder in ?path=. URL contracts are unchanged: path params are
 * injected into req.query exactly the way the file-system router did.
 */
export default async function wfDispatch(
  req: ApiRequest,
  res: ServerResponse,
): Promise<void> {
  const segments = pathSegments(req);
  const query = { ...(req.query ?? {}) };
  delete query.path;
  let handler: Handler | undefined;

  if (segments.length === 0) {
    handler = indexHandler as Handler;
  } else if (segments.length === 1 && segments[0] === "catalog") {
    handler = catalogHandler as Handler;
  } else if (segments.length === 2 && segments[0] === "runs") {
    query.runId = segments[1];
    handler = runDetailHandler as Handler;
  } else if (segments.length === 1) {
    query.id = segments[0];
    handler = workflowByIdHandler as Handler;
  } else if (segments.length === 2 && segments[1] === "execute") {
    query.id = segments[0];
    handler = executeHandler as Handler;
  } else if (segments.length === 2 && segments[1] === "runs") {
    query.id = segments[0];
    handler = workflowRunsHandler as Handler;
  }

  if (!handler) {
    sendJson(res, 404, {}, { error: "Not found" });
    return;
  }
  req.query = query;
  await handler(req, res);
}
