import type { IncomingMessage, ServerResponse } from "node:http";
import apiHandler from "./_lib/handler.js";

type VercelRequest = IncomingMessage & {
  query?: Record<string, string | string[] | undefined>;
  url?: string;
};

/**
 * Single-function dispatcher for every /api/v1/* path.
 *
 * Vercel does not honor [...path].ts as a multi-segment catch-all:
 * single-segment paths arrive with an empty query and deeper paths 404
 * at the platform. The vercel.json rewrite maps /api/v1/:path* to this
 * fixed dispatcher with ?path=:path*, and we reconstruct the full path
 * here before delegating to the shared handler (which does its own
 * pathname routing via api/_lib/router.ts).
 *
 * The Hobby plan caps a deployment at 12 serverless functions, so a
 * single dispatcher is also what keeps us under the limit.
 */
function pathFromQuery(req: VercelRequest): string {
  const raw = req.query?.path;
  const joined = Array.isArray(raw) ? raw.join("/") : (raw ?? "");
  const segments = joined
    .split("/")
    .map((s) => {
      try {
        return decodeURIComponent(s);
      } catch {
        return s;
      }
    })
    .filter(Boolean);
  return `/api/v1/${segments.join("/")}`;
}

export default async function v1Dispatch(
  request: VercelRequest,
  response: ServerResponse,
): Promise<void> {
  // Reconstruct the original /api/v1/... path from the rewrite query param.
  // Preserve any additional query string beyond ?path=.
  const fullPath = pathFromQuery(request);
  const url = new URL(request.url ?? "/", "http://localhost");
  const extra = new URLSearchParams(url.search);
  extra.delete("path");
  const qs = extra.toString();
  const rewrittenUrl = qs ? `${fullPath}?${qs}` : fullPath;

  // Hand the request to the shared handler with the reconstructed URL.
  const proxied = Object.create(
    Object.getPrototypeOf(request),
    Object.getOwnPropertyDescriptors(request),
  ) as VercelRequest;
  proxied.url = rewrittenUrl;
  return apiHandler(proxied as never, response);
}
