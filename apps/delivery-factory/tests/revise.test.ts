import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { reviseDraft } from "../api/_lib/workflows.js";

/**
 * Approval-gate redraft (POST /api/workflows/drafts/revise): the admin's
 * note and the current draft go to the same AI provider seam ai_assist
 * uses. These tests pin both outcomes — a real revision when a provider
 * answers, and the honest stub (no fabricated text) when none does —
 * plus the dispatch wiring that exposes the endpoint.
 */

describe("reviseDraft", () => {
  it("returns the provider's revised text when an AI provider is wired", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const revision = await reviseDraft(
      { draft: "Hi Sarah, thanks for your visit.", feedback: "Add the review link." },
      {
        aiAssist: async (args) => {
          seen.push(args as unknown as Record<string, unknown>);
          return { output: "Hi Sarah, thanks for your visit: example.ca/review" };
        },
      },
    );
    expect(revision.provider).toBe("llm");
    expect(revision.revisedDraft).toContain("example.ca/review");
    // The provider received BOTH the draft and the admin's note.
    expect(String(seen[0].userPrompt)).toContain("thanks for your visit");
    expect(String(seen[0].userPrompt)).toContain("Add the review link.");
    expect(String(seen[0].systemPrompt)).toContain("revise");
  });

  it("falls back to the honest stub when no provider is configured", async () => {
    const revision = await reviseDraft({
      draft: "Draft text",
      feedback: "Make it warmer",
    });
    expect(revision.provider).toBe("stub");
    expect(revision.revisedDraft).toBeNull();
    expect(revision.note).toContain("no AI provider configured");
    expect(revision.note).toContain("Make it warmer");
  });

  it("treats an empty provider response as no revision", async () => {
    const revision = await reviseDraft(
      { draft: "Draft", feedback: "Shorter" },
      { aiAssist: async () => ({ output: "" }) },
    );
    expect(revision.provider).toBe("stub");
    expect(revision.revisedDraft).toBeNull();
  });
});

describe("revise endpoint wiring", () => {
  const dispatch = readFileSync(
    new URL("../api/wf-dispatch.ts", import.meta.url),
    "utf8",
  );
  const handler = readFileSync(
    new URL("../api/_workflows/drafts/revise.ts", import.meta.url),
    "utf8",
  );

  it("routes POST /api/workflows/drafts/revise in the dispatcher", () => {
    expect(dispatch).toContain('"drafts"');
    expect(dispatch).toContain('"revise"');
    expect(dispatch).toContain("draftReviseHandler");
  });

  it("validates input and writes the gate activity to the audit log", () => {
    expect(handler).toContain('defineRoute(["POST"]');
    expect(handler).toContain("Both 'draft' and 'feedback' are required");
    expect(handler).toContain("recordWorkflowAudit");
    expect(handler).toContain("approval gate");
  });
});
