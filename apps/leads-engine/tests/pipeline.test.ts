import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  derivePipelineStage,
  isTerminalDecision,
  pipelineCardStatus,
  PIPELINE_STAGES,
} from "../src/pipeline-stage";

/**
 * Pipeline board stage derivation (Chidumebi, 2026-10-14): stages
 * come from state that already exists — handoff outbox status,
 * latest proposal status, latest reviewer outcome — in a fixed
 * precedence, so the board can never disagree with the lead's
 * history. Also pins the board's wiring: the state endpoint and
 * the List | Board surface.
 */

const NONE = {
  handoffStatus: null,
  proposalStatus: null,
  latestDecision: null,
};

describe("derivePipelineStage", () => {
  it("starts every untouched lead at Qualified", () => {
    expect(derivePipelineStage(NONE)).toBe("qualified");
    expect(
      derivePipelineStage({ ...NONE, handoffStatus: "pending" }),
    ).toBe("qualified");
  });

  it("moves to Proposal on acceptance or a drafted/approved proposal", () => {
    expect(derivePipelineStage({ ...NONE, latestDecision: "accepted" })).toBe(
      "proposal",
    );
    expect(derivePipelineStage({ ...NONE, proposalStatus: "draft" })).toBe(
      "proposal",
    );
    expect(derivePipelineStage({ ...NONE, proposalStatus: "approved" })).toBe(
      "proposal",
    );
  });

  it("moves to In conversation on contact, a meeting, or a sent proposal", () => {
    expect(
      derivePipelineStage({ ...NONE, latestDecision: "contacted" }),
    ).toBe("conversation");
    expect(derivePipelineStage({ ...NONE, latestDecision: "meeting" })).toBe(
      "conversation",
    );
    expect(derivePipelineStage({ ...NONE, proposalStatus: "sent" })).toBe(
      "conversation",
    );
    // Contact beats a still-draft proposal.
    expect(
      derivePipelineStage({
        ...NONE,
        proposalStatus: "draft",
        latestDecision: "contacted",
      }),
    ).toBe("conversation");
  });

  it("moves to At DF once the handoff lands, outranking conversation", () => {
    expect(derivePipelineStage({ ...NONE, handoffStatus: "sent" })).toBe(
      "at_df",
    );
    expect(
      derivePipelineStage({
        handoffStatus: "sent",
        proposalStatus: "sent",
        latestDecision: "contacted",
      }),
    ).toBe("at_df");
  });

  it("closes Won/Lost on the latest outcome, outranking At DF", () => {
    expect(
      derivePipelineStage({ ...NONE, handoffStatus: "sent", latestDecision: "won" }),
    ).toBe("won");
    expect(derivePipelineStage({ ...NONE, latestDecision: "lost" })).toBe(
      "lost",
    );
    expect(derivePipelineStage({ ...NONE, latestDecision: "rejected" })).toBe(
      "lost",
    );
    expect(derivePipelineStage({ ...NONE, latestDecision: "duplicate" })).toBe(
      "lost",
    );
  });

  it("orders the stages Qualified -> Proposal -> Conversation -> At DF -> Won/Lost", () => {
    expect(PIPELINE_STAGES.map((s) => s.id)).toEqual([
      "qualified",
      "proposal",
      "conversation",
      "at_df",
      "won",
      "lost",
    ]);
  });
});

describe("pipelineCardStatus", () => {
  it("shows a terminal outcome before proposal status and At DF", () => {
    expect(
      pipelineCardStatus({
        handoffStatus: "sent",
        proposalStatus: "sent",
        latestDecision: "won",
      }),
    ).toEqual({ kind: "outcome", decision: "won" });
    expect(
      pipelineCardStatus({
        handoffStatus: null,
        proposalStatus: "approved",
        latestDecision: "rejected",
      }),
    ).toEqual({ kind: "outcome", decision: "rejected" });
    expect(isTerminalDecision("duplicate")).toBe(true);
    expect(isTerminalDecision("contacted")).toBe(false);
    expect(isTerminalDecision(null)).toBe(false);
  });

  it("then At DF, proposal state, other outcomes, awaiting", () => {
    expect(pipelineCardStatus({ ...NONE, handoffStatus: "sent" })).toEqual({
      kind: "at_df",
    });
    expect(pipelineCardStatus({ ...NONE, proposalStatus: "draft" })).toEqual({
      kind: "proposal",
      status: "draft",
    });
    expect(
      pipelineCardStatus({ ...NONE, latestDecision: "accepted" }),
    ).toEqual({ kind: "decision", decision: "accepted" });
    expect(pipelineCardStatus(NONE)).toEqual({ kind: "awaiting" });
  });
});

describe("pipeline wiring", () => {
  const router = readFileSync(
    new URL("../api/_lib/router.ts", import.meta.url),
    "utf8",
  );
  const main = readFileSync(
    new URL("../src/main.tsx", import.meta.url),
    "utf8",
  );

  it("serves per-lead pipeline state on its own route", () => {
    expect(router).toContain('"/api/v1/leads/pipeline"');
    expect(router).toContain("from public.lead_proposals");
    expect(router).toContain("from public.lead_feedback");
    // Handoff status rides in the same query: GET /handoffs is
    // capped at 200 rows, too small a window to classify from.
    expect(router).toContain("from public.handoff_outbox");
    expect(router).toContain("handoffStatus");
    // Associated through the stored package's opportunityId and
    // the workspace — never by parsing the caller-controlled
    // idempotency key (custom keys need not embed the id at all).
    expect(router).toContain("package->>'opportunityId'");
    expect(router).not.toContain("idempotency_key like");
    expect(router).toContain("opportunity_id:package->>opportunityId");
    expect(main).toContain("row.opportunity_id");
  });

  it("the board carries the Pipedrive-style stage skin", () => {
    expect(main).toContain("pipeline-col--");
    const styles = readFileSync(
      new URL("../src/styles.css", import.meta.url),
      "utf8",
    );
    expect(styles).toContain("--stage-accent");
    expect(styles).toContain(".pipeline-col--won");
  });

  it("the board discloses pipeline load failure instead of faking Qualified", () => {
    expect(main).toContain("pipelineStatus");
    expect(main).toContain("Pipeline state could not be loaded");
    expect(main).toContain("Loading pipeline state");
  });

  it("the Leads surface has the List | Board toggle and the board", () => {
    expect(main).toContain("PipelineBoard");
    expect(main).toContain('setLeadView("board")');
    expect(main).toContain('"/api/v1/leads/pipeline"');
    expect(main).toContain("derivePipelineStage");
  });
});
