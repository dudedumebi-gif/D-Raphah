import { defineRoute } from "../../_lib/route.js";
import { getDb } from "../../_lib/db.js";
import { readJsonBody, sendJson } from "../../_lib/http.js";
import { recordWorkflowAudit, reviseDraft } from "../../_lib/workflows.js";

/**
 * POST /api/workflows/drafts/revise — the approval gate's redraft loop.
 *
 * An admin reviewing a held draft sends it back with a note; the note
 * and the draft go to the AI provider seam (the same one ai_assist
 * uses). With no provider configured the response is the honest stub:
 * no revised text is fabricated, and the note is preserved. When the
 * caller names the run, the request itself is written to the workflow
 * audit log, so the gate's activity is part of the run's own record.
 */
export default defineRoute(["POST"], async (req, res) => {
  const body = ((await readJsonBody(req)) ?? {}) as Record<string, unknown>;
  const draft = typeof body.draft === "string" ? body.draft.trim() : "";
  const feedback =
    typeof body.feedback === "string" ? body.feedback.trim() : "";
  if (!draft || !feedback) {
    sendJson(res, 400, {}, {
      error: "Both 'draft' and 'feedback' are required",
    });
    return;
  }
  const revision = await reviseDraft({ draft, feedback });
  const runId = typeof body.runId === "string" ? body.runId : null;
  const workflowId =
    typeof body.workflowId === "string" ? body.workflowId : null;
  if (runId && workflowId) {
    await recordWorkflowAudit(getDb(), {
      runId,
      workflowId,
      level: "info",
      message:
        `Admin requested changes at the approval gate: "${feedback}" — ` +
        (revision.provider === "llm"
          ? "the AI provider produced a revised draft."
          : "no AI provider configured; the note is recorded with the draft."),
    });
  }
  sendJson(res, 200, {}, { revision });
});
