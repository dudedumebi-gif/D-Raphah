/**
 * Lead-handoff workflow triggers for the Delivery Factory.
 *
 * When POST /api/intake accepts a handoff package, every published workflow
 * with trigger_type = 'lead_handoff' is offered the package as its trigger
 * payload. Draft-first is structural: the intake path runs the engine with
 * no provider hooks, so send_email / send_sms / ai_assist nodes record
 * drafts for human approval — nothing can send.
 *
 * This module never imports from apps/leads-engine; the package arrives
 * through the versioned handoff contract only.
 */

import type { LeadEngineHandoffPackage } from "@raphah/handoff-contract";
import type { NeonClient } from "./db.js";
import {
  buildLeadHandoffTriggerPayload,
  executeWorkflow,
  listPublishedWorkflowsByTrigger,
} from "./workflows.js";

/**
 * Whether a lead_handoff workflow's minScore gate allows auto-execution for
 * a lead with the given score. A gate of 0 (or unset) means "always run".
 *
 * The v1 handoff contract carries no numeric lead score, so a positive gate
 * can never be verified — "unknown" never counts as passing, and the
 * workflow does not auto-run. The operator can still run it manually from
 * the Automations UI.
 */
export function leadHandoffMinScoreAllows(
  triggerConfig: Record<string, unknown> | null,
  leadScore: number | undefined,
): boolean {
  const raw = triggerConfig?.minScore;
  const minScore =
    typeof raw === "number" && Number.isFinite(raw) ? raw : 0;
  if (minScore <= 0) return true;
  return leadScore != null && leadScore >= minScore;
}

export interface LeadHandoffTriggerResult {
  executed: string[];
  skipped: string[];
}

/**
 * Runs every published 'lead_handoff' workflow against a freshly-accepted
 * handoff package. Per-workflow failure isolation: one broken workflow is
 * recorded in the aggregate error but never blocks the others. Throws when
 * any workflow failed so the caller can log + audit the failure — the
 * intake acceptance itself is unaffected (see handleIntake).
 */
export async function triggerLeadHandoffWorkflows(
  db: NeonClient,
  pkg: LeadEngineHandoffPackage,
): Promise<LeadHandoffTriggerResult> {
  const workflows = await listPublishedWorkflowsByTrigger(db, "lead_handoff");
  const payload = buildLeadHandoffTriggerPayload(pkg);
  const executed: string[] = [];
  const skipped: string[] = [];
  const failures: Array<{ workflowId: string; error: string }> = [];

  for (const wf of workflows) {
    if (!leadHandoffMinScoreAllows(wf.trigger_config, payload.lead.score)) {
      skipped.push(wf.id);
      continue;
    }
    try {
      await executeWorkflow(
        db,
        wf.id,
        payload as unknown as Record<string, unknown>,
      );
      executed.push(wf.id);
    } catch (error) {
      failures.push({
        workflowId: wf.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (failures.length > 0) {
    throw new Error(
      `lead_handoff trigger failures: ${failures
        .map((f) => `${f.workflowId}: ${f.error}`)
        .join("; ")}`,
    );
  }
  return { executed, skipped };
}
