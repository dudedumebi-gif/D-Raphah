import type { ServerResponse } from "node:http";
import { sendJson, type ApiRequest } from "./_lib/http.js";
import charterHandler from "./_projects/[id]/charter.js";
import kpiVerifyHandler from "./_projects/[id]/kpis/[kpiId]/verify.js";
import workflowSkeletonsHandler from "./_projects/[id]/workflow-skeletons.js";

type Handler = (req: ApiRequest, res: ServerResponse) => Promise<void>;

/**
 * Single-function dispatcher for every /api/projects/* path.
 *
 * The Hobby plan caps a deployment at 12 serverless functions, so a
 * vercel.json rewrite maps /api/projects/:path* to this function with the
 * remainder in ?path=. URL contracts are unchanged: path params are
 * injected into req.query exactly the way the file-system router did.
 *
 * DF v2 removed the caller-less project pipeline API (project detail,
 * stage transitions, milestones, clarifications, project events, and
 * the manual begin). What remains is the Charter surface: the charter
 * itself, post-build KPI verification, and use-case skeleton
 * generation for projects accepted before the intake hook existed.
 */
export default async function pjDispatch(
  req: ApiRequest,
  res: ServerResponse,
): Promise<void> {
  const raw = req.query?.path;
  const segments = (Array.isArray(raw) ? raw.join("/") : (raw ?? ""))
    .split("/")
    .filter(Boolean);
  const query = { ...(req.query ?? {}) };
  delete query.path;
  let handler: Handler | undefined;

  if (segments.length === 2 && segments[1] === "charter") {
    query.id = segments[0];
    handler = charterHandler as Handler;
  } else if (
    segments.length === 4 &&
    segments[1] === "kpis" &&
    segments[3] === "verify"
  ) {
    query.id = segments[0];
    query.kpiId = segments[2];
    handler = kpiVerifyHandler as Handler;
  } else if (segments.length === 2 && segments[1] === "workflow-skeletons") {
    query.id = segments[0];
    handler = workflowSkeletonsHandler as Handler;
  }

  if (!handler) {
    sendJson(res, 404, {}, { error: "Not found" });
    return;
  }
  req.query = query;
  await handler(req, res);
}
