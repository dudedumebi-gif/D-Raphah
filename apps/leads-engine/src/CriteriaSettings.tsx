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
  opportunityPotentialMin?: number;
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
  const [busy, setBusy] = useState(false);
  const [applying, setApplying] = useState(false);
  const [requeuing, setRequeuing] = useState(false);
  const [autoApply, setAutoApply] = useState(
    (campaign as CampaignWithAutoApply).auto_apply_criteria === true,
  );
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
              opportunityPotentialMin: Number(form.get("potential")),
              confidenceMin: Number(form.get("confidence")) / 100,
              minimumEvidenceCategories: Number(form.get("coverage")),
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
              Suggested values: maturity ≤{" "}
              {suggestion.changes.automationMaturityMax}, opportunity ≥{" "}
              {suggestion.changes.opportunityPotentialMin}, confidence ≥{" "}
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
              Maximum maturity
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
              Minimum opportunity
              <input
                name="potential"
                type="number"
                min="0"
                max="100"
                required
                defaultValue={criteria.opportunityPotentialMin ?? 60}
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
                defaultValue={(criteria.confidenceMin ?? 0.7) * 100}
              />
            </label>
            <label>
              Evidence categories
              <input
                name="coverage"
                type="number"
                min="1"
                max="6"
                required
                defaultValue={criteria.minimumEvidenceCategories ?? 2}
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
  const campaigns = data.campaigns;
  const effectiveOpenId = openId ?? campaigns[0]?.id ?? null;
  return (
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
  );
}
