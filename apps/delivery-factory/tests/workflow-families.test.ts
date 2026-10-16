import { describe, expect, it, vi } from "vitest";
import {
  PROBLEM_STATEMENT_MAX,
  createCharterCache,
  familyTitle,
  groupWorkflowsByFamily,
  shortenText,
  skeletonRef,
  summarizeCharter,
  type CharterLike,
} from "../src/workflow-families.js";

/**
 * Workflow families (PR #63 follow-on): use-case skeletons group
 * under their project family in Automations, and the project charter
 * is a lazy-loaded, cached, collapsible read-only summary. These
 * tests pin the pure shaping behind the UI in src/workflows.tsx.
 */

interface Member {
  name: string;
  trigger_config?: Record<string, unknown> | null;
}

function skeleton(
  org: string,
  title: string,
  projectId: string,
  requirementId: string,
  requirementCode: string,
): Member {
  return {
    name: `${org} — ${title}`,
    trigger_config: {
      projectId,
      packageId: `pkg-${projectId}`,
      requirementId,
      requirementCode,
    },
  };
}

const charter: CharterLike = {
  project: { organizationName: "Donddental" },
  problemStatement: "Patients can only book by phone during office hours.",
  requirements: [
    {
      id: "req-1",
      code: "UC-ONLINE-APPOINTMENT-BOOKING",
      statement: "Online appointment booking",
      priority: "Must",
    },
    {
      id: "req-2",
      code: "UC-AUTOMATED-REMINDERS",
      statement: "Automated reminders to reduce no-shows",
      priority: "Must",
    },
    {
      id: "req-3",
      code: "UC-REVIEW-REQUESTS",
      statement: "Automated review and referral requests",
      priority: "Should",
    },
  ],
  kpis: [
    { id: "kpi-1", metric: "Online bookings", target: "30% of bookings" },
    { id: "kpi-2", metric: "No-show rate", target: "Reduce by 15%" },
  ],
};

describe("skeletonRef", () => {
  it("reads the lineage out of a skeleton's trigger_config", () => {
    expect(
      skeletonRef(skeleton("Donddental", "Booking", "p1", "req-1", "UC-1")),
    ).toEqual({ projectId: "p1", requirementId: "req-1", requirementCode: "UC-1" });
  });

  it("returns null for non-skeleton workflows", () => {
    expect(skeletonRef({ name: "Manual", trigger_config: {} })).toBeNull();
    expect(skeletonRef({ name: "Manual", trigger_config: null })).toBeNull();
    expect(skeletonRef({ name: "Manual" })).toBeNull();
    expect(
      skeletonRef({ name: "Manual", trigger_config: { projectId: "" } }),
    ).toBeNull();
    expect(
      skeletonRef({ name: "Manual", trigger_config: { projectId: 42 } }),
    ).toBeNull();
  });
});

describe("groupWorkflowsByFamily", () => {
  it("groups skeletons by project and leaves other workflows standalone", () => {
    const manual: Member = { name: "Weekly report", trigger_config: {} };
    const a1 = skeleton("Donddental", "Booking", "p1", "req-1", "UC-1");
    const b1 = skeleton("Acme Dental", "Booking", "p2", "req-9", "UC-1");
    const a2 = skeleton("Donddental", "Reminders", "p1", "req-2", "UC-2");

    const { families, standalone } = groupWorkflowsByFamily([
      manual,
      a1,
      b1,
      a2,
    ]);

    expect(families.map((f) => f.projectId)).toEqual(["p1", "p2"]);
    expect(families[0].workflows).toEqual([a1, a2]);
    expect(families[1].workflows).toEqual([b1]);
    expect(standalone).toEqual([manual]);
  });

  it("titles families from the organization prefix and collects requirements", () => {
    const { families } = groupWorkflowsByFamily([
      skeleton("Donddental", "Booking", "p1", "req-1", "UC-1"),
      skeleton("Donddental", "Reminders", "p1", "req-2", "UC-2"),
      // A duplicate skeleton for the same requirement must not
      // duplicate the family's requirement list.
      skeleton("Donddental", "Booking v2", "p1", "req-1", "UC-1"),
    ]);
    expect(families).toHaveLength(1);
    expect(families[0].title).toBe("Donddental");
    expect(families[0].requirementIds).toEqual(["req-1", "req-2"]);
    expect(families[0].requirementCodes).toEqual(["UC-1", "UC-2"]);
  });

  it("leaves a skeleton-free list entirely standalone, in order", () => {
    const list: Member[] = [
      { name: "One", trigger_config: {} },
      { name: "Two" },
      { name: "Three", trigger_config: { unrelated: true } },
    ];
    const { families, standalone } = groupWorkflowsByFamily(list);
    expect(families).toEqual([]);
    expect(standalone).toEqual(list);
  });

  it("handles an empty list", () => {
    expect(groupWorkflowsByFamily([])).toEqual({
      families: [],
      standalone: [],
    });
  });
});

