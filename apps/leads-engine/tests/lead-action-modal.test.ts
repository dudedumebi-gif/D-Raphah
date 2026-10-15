import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Per-lead actions as a pop-up (user request, 2026-10-14): Use
 * cases, Proposal and Send to DF open in a modal over the list —
 * not as panels at the page bottom — and the proposal tab shows
 * a visible checker for the approved-use-case drafting gate
 * (the server 409 existed; the UI lock was silent).
 */
const main = readFileSync(
  new URL("../src/main.tsx", import.meta.url),
  "utf8",
);
const styles = readFileSync(
  new URL("../src/styles.css", import.meta.url),
  "utf8",
);

describe("lead action modal", () => {
  it("opens all three actions in one pop-up with tabs", () => {
    expect(main).toContain("lead-modal-overlay");
    expect(main).toContain("openLeadAction");
    expect(main).toContain('tab: "usecases" | "proposal" | "send"');
    expect(main).toContain('openLeadAction(lead, "send")');
    expect(styles).toContain(".lead-modal {");
  });

  it("the proposal tab shows the drafting checker, locked and unlocked", () => {
    expect(main).toContain("Drafting is locked.");
    expect(main).toContain("drafting is unlocked");
    expect(main).toContain("lead-checker-locked");
    expect(styles).toContain(".lead-checker-locked");
  });

  it("row and board buttons route into the modal, not page-bottom panels", () => {
    expect(main).toContain('onUseCases={(lead) => openLeadAction(lead, "usecases")}');
    expect(main).toContain('onProposal={(lead) => openLeadAction(lead, "proposal")}');
  });
});
