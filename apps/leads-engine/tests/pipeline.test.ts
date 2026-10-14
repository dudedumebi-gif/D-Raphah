import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  derivePipelineStage,
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
  });

  it("the Leads surface has the List | Board toggle and the board", () => {
    expect(main).toContain("PipelineBoard");
    expect(main).toContain('setLeadView("board")');
    expect(main).toContain('"/api/v1/leads/pipeline"');
    expect(main).toContain("derivePipelineStage");
  });
});
