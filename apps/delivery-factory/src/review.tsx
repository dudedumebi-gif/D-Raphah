import { useState } from "react";
import "./review.css";
import {
  STAGE_ORDER,
  coveredCriteria,
  evidenceCoverage,
  projectProgress,
  type AuditEvent,
  type EvidenceRecord,
  type Gate,
  type Project,
} from "./main";

/* ── Review drawer (Phase 2) ───────────────────────────────────────────
 * Inspect before act. Every consequential demo-workspace action — gate
 * Approve, project Advance, evidence Capture, client-view Preview —
 * opens this drawer first. It shows the charter context the decision
 * validates against (purpose, acceptance criteria, evidence coverage,
 * risks, decision history), and approvals/advances record a decision
 * note into the audit trail. Capture creates a real evidence record;
 * coverage and progress everywhere are calculated from state.
 */

export type ReviewState =
  | { kind: "gate"; projectId: string; gateId: string }
  | { kind: "advance"; projectId: string }
  | { kind: "evidence"; projectId: string }
  | { kind: "preview"; projectId: string };

type CaptureDraft = {
  title: string;
  checkpointType: EvidenceRecord["checkpointType"];
  gateId: string | null;
  note: string;
  criteria: string[];
};

const TITLES: Record<ReviewState["kind"], string> = {
  gate: "Review gate approval",
  advance: "Review stage advance",
  evidence: "Capture evidence",
  preview: "Client view preview",
};

