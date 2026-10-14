/**
 * Lead pipeline stages for the Qualified leads board (Pipedrive
 * style). A lead's stage is DERIVED from state that already exists —
 * the handoff outbox status, its latest proposal's status, and its
 * latest recorded reviewer outcome — so there is no stage column to
 * keep in sync and no way for the board to disagree with the lead's
 * actual history.
 *
 * Precedence (first match wins):
 *   won                       -> Won
 *   lost / rejected / duplicate -> Lost (closed, negative)
 *   handoff sent              -> At DF (it has left the active
 *                                selling motion; the delivery
 *                                lifecycle owns it from here)
 *   contacted / meeting, or a proposal marked sent
 *                             -> In conversation
 *   a proposal exists (draft/approved), or the lead was accepted
 *                             -> Proposal
 *   otherwise                 -> Qualified
 */
export type PipelineStageId =
  | "qualified"
  | "proposal"
  | "conversation"
  | "at_df"
  | "won"
  | "lost";

export const PIPELINE_STAGES: Array<{ id: PipelineStageId; label: string }> = [
  { id: "qualified", label: "Qualified" },
  { id: "proposal", label: "Proposal" },
  { id: "conversation", label: "In conversation" },
  { id: "at_df", label: "At DF" },
  { id: "won", label: "Won" },
  { id: "lost", label: "Lost" },
];

export interface PipelineStageInputs {
  handoffStatus: string | null;
  proposalStatus: string | null;
  latestDecision: string | null;
}

/** Reviewer outcomes that close a lead's selling motion. */
export const TERMINAL_DECISIONS = ["won", "lost", "rejected", "duplicate"];

export function isTerminalDecision(decision: string | null): boolean {
  return decision !== null && TERMINAL_DECISIONS.includes(decision);
}

/**
 * What a board card says about a lead, in precedence order: a
 * terminal outcome first (it decided the lead's stage, and a card
 * in the Won column must not lead with its proposal status), then
 * the At DF badge, then the proposal state, then any other
 * recorded outcome.
 */
export type PipelineCardStatus =
  | { kind: "outcome"; decision: string }
  | { kind: "at_df" }
  | { kind: "proposal"; status: string }
  | { kind: "decision"; decision: string }
  | { kind: "awaiting" };

export function pipelineCardStatus(
  input: PipelineStageInputs,
): PipelineCardStatus {
  if (isTerminalDecision(input.latestDecision))
    return { kind: "outcome", decision: input.latestDecision as string };
  if (input.handoffStatus === "sent") return { kind: "at_df" };
  if (input.proposalStatus)
    return { kind: "proposal", status: input.proposalStatus };
  if (input.latestDecision)
    return { kind: "decision", decision: input.latestDecision };
  return { kind: "awaiting" };
}

export function derivePipelineStage(
  input: PipelineStageInputs,
): PipelineStageId {
  if (input.latestDecision === "won") return "won";
  if (
    input.latestDecision === "lost" ||
    input.latestDecision === "rejected" ||
    input.latestDecision === "duplicate"
  )
    return "lost";
  if (input.handoffStatus === "sent") return "at_df";
  if (
    input.latestDecision === "contacted" ||
    input.latestDecision === "meeting" ||
    input.proposalStatus === "sent"
  )
    return "conversation";
  if (
    input.proposalStatus === "draft" ||
    input.proposalStatus === "approved" ||
    input.latestDecision === "accepted"
  )
    return "proposal";
  return "qualified";
}
