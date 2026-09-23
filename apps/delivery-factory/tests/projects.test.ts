import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { handleIntake } from "../api/_lib/verify.js";
import {
  askClarification,
  finishMilestone,
  getProjectDetail,
  isStageTransitionAllowed,
  settleClarification,
  transitionProjectStage,
} from "../api/_lib/projects.js";
import { FakeDeliveryDb } from "./fake-db.js";
import { intakeRequest, signTestPackage, testEnv } from "./helpers.js";

async function acceptedProject() {
  const db = new FakeDeliveryDb();
  const env = testEnv();
  const result = await handleIntake(
    intakeRequest(signTestPackage(), { "idempotency-key": `key-${randomUUID()}` }),
    db,
    env,
  );
  if (result.status !== 201) throw new Error("setup intake failed");
  const projectId = (result.body as { projectId: string }).projectId;
  return { db, env, projectId };
}

describe("stage transitions", () => {
  it("allows forward one-step transitions and records history", async () => {
    const { db, env, projectId } = await acceptedProject();
    const updated = await transitionProjectStage(db, {
      projectId,
      toStage: "onboarding",
      changedBy: "operator@example.com",
      environment: env.environment,
    });
    expect(updated.current_stage).toBe("onboarding");
    expect(db.stageHistory).toHaveLength(1);
    expect(db.stageHistory[0]).toMatchObject({
      projectId,
      fromStage: "intake",
      toStage: "onboarding",
      changedBy: "operator@example.com",
    });
  });

  it("rejects skipping pipeline stages", async () => {
    const { db, env, projectId } = await acceptedProject();
    await expect(
      transitionProjectStage(db, {
        projectId,
        toStage: "implementation",
        environment: env.environment,
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
    const detail = await getProjectDetail(db, projectId);
    expect(detail.project.current_stage).toBe("intake");
    expect(db.stageHistory).toHaveLength(0);
  });

  it("allows moving backward for rework", async () => {
    const { db, env, projectId } = await acceptedProject();
    await transitionProjectStage(db, {
      projectId,
      toStage: "onboarding",
      environment: env.environment,
    });
    const back = await transitionProjectStage(db, {
      projectId,
      toStage: "intake",
      environment: env.environment,
    });
    expect(back.current_stage).toBe("intake");
  });

  it("treats completed as terminal", async () => {
    const { db, env, projectId } = await acceptedProject();
    for (const stage of [
      "onboarding",
      "blueprint_drafting",
      "implementation",
      "testing",
      "handover",
      "completed",
    ]) {
      await transitionProjectStage(db, {
        projectId,
        toStage: stage,
        environment: env.environment,
      });
    }
    await expect(
      transitionProjectStage(db, {
        projectId,
        toStage: "testing",
        environment: env.environment,
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
    const closed = db.events.find(
      (e) =>
        (e.event as { eventType: string }).eventType ===
        "delivery.project.closed",
    );
    expect(closed?.projectId).toBe(projectId);
  });

  it("rejects unknown stages and unknown projects", async () => {
    const { db, env, projectId } = await acceptedProject();
    await expect(
      transitionProjectStage(db, {
        projectId,
        toStage: "warp_speed",
        environment: env.environment,
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
    await expect(
      transitionProjectStage(db, {
        projectId: randomUUID(),
        toStage: "onboarding",
        environment: env.environment,
      }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it("validates the transition matrix directly", () => {
    expect(isStageTransitionAllowed("intake", "onboarding")).toBe(true);
    expect(isStageTransitionAllowed("intake", "implementation")).toBe(false);
    expect(isStageTransitionAllowed("testing", "implementation")).toBe(true);
    expect(isStageTransitionAllowed("completed", "completed")).toBe(true);
    expect(isStageTransitionAllowed("completed", "handover")).toBe(false);
    expect(isStageTransitionAllowed("intake", "nope")).toBe(false);
  });
});

describe("milestones and clarifications", () => {
  it("seeds four milestones on intake and completes one", async () => {
    const { db, env, projectId } = await acceptedProject();
    const detail = await getProjectDetail(db, projectId);
    expect(detail.milestones).toHaveLength(4);
    expect(detail.project.organization_name).toBe("Acme Corp");

    const milestone = await finishMilestone(db, {
      projectId,
      milestoneId: detail.milestones[0].id,
      environment: env.environment,
    });
    expect(milestone.completed).toBe(true);
    const released = db.events.find(
      (e) =>
        (e.event as { eventType: string }).eventType ===
        "delivery.release.completed",
    );
    expect(released?.projectId).toBe(projectId);
  });

  it("rejects completing an unknown milestone", async () => {
    const { db, env, projectId } = await acceptedProject();
    await expect(
      finishMilestone(db, {
        projectId,
        milestoneId: randomUUID(),
        environment: env.environment,
      }),
    ).rejects.toThrow("Milestone not found");
  });

  it("creates and resolves clarifications", async () => {
    const { db, env, projectId } = await acceptedProject();
    const clarification = await askClarification(db, {
      projectId,
      question: "Who owns the staging environment?",
      environment: env.environment,
    });
    expect(clarification.status).toBe("open");
    expect(clarification.owner).toBe("Founder");
    const asked = db.events.find(
      (e) =>
        (e.event as { eventType: string }).eventType ===
        "delivery.clarification.requested",
    );
    expect(asked?.projectId).toBe(projectId);

    const resolved = await settleClarification(db, {
      projectId,
      clarificationId: clarification.id,
    });
    expect(resolved.status).toBe("resolved");

    await expect(
      askClarification(db, {
        projectId,
        question: "   ",
        environment: env.environment,
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("returns 404 for unknown projects", async () => {
    const db = new FakeDeliveryDb();
    await expect(getProjectDetail(db, randomUUID())).rejects.toMatchObject({
      statusCode: 404,
    });
  });
});