function DecisionHistory({
  audit,
  project,
  gateLabel,
}: {
  audit: AuditEvent[];
  project: Project;
  gateLabel?: string;
}) {
  const relevant = audit
    .filter(
      (event) =>
        event.subject.includes(project.name) ||
        (gateLabel ? event.subject.includes(gateLabel) : false),
    )
    .slice(0, 4);
  if (relevant.length === 0) return null;
  return (
    <section className="review-section">
      <h4>Decision history</h4>
      <ul className="review-history">
        {relevant.map((event) => (
          <li key={event.id}>
            <b>{event.action}</b> ·{" "}
            <time>{new Date(event.at).toLocaleString()}</time>
            <br />
            <span>{event.subject}</span>
            {event.detail ? (
              <>
                <br />
                <span className="muted">{event.detail}</span>
              </>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

function CharterContext({ project }: { project: Project }) {
  return (
    <section className="review-section">
      <h4>Charter — the intended purpose</h4>
      <p>
        <b>Objective:</b> {project.charter.objective}
      </p>
      <p className="muted">{project.charter.problemStatement}</p>
      {project.charter.risks.length ? (
        <p className="muted">
          <b>Risks on the charter:</b> {project.charter.risks.join(" · ")}
        </p>
      ) : null}
    </section>
  );
}

function CriteriaChecklist({
  criteria,
  covered,
  records,
}: {
  criteria: string[];
  covered: Set<string>;
  records: EvidenceRecord[];
}) {
  if (criteria.length === 0) {
    return (
      <p className="muted">
        No acceptance criteria are attached — the decision rests on the
        reviewer's judgement and the decision note.
      </p>
    );
  }
  return (
    <ul className="review-criteria">
      {criteria.map((criterion) => {
        const supporting = records.filter((r) =>
          r.criteria.includes(criterion),
        );
        const met = covered.has(criterion);
        return (
          <li key={criterion} className={met ? "met" : "unmet"}>
            <span className="review-criterion-mark">{met ? "✓" : "⚠"}</span>
            <span>
              {criterion}
              <br />
              <small>
                {met
                  ? `Evidence: ${supporting.map((r) => r.title).join("; ")}`
                  : "No evidence record covers this criterion yet"}
              </small>
            </span>
          </li>
        );
      })}
    </ul>
  );
}

export function ReviewDrawer({
  target,
  projects,
  gates,
  evidenceRecords,
  audit,
  onClose,
  onApproveGate,
  onAdvanceProject,
  onCaptureEvidence,
}: {
  target: ReviewState;
  projects: Project[];
  gates: Gate[];
  evidenceRecords: EvidenceRecord[];
  audit: AuditEvent[];
  onClose: () => void;
  onApproveGate: (gate: Gate, note: string) => void;
  onAdvanceProject: (project: Project, note: string) => void;
  onCaptureEvidence: (project: Project, draft: CaptureDraft) => void;
}) {
  const [note, setNote] = useState("");
  const [title, setTitle] = useState("");
  const [checkpointType, setCheckpointType] =
    useState<EvidenceRecord["checkpointType"]>("test-run");
  const [gateId, setGateId] = useState<string>("");
  const [pickedCriteria, setPickedCriteria] = useState<string[]>([]);

  const project = projects.find((item) => item.id === target.projectId);
  if (!project) return null;
  const gate =
    target.kind === "gate"
      ? gates.find((item) => item.id === target.gateId)
      : undefined;
  if (target.kind === "gate" && !gate) return null;

  const projectRecords = evidenceRecords.filter(
    (record) => record.projectId === project.id,
  );
  const covered = coveredCriteria(project.id, evidenceRecords);
  const coverage = evidenceCoverage(project, evidenceRecords);
  const progress = projectProgress(project, gates, evidenceRecords);

  const gateUnmet = gate
    ? gate.criteria.filter((c) => !covered.has(c)).length
    : 0;
  const nextStage =
    project.stage === "Complete"
      ? null
      : STAGE_ORDER[
          Math.min(
            STAGE_ORDER.indexOf(project.stage) + 1,
            STAGE_ORDER.length - 1,
          )
        ];
  const blockers = gates.filter(
    (item) =>
      item.projectId === project.id &&
      item.stage === project.stage &&
      item.status !== "Approved",
  );
  const progressAfter =
    nextStage == null
      ? progress
      : projectProgress(
          { ...project, stage: nextStage },
          gates,
          evidenceRecords,
        );

  return (
    <div
      className="review-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <aside className="review-drawer" role="dialog" aria-modal="true">
        <div className="review-head">
          <div>
            <p className="eyebrow accent">Review before acting</p>
            <h3>{TITLES[target.kind]}</h3>
            <p className="muted">
              {project.name} · {project.client} · Stage {project.stage}
            </p>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="Close review">
            ×
          </button>
        </div>

        {target.kind === "preview" ? (
          <>
            <section className="client-card">
              <p className="eyebrow">Client view · {project.client}</p>
              <h4>{project.name}</h4>
              <div className="client-progress">
                <div>
                  <span>Delivery stage</span>
                  <b>{project.stage}</b>
                </div>
                <div>
                  <span>Progress</span>
                  <b>{progress}%</b>
                </div>
                <div>
                  <span>Next milestone</span>
                  <b>{project.due}</b>
                </div>
              </div>
              <div className="progress client-bar">
                <i style={{ width: `${progress}%` }} />
              </div>
              <h5>Delivery commitments</h5>
              <ul className="review-criteria">
                {project.charter.successCriteria.map((criterion) => (
                  <li
                    key={criterion}
                    className={covered.has(criterion) ? "met" : "unmet"}
                  >
                    <span className="review-criterion-mark">
                      {covered.has(criterion) ? "✓" : "…"}
                    </span>
                    <span>
                      {criterion}
                      <br />
                      <small>
                        {covered.has(criterion)
                          ? "Evidence captured"
                          : "In progress"}
                      </small>
                    </span>
                  </li>
                ))}
              </ul>
              <p className="muted">
                Evidence coverage: {coverage}% of commitments evidenced.
              </p>
            </section>
            <section className="review-section">
              <h4>What the client does not see</h4>
              <p className="muted">
                This preview is the actual client-facing view. Internal
                fields are excluded from it: internal owner, gate review
                statuses and decision notes, the audit trail, evidence
                record details, and commercial scope.
              </p>
            </section>
            <div className="review-actions">
              <button className="primary" onClick={onClose}>
                Done
              </button>
            </div>
          </>
        ) : null}

        {target.kind === "gate" && gate ? (
          <>
            <section className="review-section">
              <h4>
                {gate.label} · {gate.status}
              </h4>
              <p>
                <b>Why this gate exists:</b> {gate.purpose}
              </p>
              <p className="muted">
                It guards the exit from {gate.stage}. Approving records a
                human delivery decision in the audit trail.
              </p>
            </section>
            <section className="review-section">
              <h4>Acceptance criteria — validated against evidence</h4>
              <CriteriaChecklist
                criteria={gate.criteria}
                covered={covered}
                records={projectRecords}
              />
            </section>
            <CharterContext project={project} />
            <DecisionHistory audit={audit} project={project} gateLabel={gate.label} />
            <section className="review-section">
              <h4>Decision note{gateUnmet > 0 ? " (required — criteria gaps)" : ""}</h4>
              <textarea
                value={note}
                onChange={(event) => setNote(event.target.value)}
                rows={3}
                placeholder="Why is this decision right? The note is written to the audit trail."
              />
              {gateUnmet > 0 ? (
                <p className="review-warn">
                  {gateUnmet} of {gate.criteria.length} criteria have no
                  evidence yet. Approving anyway is allowed, but the gap
                  and your rationale are recorded.
                </p>
              ) : null}
            </section>
            <div className="review-actions">
              <button className="quiet" onClick={onClose}>
                Cancel
              </button>
              <button
                className="primary"
                disabled={gateUnmet > 0 && !note.trim()}
                onClick={() => onApproveGate(gate, note.trim())}
              >
                {gateUnmet > 0 ? "Approve with gaps noted" : "Approve gate"}
              </button>
            </div>
          </>
        ) : null}

        {target.kind === "advance" && nextStage ? (
          <>
            <section className="review-section">
              <h4>
                {project.stage} → {nextStage}
              </h4>
              <p className="muted">
                Progress is calculated, not typed in: stage base{" "}
                {STAGE_ORDER.indexOf(project.stage) * 20} points, plus the
                in-stage span earned from approved gates and evidence
                coverage. Now: <b>{progress}%</b> · After advancing:{" "}
                <b>{progressAfter}%</b> · Evidence coverage:{" "}
                <b>{coverage}%</b>.
              </p>
            </section>
            <section className="review-section">
              <h4>Gates guarding the exit from {project.stage}</h4>
              {gates.filter(
                (item) =>
                  item.projectId === project.id &&
                  item.stage === project.stage,
              ).length ? (
                <ul className="review-history">
                  {gates
                    .filter(
                      (item) =>
                        item.projectId === project.id &&
                        item.stage === project.stage,
                    )
                    .map((item) => (
                      <li key={item.id}>
                        <b>{item.label}</b> — {item.status}
                      </li>
                    ))}
                </ul>
              ) : (
                <p className="muted">No gates guard this stage.</p>
              )}
              {blockers.length ? (
                <p className="review-warn">
                  {blockers.length} gate(s) for {project.stage} are not
                  approved: {blockers.map((g) => g.label).join(", ")}.
                  Advancing anyway requires a rationale — it is recorded
                  in the audit trail.
                </p>
              ) : null}
            </section>
            <CharterContext project={project} />
            <DecisionHistory audit={audit} project={project} />
            <section className="review-section">
              <h4>Decision note{blockers.length ? " (required — unapproved gates)" : ""}</h4>
              <textarea
                value={note}
                onChange={(event) => setNote(event.target.value)}
                rows={3}
                placeholder="Rationale for advancing now. Written to the audit trail."
              />
            </section>
            <div className="review-actions">
              <button className="quiet" onClick={onClose}>
                Cancel
              </button>
              <button
                className="primary"
                disabled={blockers.length > 0 && !note.trim()}
                onClick={() => onAdvanceProject(project, note.trim())}
              >
                {blockers.length
                  ? "Advance anyway"
                  : `Advance to ${nextStage}`}
              </button>
            </div>
          </>
        ) : null}

        {target.kind === "evidence" ? (
          <>
            <section className="review-section">
              <h4>New evidence record</h4>
              <p className="muted">
                A capture is a real record — title, checkpoint type, and
                the charter criteria it supports. Coverage (
                {coverage}% today) is recalculated from records; there is
                no +10% button anymore.
              </p>
            </section>
            <section className="review-section review-form">
              <label>
                Title
                <input
                  value={title}
                  onChange={(event) => setTitle(event.target.value)}
                  placeholder="e.g. Intake test run — 30 synthetic referrals"
                  autoFocus
                />
              </label>
              <div className="review-form-grid">
                <label>
                  Checkpoint type
                  <select
                    value={checkpointType}
                    onChange={(event) =>
                      setCheckpointType(
                        event.target.value as EvidenceRecord["checkpointType"],
                      )
                    }
                  >
                    <option value="test-run">Test run</option>
                    <option value="review">Review</option>
                    <option value="document">Document</option>
                    <option value="metric">Metric</option>
                    <option value="sign-off">Sign-off</option>
                  </select>
                </label>
                <label>
                  Related gate (optional)
                  <select
                    value={gateId}
                    onChange={(event) => setGateId(event.target.value)}
                  >
                    <option value="">None</option>
                    {gates
                      .filter((item) => item.projectId === project.id)
                      .map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.label}
                        </option>
                      ))}
                  </select>
                </label>
              </div>
              <label>
                Note
                <textarea
                  value={note}
                  onChange={(event) => setNote(event.target.value)}
                  rows={3}
                  placeholder="What does this evidence show? Numbers beat adjectives."
                />
              </label>
            </section>
            <section className="review-section">
              <h4>Criteria this record supports</h4>
              {project.charter.successCriteria.length ? (
                <ul className="review-criteria">
                  {project.charter.successCriteria.map((criterion) => (
                    <li key={criterion}>
                      <label className="review-check">
                        <input
                          type="checkbox"
                          checked={pickedCriteria.includes(criterion)}
                          onChange={(event) =>
                            setPickedCriteria((current) =>
                              event.target.checked
                                ? [...current, criterion]
                                : current.filter((c) => c !== criterion),
                            )
                          }
                        />
                        <span>
                          {criterion}
                          <br />
                          <small>
                            {covered.has(criterion)
                              ? "Already covered — this record adds corroboration"
                              : "Not yet covered — capturing raises coverage"}
                          </small>
                        </span>
                      </label>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="muted">
                  This project's charter has no success criteria yet, so
                  the record is captured without criteria coverage.
                </p>
              )}
            </section>
            <div className="review-actions">
              <button className="quiet" onClick={onClose}>
                Cancel
              </button>
              <button
                className="primary"
                disabled={
                  !title.trim() ||
                  (project.charter.successCriteria.length > 0 &&
                    pickedCriteria.length === 0)
                }
                onClick={() =>
                  onCaptureEvidence(project, {
                    title: title.trim(),
                    checkpointType,
                    gateId: gateId || null,
                    note: note.trim(),
                    criteria: pickedCriteria,
                  })
                }
              >
                Capture evidence
              </button>
            </div>
          </>
        ) : null}
      </aside>
    </div>
  );
}