describe("familyTitle", () => {
  it("extracts the organization from the generator's name shape", () => {
    expect(familyTitle(["Donddental — Online Appointment Booking"])).toBe(
      "Donddental",
    );
  });

  it("falls back when no name carries the separator", () => {
    expect(familyTitle(["Untitled workflow"])).toBe("Project family");
    expect(familyTitle([])).toBe("Project family");
  });
});

describe("summarizeCharter", () => {
  it("marks the requirements the family implements, by id and by code", () => {
    const summary = summarizeCharter(charter, {
      ids: ["req-1"],
      codes: ["UC-REVIEW-REQUESTS"],
    });
    expect(summary.organizationName).toBe("Donddental");
    expect(
      summary.requirements.map((r) => [r.code, r.implemented]),
    ).toEqual([
      ["UC-ONLINE-APPOINTMENT-BOOKING", true],
      ["UC-AUTOMATED-REMINDERS", false],
      ["UC-REVIEW-REQUESTS", true],
    ]);
    expect(summary.kpis).toEqual([
      { id: "kpi-1", metric: "Online bookings", target: "30% of bookings" },
      { id: "kpi-2", metric: "No-show rate", target: "Reduce by 15%" },
    ]);
  });

  it("shortens a long problem statement and keeps a null one null", () => {
    const long = "x".repeat(PROBLEM_STATEMENT_MAX + 100);
    const summary = summarizeCharter(
      { ...charter, problemStatement: long },
      { ids: [], codes: [] },
    );
    expect(summary.problemStatement).toHaveLength(PROBLEM_STATEMENT_MAX);
    expect(summary.problemStatement?.endsWith("…")).toBe(true);

    const empty = summarizeCharter(
      { ...charter, problemStatement: null },
      { ids: [], codes: [] },
    );
    expect(empty.problemStatement).toBeNull();
  });
});

describe("shortenText", () => {
  it("returns short text untouched", () => {
    expect(shortenText("hello", 10)).toBe("hello");
    expect(shortenText("0123456789", 10)).toBe("0123456789");
  });
});

describe("createCharterCache", () => {
  it("is lazy: nothing is fetched until the first load", async () => {
    const fetchCharter = vi.fn(async () => charter);
    const cache = createCharterCache(fetchCharter);
    expect(fetchCharter).not.toHaveBeenCalled();
    expect(cache.peek("p1")).toBeUndefined();
    await cache.load("p1");
    expect(fetchCharter).toHaveBeenCalledTimes(1);
  });

  it("caches per project: repeat and concurrent loads fetch once", async () => {
    const fetchCharter = vi.fn(async (id: string) => ({
      ...charter,
      project: { organizationName: id },
    }));
    const cache = createCharterCache(fetchCharter);

    const [a, b] = await Promise.all([cache.load("p1"), cache.load("p1")]);
    expect(a).toBe(b);
    await cache.load("p1");
    expect(fetchCharter).toHaveBeenCalledTimes(1);
    expect(cache.peek("p1")?.project.organizationName).toBe("p1");

    await cache.load("p2");
    expect(fetchCharter).toHaveBeenCalledTimes(2);
  });

  it("does not cache failures, so a later expand can retry", async () => {
    let attempts = 0;
    const cache = createCharterCache(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("boom");
      return charter;
    });
    await expect(cache.load("p1")).rejects.toThrow("boom");
    await expect(cache.load("p1")).resolves.toBe(charter);
    expect(attempts).toBe(2);
  });
});
