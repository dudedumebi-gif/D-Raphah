import { defineRoute } from "../_lib/route.js";
import { getDb } from "../_lib/db.js";
import { sendJson } from "../_lib/http.js";
import { NODE_CATALOG } from "../_lib/workflows.js";

/** GET /api/workflows/catalog — node catalog for the visual builder palette. */
export default defineRoute(["GET"], async (_req, res) => {
  sendJson(res, 200, {}, { nodes: NODE_CATALOG });
});
