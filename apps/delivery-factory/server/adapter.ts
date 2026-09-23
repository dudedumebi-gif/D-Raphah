/**
 * Standalone Node HTTP adapter for the Vercel-style `api/` functions.
 *
 * This is the portability layer for client handover: the exact same
 * handlers that run on Vercel (`api/*.ts`, `(req, res) => void`) also run
 * here, so the service can be shipped as a container to Google Cloud Run,
 * a VM, or `docker compose` with zero handler changes.
 *
 * Routing mirrors Vercel file-system routing plus vercel.json rewrites:
 *   api/health.ts              -> GET /api/health
 *   /api/workflows/:path*      -> /api/wf-dispatch?path=:path* (rewrite)
 *   /api/projects/:path*       -> /api/pj-dispatch?path=:path* (rewrite)
 *
 * Underscore-prefixed directories (api/_lib, api/_workflows, api/_projects)
 * are not routes — they hold shared code and per-path handlers invoked by
 * the dispatcher functions.
 *
 * Vercel normally provides `req.query`; the adapter populates it from the
 * URL search params merged over the route params.
 *
 * Env:
 *   PORT        — listen port (default 8080, Cloud Run's default)
 *   STATIC_DIR  — directory of static frontend assets to serve for
 *                 non-/api paths (e.g. "dist"); empty disables static serving
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import {
  createReadStream,
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import { extname, join, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";
type Handler = (
  req: IncomingMessage & { query?: Record<string, string | string[] | undefined> },
  res: ServerResponse,
) => Promise<void> | void;

interface Route {
  pattern: RegExp;
  paramNames: string[];
  catchAllNames: string[];
  file: string;
  specificity: number;
}

const API_DIR = join(process.cwd(), "api");
const STATIC_DIR = process.env.STATIC_DIR || "";
const PORT = Number(process.env.PORT || 8080);

interface RewriteRule {
  pattern: RegExp;
  destination: string;
}

/** Compile vercel.json rewrite sources (:name and :name* segments) to regexes. */
function loadRewrites(): RewriteRule[] {
  const configPath = join(process.cwd(), "vercel.json");
  if (!existsSync(configPath)) return [];
  try {
    const config = JSON.parse(
      readFileSync(configPath, "utf8"),
    ) as { rewrites?: Array<{ source?: string; destination?: string }> };
    return (config.rewrites ?? [])
      .filter((r) => r.source && r.destination)
      .map((r) => {
        const src = r.source as string;
        let regex = "";
        for (let i = 0; i < src.length; i++) {
          if (src[i] === ":") {
            const m = /^:([A-Za-z0-9_]+)(\*)?/.exec(src.slice(i));
            if (m) {
              if (m[2] && regex.endsWith("/")) {
                // ":name*" matches zero or more segments, so the preceding
                // slash is optional too (mirrors Vercel: /api/workflows/:path*
                // also matches the bare /api/workflows).
                regex = regex.slice(0, -1) + `(?:/(?<${m[1]}>.*))?`;
              } else {
                regex += m[2] ? `(?<${m[1]}>.*)` : `(?<${m[1]}>[^/]+)`;
              }
              i += m[0].length - 1;
              continue;
            }
          }
          regex += src[i].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        }
        return {
          pattern: new RegExp(`^${regex}/?$`),
          destination: r.destination as string,
        };
      });
  } catch {
    return [];
  }
}

const REWRITES = loadRewrites();

/**
 * Apply the first matching vercel.json rewrite, mirroring Vercel's routing:
 * rewrites run before the file-system router. Returns the rewritten
 * pathname and the destination's query params to merge.
 */
function applyRewrite(
  pathname: string,
): { pathname: string; extraQuery: Record<string, string> } | null {
  for (const rule of REWRITES) {
    const match = rule.pattern.exec(pathname);
    if (!match || !match.groups) continue;
    let dest = rule.destination;
    for (const [name, value] of Object.entries(match.groups)) {
      const v = value ?? "";
      dest = dest.split(`:${name}*`).join(v).split(`:${name}`).join(v);
    }
    const qIndex = dest.indexOf("?");
    const extraQuery: Record<string, string> = {};
    let destPath = dest;
    if (qIndex >= 0) {
      destPath = dest.slice(0, qIndex);
      for (const [k, v] of new URLSearchParams(dest.slice(qIndex + 1))) {
        extraQuery[k] = v;
      }
    }
    return { pathname: destPath, extraQuery };
  }
  return null;
}

