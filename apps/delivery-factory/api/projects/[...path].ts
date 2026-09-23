import type { ServerResponse } from "node:http";
import { sendJson, type ApiRequest } from "../_lib/http.js";
import projectHandler from "../_projects/[id].js";
import clarificationsHandler from "../_projects/[id]/clarifications.js";
import resolveClarificationHandler from "../_projects/[id]/clarifications/[cid]/resolve.js";
import eventsHandler from "../_projects/[id]/events.js";
import milestonesHandler from "../_projects/[id]/milestones.js";
import completeMilestoneHandler from "../_projects/[id]/milestones/[mid]/complete.js";
import stageHandler from "../_projects/[id]/stage.js";

type Handler = (req: ApiRequest, res: ServerResponse) => Promise<void>;

/**
 * Catch-all dispatcher for /api/projects/*.
 *
 * The Hobby plan caps a deployment at 12 serverless functions, so every
 * project sub-path routes through this single function instead of one
 * file per route. URL contracts are unchanged: path params are injected
 * into req.query exactly the way Vercel's file-system router would.
 */
export default async function projectsDispatcher(
  req: ApiRequest,
  res: ServerResponse,
): Promise<void> {
  const raw = req.query?.path;
  const segments = (
    Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split("/") : []
  ).filter(Boolean);
  const query = { ...(req.query ?? {}) };
  let handler: Handler | undefined;

  if (segments.length === 1) {
    query.id = segments[0];
    handler = projectHandler as Handler;
  } else if (segments.length === 2 && segments[1] === "clarifications") {
    query.id = segments[0];
    handler = clarificationsHandler as Handler;
  } else if (
    segments.length === 4 &&
    segments[1] === "clarifications" &&
    segments[3] === "resolve"
  ) {
    query.id = segments[0];
    query.cid = segments[2];
    handler = resolveClarificationHandler as Handler;
  } else if (segments.length === 2 && segments[1] === "events") {
    query.id = segments[0];
    handler = eventsHandler as Handler;
  } else if (segments.length === 2 && segments[1] === "milestones") {
    query.id = segments[0];
    handler = milestonesHandler as Handler;
  } else if (
    segments.length === 4 &&
    segments[1] === "milestones" &&
    segments[3] === "complete"
  ) {
    query.id = segments[0];
    query.mid = segments[2];
    handler = completeMilestoneHandler as Handler;
  } else if (segments.length === 2 && segments[1] === "stage") {
    query.id = segments[0];
    handler = stageHandler as Handler;
  }

  if (!handler) {
    sendJson(res, 404, {}, { error: "Not found" });
    return;
  }
  req.query = query;
  await handler(req, res);
}
