#!/usr/bin/env node
/**
 * DF UI sandbox: serves the built Delivery Factory SPA with a mocked API so
 * look-and-feel can be verified locally BEFORE any Vercel release.
 *
 * Usage: node sandbox_server.mjs [port]   (default 8901)
 *
 * Mocked endpoints:
 *   GET /api/config  -> { authUrl: "https://sandbox.invalid" }
 *                        (token fetch fails -> login gate renders signed-out UI)
 * Everything else under /api -> 404 JSON. SPA fallback for non-file paths.
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(__dirname, "dist");
const PORT = Number(process.argv[2] || 8901);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url || "/", "http://localhost");
  if (url.pathname === "/api/config") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ authUrl: "https://sandbox.invalid" }));
    return;
  }
  if (url.pathname.startsWith("/api/")) {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "sandbox mock: not implemented" }));
    return;
  }
  let file = path.join(DIST, decodeURIComponent(url.pathname));
  if (url.pathname === "/" || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    file = path.join(DIST, "index.html");
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
      return;
    }
    res.writeHead(200, { "content-type": MIME[path.extname(file)] || "application/octet-stream" });
    res.end(data);
  });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`DF sandbox at http://127.0.0.1:${PORT}`);
});