function discover(dir: string): Route[] {
  const routes: Route[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current)) {
      const full = join(current, entry);
      if (statSync(full).isDirectory()) {
        if (entry.startsWith("_")) continue;
        walk(full);
        continue;
      }
      if (!entry.endsWith(".ts")) continue;
      const rel = relative(dir, full).replace(/\.ts$/, "").split(sep).join("/");
      const parts = rel.split("/");
      const paramNames: string[] = [];
      const catchAllNames: string[] = [];
      const regexParts: string[] = [];
      for (const part of parts) {
        if (part === "index") continue;
        const catchAll = part.match(/^\[\.\.\.(.+)\]$/);
        if (catchAll) {
          catchAllNames.push(catchAll[1]);
          regexParts.push("(.*)");
          continue;
        }
        const m = part.match(/^\[(.+)\]$/);
        if (m) {
          paramNames.push(m[1]);
          regexParts.push("([^/]+)");
        } else {
          regexParts.push(part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
        }
      }
      routes.push({
        pattern: new RegExp(`^/api/${regexParts.join("/")}/?$`),
        paramNames,
        catchAllNames,
        file: full,
        specificity: regexParts.join("/").length - paramNames.length * 10,
      });
    }
  };
  walk(dir);
  // Most specific (fewest params, longest literal) wins.
  routes.sort((a, b) => b.specificity - a.specificity);
  return routes;
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

function serveStatic(pathname: string, res: ServerResponse): boolean {
  if (!STATIC_DIR) return false;
  let file = join(process.cwd(), STATIC_DIR, decodeURIComponent(pathname));
  if (pathname.endsWith("/")) file = join(file, "index.html");
  if (!existsSync(file) || statSync(file).isDirectory()) {
    const fallback = join(process.cwd(), STATIC_DIR, "index.html");
    if (!existsSync(fallback)) return false;
    file = fallback; // SPA fallback
  }
  res.statusCode = 200;
  res.setHeader("content-type", MIME[extname(file)] || "application/octet-stream");
  createReadStream(file).pipe(res);
  return true;
}

async function main(): Promise<void> {
  const routes = discover(API_DIR);
  console.log(`[adapter] ${routes.length} api routes discovered`);

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const url = new URL(req.url || "/", "http://localhost");
      let pathname = url.pathname;

      if (!pathname.startsWith("/api/")) {
        if (serveStatic(pathname, res)) return;
        res.statusCode = 404;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ error: "Not found" }));
        return;
      }

      // Mirror Vercel: vercel.json rewrites run before the file-system router.
      const rewritten = applyRewrite(pathname);
      const rewriteQuery = rewritten?.extraQuery ?? {};
      if (rewritten) pathname = rewritten.pathname;

      for (const route of routes) {
        const match = route.pattern.exec(pathname);
        if (!match) continue;
        const mod = (await import(pathToFileURL(route.file).href)) as {
          default: Handler;
        };
        const params: Record<string, string | string[]> = {};
        route.paramNames.forEach((name, i) => {
          params[name] = decodeURIComponent(match[i + 1]);
        });
        route.catchAllNames.forEach((name, i) => {
          params[name] = match[route.paramNames.length + i + 1]
            .split("/")
            .filter(Boolean)
            .map(decodeURIComponent);
        });
        const query: Record<string, string | string[] | undefined> = {};
        url.searchParams.forEach((value, key) => {
          const existing = query[key];
          if (existing === undefined) query[key] = value;
          else if (Array.isArray(existing)) existing.push(value);
          else query[key] = [existing, value];
        });
        Object.assign(query, params);
        // Rewrite-supplied params (e.g. ?path= from the dispatcher rewrites)
        // behave like Vercel's: destination params win over the request's.
        Object.assign(query, rewriteQuery);
        (req as unknown as { query: typeof query }).query = query;
        await mod.default(req as Parameters<Handler>[0], res);
        return;
      }

      res.statusCode = 404;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ error: "Not found" }));
    } catch (error) {
      console.error("[adapter] handler error", error);
      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader("content-type", "application/json");
      }
      try {
        res.end(JSON.stringify({ error: "Internal server error" }));
      } catch {
        /* socket already closed */
      }
    }
  });

  server.listen(PORT, () => {
    console.log(`[adapter] listening on :${PORT}`);
  });
}

main().catch((error) => {
  console.error("[adapter] fatal", error);
  process.exit(1);
});
