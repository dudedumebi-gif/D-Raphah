import { useState, type FormEvent } from "react";
import type { BootstrapData, CampaignRecord } from "./api";

type Mutate = <T>(
  path: string,
  init: RequestInit,
  success: string,
) => Promise<T | null>;
// auto_apply_criteria arrives via bootstrap select("*") once migration
// 202609240003 is applied; kept local so api.ts stays untouched.
type CampaignWithAutoApply = CampaignRecord & {
  auto_apply_criteria?: boolean | null;
};
type EditableCriteria = {
  automationMaturityMax?: number;
  qualificationScoreMin?: number;
  jobBankMarketStrength?: number;
  confidenceMin?: number;
  minimumEvidenceCategories?: number;
  targetQualifiedLeadsPerWeek?: number;
  geography?: {
    mode?: string;
    cities?: string[];
    regions?: string[];
    radiusKm?: number;
    centreLatitude?: number | null;
    centreLongitude?: number | null;
  };
};

function CampaignSettings({
  campaign,
  mutate,
  sourceStatus,
  open,
  onToggle,
}: {
  campaign: CampaignRecord;
  mutate: Mutate;
  sourceStatus: string | null;
  open: boolean;
  onToggle: () => void;
}) {
  const criteria = campaign.criteria as EditableCriteria;
  const [mode, setMode] = useState(criteria.geography?.mode ?? "regions");
  const [jobBankStrength, setJobBankStrength] = useState(
    criteria.jobBankMarketStrength ?? 20,
  );
  const [busy, setBusy] = useState(false);
  const [applying, setApplying] = useState(false);
  const [requeuing, setRequeuing] = useState(false);
  const [autoApply, setAutoApply] = useState(
    (campaign as CampaignWithAutoApply).auto_apply_criteria === true,
  );
  const [rescoring, setRescoring] = useState(false);
  const [dryRunning, setDryRunning] = useState(false);
  const [rescoreSummary, setRescoreSummary] = useState<string | null>(null);
  const [dryRun, setDryRun] = useState<{
    total: number;
    projectedQualified: number;
    newlyQualified: number;
    alreadyCurrent: number;
    threshold: number;
    marketStrength: number;
    top: Array<{
      organization: string;
      domain: string | null;
      currentScore: number;
      projectedScore: number;
      currentQualified: boolean;
      projectedQualified: boolean;
      intentBefore: number | null;
      intentAfter: number;
    }>;
  } | null>(null);
  const [thresholdInput, setThresholdInput] = useState(
    criteria.qualificationScoreMin ?? 60,
  );
  const [strengthInput, setStrengthInput] = useState(
    criteria.jobBankMarketStrength ?? 20,
  );
  const [retiring, setRetiring] = useState(false);
  const suggestion = campaign.criteria_suggestion;
  const usesRadius = mode === "radius" || mode === "hybrid";
  const hasSuggestedChanges =
    suggestion != null && Object.keys(suggestion.changes).length > 0;
  const lastSuggestionAt = (
    campaign as { last_suggestion_at?: string | null }
  ).last_suggestion_at;
  const summaryLine = suggestion
    ? `Output recommendation: ${suggestion.direction} — ${suggestion.observedQualifiedLeads}/${suggestion.targetQualifiedLeads} distinct qualified organizations this week`
    : lastSuggestionAt
      ? "Criteria reviewed — no new recommendation until fresh scrape output arrives."
      : "No recommendation yet — run a scrape job to generate one.";
  async function applySuggestion() {
    setApplying(true);
    try {
      await mutate(
        `/api/v1/criteria/${campaign.id}/apply-suggestion`,
        { method: "POST" },
        `Suggestion applied to ${campaign.name}.`,
      );
    } finally {
      setApplying(false);
    }
  }
  async function retire() {
    setRetiring(true);
    try {
      await mutate(
        `/api/v1/criteria/${campaign.id}/retire`,
        { method: "POST", body: JSON.stringify({}) },
        `${campaign.name} retired to History.`,
      );
    } finally {
      setRetiring(false);
    }
  }
  async function runDryRun() {
    setDryRunning(true);
    setDryRun(null);
    try {
      const payload = await mutate<{ data?: typeof dryRun }>(
        `/api/v1/criteria/${campaign.id}/rescore`,
        {
          method: "POST",
          body: JSON.stringify({
            dryRun: true,
            thresholdOverride: thresholdInput,
            strengthOverride: strengthInput,
          }),
        },
        "Dry-run complete — no records written.",
      );
      if (payload?.data) setDryRun(payload.data);
    } finally {
      setDryRunning(false);
    }
  }
  async function rescore() {
    setRescoring(true);
    setRescoreSummary(null);
    let rescanned = 0;
    let alreadyCurrent = 0;
    let newlyQualified = 0;
    let unqualified = 0;
    let total = 0;
    try {
      // The route scores a bounded batch per call and skips rows
      // already current under these parameters; loop until it
      // reports nothing remaining.
      for (let guard = 0; guard < 200; guard += 1) {
        const payload = await mutate<{
          data?: {
            total: number;
            rescanned: number;
            alreadyCurrent: number;
            newlyQualified: number;
            unqualified: number;
            remaining: number;
          };
        }>(
          `/api/v1/criteria/${campaign.id}/rescore`,
          {
            method: "POST",
            body: JSON.stringify({
              limit: 25,
              thresholdOverride: thresholdInput,
              strengthOverride: strengthInput,
            }),
          },
          "Rescoring stored assessments…",
        );
        const batch = payload?.data;
        if (!batch) break;
        total = batch.total;
        rescanned += batch.rescanned;
        alreadyCurrent = batch.alreadyCurrent;
        newlyQualified += batch.newlyQualified;
        unqualified += batch.unqualified;
        if (batch.remaining === 0 || batch.rescanned === 0) break;
      }
      setRescoreSummary(
        `Rescored ${rescanned} of ${total} assessments at threshold ${thresholdInput} / strength ${strengthInput}: ${newlyQualified} newly qualified, ${unqualified} unqualified, ${alreadyCurrent} already current. New assessments were written; originals are preserved.`,
      );
    } finally {
      setRescoring(false);
    }
  }
  async function requeue() {
    setRequeuing(true);
    try {
      await mutate(
        "/api/v1/scrape-jobs",
        {
          method: "POST",
          headers: { "idempotency-key": crypto.randomUUID() },
          body: JSON.stringify({ sourceId: campaign.source_id }),
        },
        `Scrape job queued for ${campaign.name} with the current criteria. Watch it in the Scrape jobs view.`,
      );
    } finally {
      setRequeuing(false);
    }
  }
  async function toggleAutoApply(next: boolean) {
    setAutoApply(next);
    const result = await mutate(
      `/api/v1/criteria/${campaign.id}/auto-apply`,
      { method: "PATCH", body: JSON.stringify({ autoApply: next }) },
      `Auto-apply ${next ? "enabled" : "disabled"} for ${campaign.name}.`,
    );
    // mutate() reports failures via the notice and returns null — revert the
    // optimistic toggle so the checkbox reflects server state.
    if (result === null) setAutoApply(!next);
  }
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const list = (name: string) =>
      String(form.get(name) ?? "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean);
    const nullableNumber = (name: string) =>
      String(form.get(name) ?? "").trim() ? Number(form.get(name)) : null;
    setBusy(true);
    try {
      await mutate(
        `/api/v1/criteria/${campaign.id}`,
        {
          method: "PATCH",
          body: JSON.stringify({
            criteria: {
              ...campaign.criteria,
              automationMaturityMax: Number(form.get("maturity")),
              qualificationScoreMin: Number(form.get("qualification")),
              jobBankMarketStrength: Number(form.get("jobbank")),
              confidenceMin: Number(form.get("confidence")) / 100,
              targetQualifiedLeadsPerWeek: Number(form.get("target")),
              geography: {
                mode,
                cities: list("cities"),
                regions: list("regions"),
                radiusKm: Number(form.get("radius")),
                centreLatitude: usesRadius ? nullableNumber("latitude") : null,
                centreLongitude: usesRadius
                  ? nullableNumber("longitude")
                  : null,
              },
            },
            scheduleEnabled: form.get("enabled") === "on",
            intervalMinutes: Number(form.get("interval")),
          }),
        },
        `${campaign.name} criteria and schedule updated.`,
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="panel form-panel">
      <div
        className="panel-head criteria-toggle"
        onClick={onToggle}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            onToggle();
          }
        }}
        role="button"
        tabIndex={0}
        aria-expanded={open}
        title={open ? "Collapse" : "Expand"}
      >
        <div>
          <h3>
            <span aria-hidden="true">{open ? "▾" : "▸"}</span> {campaign.name}
          </h3>
          <p>{summaryLine}</p>
        </div>
      </div>
      {open ? (
        <>
      {suggestion ? (
        <div
          className={`criteria-suggestion suggestion-${suggestion.direction}`}
        >          <b>Output recommendation: {suggestion.direction}</b>
          <span>
            {suggestion.observedQualifiedLeads}/
            {suggestion.targetQualifiedLeads} distinct qualified organizations
            this week
          </span>
          <small>{suggestion.rationale.join(" ")}</small>
          {Object.keys(suggestion.changes).length ? (
            <small>
              Suggested values: qualification score ≥{" "}
              {suggestion.changes.qualificationScoreMin ?? "—"}, confidence ≥{" "}
              {suggestion.changes.confidenceMin != null
                ? `${Math.round(suggestion.changes.confidenceMin * 100)}%`
                : "—"}
              {suggestion.changes.geography?.centreLatitude != null &&
              suggestion.changes.geography?.centreLongitude != null
                ? `, centre (${suggestion.changes.geography.centreLatitude}, ${suggestion.changes.geography.centreLongitude})`
                : ""}
              . Review and enter below to apply.
            </small>
          ) : null}
          {hasSuggestedChanges ? (
            <div>
              <button
                type="button"
                className="primary"
                disabled={busy || applying}
                onClick={() => void applySuggestion()}
              >
                {applying ? "Applying…" : "Apply suggestion"}
              </button>
            </div>
          ) : null}
        </div>
      ) : lastSuggestionAt ? (
        <div className="criteria-suggestion suggestion-hold">
          <small>
            Criteria reviewed — no new recommendation until fresh scrape output
            arrives. Run a scrape job to get an updated recommendation.
          </small>
        </div>
      ) : null}
      <form className="inline-form" onSubmit={(event) => void save(event)}>
        <fieldset disabled={busy} style={{ border: 0, padding: 0, margin: 0 }}>
          <div className="form-grid">
            <label>
              Qualification score (min)
              <input
                name="qualification"
                type="number"
                min="0"
                max="100"
                required
                defaultValue={criteria.qualificationScoreMin ?? 60}
              />
            </label>
            <label>
              AI-enablement threshold (maturity ≤)
              <input
                name="maturity"
                type="number"
                min="0"
                max="100"
                required
                defaultValue={criteria.automationMaturityMax ?? 40}
              />
            </label>
            <label>
              Confidence %
              <input
                name="confidence"
                type="number"
                min="0"
                max="100"
                required
                defaultValue={(criteria.confidenceMin ?? 0.6) * 100}
              />
            </label>
            <label>
              Weekly target
              <input
                name="target"
                type="number"
                min="1"
                max="10000"
                required
                defaultValue={criteria.targetQualifiedLeadsPerWeek ?? 20}
              />
            </label>
          </div>
          <label>
            Job Bank market signal strength — {jobBankStrength}
            <input
              name="jobbank"
              type="range"
              min="0"
              max="40"
              step="1"
              value={jobBankStrength}
              onChange={(event) =>
                setJobBankStrength(Number(event.target.value))
              }
            />
            <small>
              Adds market-level hiring evidence (Canada Job Bank postings
              for clinic front-desk roles in the clinic's city, last 60
              days) to the intent/trigger factor. Inferential — Job Bank
              does not disclose employers. 0 turns it off; on-site hiring
              signals weigh 14–22.
            </small>
          </label>
          <label>
            Geography mode
            <select
              value={mode}
              onChange={(event) => setMode(event.target.value)}
            >
              <option value="regions">Named cities / regions</option>
              <option value="radius">Radius only</option>
              <option value="hybrid">Radius and named market</option>
            </select>
          </label>
          <label>
            Cities (comma separated)
            <input
              name="cities"
              defaultValue={(
                criteria.geography?.cities ?? ["Toronto", "Ottawa", "Montreal"]
              ).join(", ")}
            />
          </label>
          <label>
            Regions (used when no city is specified)
            <input
              name="regions"
              defaultValue={(
                criteria.geography?.regions ?? ["Ontario", "Quebec"]
              ).join(", ")}
            />
          </label>
          <div className="form-grid">
            <label>
              Radius km
              <input
                name="radius"
                type="number"
                min="1"
                max="1000"
                required
                defaultValue={criteria.geography?.radiusKm ?? 50}
              />
            </label>
            <label>
              Centre latitude
              <input
                name="latitude"
                type="number"
                step="any"
                min="-90"
                max="90"
                required={usesRadius}
                defaultValue={criteria.geography?.centreLatitude ?? ""}
              />
            </label>
            <label>
              Centre longitude
              <input
                name="longitude"
                type="number"
                step="any"
                min="-180"
                max="180"
                required={usesRadius}
                defaultValue={criteria.geography?.centreLongitude ?? ""}
              />
            </label>
          </div>
          <p className="muted">
            Radius qualification requires unambiguous coordinates in source
            structured data. Missing location evidence does not qualify. Named
            locations are text signals, not verified business addresses.
          </p>
          <label>
            Interval minutes
            <input
              name="interval"
              type="number"
              min="5"
              max="43200"
              required
              defaultValue={campaign.interval_minutes}
            />
          </label>
          <label className="check-label">
            <input
              name="enabled"
              type="checkbox"
              defaultChecked={campaign.schedule_enabled}
            />{" "}
            Enable persistent schedule
          </label>
          <label className="check-label">
            <input
              type="checkbox"
              checked={autoApply}
              disabled={busy || applying}
              onChange={(event) => void toggleAutoApply(event.currentTarget.checked)}
            />{" "}
            Auto-apply future suggestions (one bounded step per evaluation)
          </label>
          <p className="muted">
            Automatic (low-risk): bounded nudges to maximum maturity (±5),
            minimum opportunity (±5), confidence (±5 pts), and evidence
            categories (±1). Always manual: geography changes, factor weights,
            and qualifying signals.
          </p>
          {autoApply ? (
            <p className="muted">
              Auto-apply is on: scheduled evaluations move at most one bounded
              step toward the suggestion and record each change in the audit
              log. Default is off.
            </p>
          ) : null}
          <button className="primary">
            {busy ? "Saving…" : "Save reviewed criteria"}
          </button>
        </fieldset>
      </form>
      {sourceStatus === "active" ? (
        <div className="requeue-row">
          <p className="muted">
            Re-run this source&apos;s scrape with the current criteria — for
            example right after applying a suggestion or saving reviewed
            criteria. The job runs with whatever criteria are saved, so save
            first if you changed anything.
          </p>
          <button
            type="button"
            disabled={busy || applying || requeuing}
            onClick={() => void requeue()}
          >
            {requeuing ? "Queueing…" : "Re-queue scrape"}
          </button>
        </div>
      ) : null}
      <div className="requeue-row">
        <p className="muted">
          Re-score this campaign&apos;s stored assessments from their
          stored evidence — no re-scraping. Run a dry-run first: it
          projects qualifiers and the top 20 at the parameters below
          and writes nothing. A real rescore writes NEW assessments
          (originals preserved), reuses the stored signals plus the
          Job Bank market overlay, and never deletes opportunities.
          {rescoreSummary ? (
            <>
              <br />
              {rescoreSummary}
            </>
          ) : null}
        </p>
        <label>
          Threshold
          <input
            type="number"
            min={0}
            max={100}
            value={thresholdInput}
            onChange={(event) =>
              setThresholdInput(Number(event.target.value))
            }
          />
        </label>
        <label>
          Job Bank strength
          <input
            type="number"
            min={0}
            max={40}
            value={strengthInput}
            onChange={(event) => setStrengthInput(Number(event.target.value))}
          />
        </label>
        <button
          type="button"
          disabled={busy || applying || dryRunning || rescoring}
          onClick={() => void runDryRun()}
        >
          {dryRunning ? "Projecting…" : "Dry-run"}
        </button>
        <button
          type="button"
          disabled={busy || applying || dryRunning || rescoring}
          onClick={() => void rescore()}
        >
          {rescoring ? "Rescoring…" : "Rescore assessments"}
        </button>
      </div>
      {dryRun ? (
        <div className="requeue-row">
          <p className="muted">
            Dry-run at threshold {dryRun.threshold} / strength{" "}
            {dryRun.marketStrength}: {dryRun.projectedQualified} of{" "}
            {dryRun.total} projected qualified ({dryRun.newlyQualified}{" "}
            newly, {dryRun.alreadyCurrent} already current). Top 20 by
            projected score:
          </p>
          <table className="jobbank-table">
            <thead>
              <tr>
                <th>Organization</th>
                <th>Score</th>
                <th>Intent</th>
                <th>Qualified</th>
              </tr>
            </thead>
            <tbody>
              {dryRun.top.map((row) => (
                <tr key={row.organization}>
                  <td>{row.organization}</td>
                  <td>
                    {row.currentScore} → {row.projectedScore}
                  </td>
                  <td>
                    {row.intentBefore ?? "—"} → {row.intentAfter}
                  </td>
                  <td>
                    {row.projectedQualified
                      ? row.currentQualified
                        ? "Yes"
                        : "New"
                      : "No"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      <div className="requeue-row">
        <p className="muted">
          Retire this campaign to History when it is no longer in use.
          Its criteria, jobs, and assessments are preserved, criteria
          automation stops, and it can be restored at any time.
        </p>
        <button
          type="button"
          disabled={busy || applying || retiring}
          onClick={() => void retire()}
        >
          {retiring ? "Retiring…" : "Retire campaign"}
        </button>
      </div>
      </>
      ) : null}
    </section>
  );
}

export function Settings({
  data,
  mutate,
}: {
  data: BootstrapData;
  mutate: Mutate;
}) {
  // Accordion state: null follows the default (first campaign expanded,
  // the rest collapsed); a campaign id pins it open, "" pins all closed.
  const [openId, setOpenId] = useState<string | null>(null);
  const campaigns = data.campaigns.filter(
    (campaign) => campaign.status !== "retired",
  );
  const history = data.campaigns.filter(
    (campaign) => campaign.status === "retired",
  );
  const effectiveOpenId = openId ?? campaigns[0]?.id ?? null;
  return (
    <>
    <div className="content settings-grid">
      {campaigns.length ? (
        campaigns.map((campaign) => (
          <CampaignSettings
            key={`${campaign.id}:${JSON.stringify(campaign.criteria)}:${campaign.schedule_enabled}:${campaign.interval_minutes}`}
            campaign={campaign}
            mutate={mutate}
            sourceStatus={
              data.sources.find((source) => source.id === campaign.source_id)
                ?.status ?? null
            }
            open={effectiveOpenId === campaign.id}
            onToggle={() =>
              setOpenId(effectiveOpenId === campaign.id ? "" : campaign.id)
            }
          />
        ))
      ) : (
        <p>Create a source to configure its campaign.</p>
      )}
    </div>
    {history.length ? (
      <section className="panel history-panel">
        <div className="panel-head">
          <div>
            <h3>History — retired campaigns</h3>
            <p>
              Retired criteria are preserved for audit and can be
              restored; they no longer drive collection or automation.
            </p>
          </div>
        </div>
        <div className="record-list">
          {history.map((campaign) => (
            <div className="record-row" key={campaign.id}>
              <div>
                <b>{campaign.name}</b>
                <small>
                  Retired{" "}
                  {campaign.retired_at
                    ? new Date(campaign.retired_at).toLocaleDateString()
                    : ""}
                </small>
              </div>
              <button
                className="row-action"
                onClick={() =>
                  void mutate(
                    `/api/v1/criteria/${campaign.id}/restore`,
                    { method: "POST", body: JSON.stringify({}) },
                    `${campaign.name} restored.`,
                  )
                }
              >
                Restore
              </button>
            </div>
          ))}
        </div>
      </section>
    ) : null}
    </>
  );
}
