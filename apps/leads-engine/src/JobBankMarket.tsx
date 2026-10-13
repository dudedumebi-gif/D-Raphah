import { useEffect, useState } from "react";
import {
  apiRequest,
  type JobBankMarketView,
  type JobBankRoleStat,
  type Session,
} from "./api";

function Metric({
  label,
  value,
  detail,
}: {
  label: string;
  value: string;
  detail: string;
}) {
  return (
    <div className="metric">
      <p>{label}</p>
      <strong>{value}</strong>
      <small>{detail}</small>
    </div>
  );
}

function monthLabel(period: string | null): string {
  if (!period) return "—";
  const date = new Date(`${period}T12:00:00Z`);
  return date.toLocaleDateString("en-CA", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

function Delta({ stat }: { stat: JobBankRoleStat }) {
  if (stat.deltaPct === null) return <span>new</span>;
  if (stat.deltaPct === 0) return <span>— 0%</span>;
  const arrow = stat.deltaPct > 0 ? "▲" : "▼";
  return (
    <span>
      {arrow} {Math.abs(stat.deltaPct)}%
    </span>
  );
}

function RoleTable({
  title,
  detail,
  roles,
  current,
  previous,
}: {
  title: string;
  detail: string;
  roles: JobBankRoleStat[];
  current: string | null;
  previous: string | null;
}) {
  return (
    <section className="panel">
      <div className="panel-head">
        <div>
          <h3>{title}</h3>
          <p>{detail}</p>
        </div>
      </div>
      <div className="table jobbank-roles-table">
        <div className="table-head">
          <span>Role</span>
          <span>{monthLabel(current)}</span>
          <span>{monthLabel(previous)}</span>
          <span>Change</span>
        </div>
        {roles.length ? (
          roles.map((stat) => (
            <div className="table-row" key={stat.role}>
              <span>{stat.role}</span>
              <span>{stat.currentMonth}</span>
              <span>{stat.previousMonth}</span>
              <span>
                <Delta stat={stat} />
              </span>
            </div>
          ))
        ) : (
          <div className="table-row">
            <span>No postings in the current snapshot.</span>
            <span />
            <span />
            <span />
          </div>
        )}
      </div>
    </section>
  );
}

export function JobBankMarket({
  session,
  workspaceId,
}: {
  session: Session;
  workspaceId: string;
}) {
  const [view, setView] = useState<JobBankMarketView | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let cancelled = false;
    apiRequest<{ data?: JobBankMarketView }>(
      session,
      workspaceId,
      "/api/v1/job-bank-market",
    )
      .then((payload) => {
        if (cancelled) return;
        if (payload?.data) setView(payload.data);
        else setFailed(true);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [session, workspaceId]);

  if (failed) {
    return (
      <div className="content">
        <section className="panel">
          <div className="panel-head">
            <div>
              <h3>Job Bank market demand</h3>
              <p>Market data is unavailable right now — try again shortly.</p>
            </div>
          </div>
        </section>
      </div>
    );
  }
  if (!view) {
    return (
      <div className="content">
        <section className="panel">
          <div className="panel-head">
            <div>
              <h3>Job Bank market demand</h3>
              <p>Loading the latest snapshot…</p>
            </div>
          </div>
        </section>
      </div>
    );
  }

  const topTorontoRole = view.toronto.roles[0];
  return (
    <div className="content">
      <section className="metrics">
        <Metric
          label="Toronto postings (60 days)"
          value={String(view.toronto.postings)}
          detail={`Scoring signal needs ≥ ${view.threshold} in a clinic's city`}
        />
        <Metric
          label="Top Toronto role"
          value={topTorontoRole ? topTorontoRole.role : "—"}
          detail={
            topTorontoRole
              ? `${topTorontoRole.currentMonth} postings in ${monthLabel(view.periods.current)}`
              : "No postings in the snapshot"
          }
        />
        <Metric
          label="Cities with demand"
          value={String(view.totalCities)}
          detail="Clinic front-desk roles, trailing 60 days"
        />
        <Metric
          label="Snapshot"
          value={
            view.syncedAt
              ? new Date(view.syncedAt).toLocaleDateString("en-CA")
              : "Never"
          }
          detail="Refreshes daily while the source gate holds"
        />
      </section>

      {!view.gateApproved ? (
        <section className="panel">
          <div className="panel-head">
            <div>
              <h3>Market sync is paused — source gate not satisfied</h3>
              <p>
                The Job Bank dataset is collected only while an approved
                Job Bank discovery source is active: register one under
                Discovery against a source with a human-approved
                collection policy, and accept the Open Government Licence
                – Canada terms. Until then the snapshot does not refresh
                and the scoring bridge stays silent.
              </p>
            </div>
          </div>
        </section>
      ) : view.syncedAt === null ? (
        <section className="panel">
          <div className="panel-head">
            <div>
              <h3>Source gate satisfied — first sync pending</h3>
              <p>
                The next worker tick downloads the current Job Bank
                snapshot; this view populates from it.
              </p>
            </div>
          </div>
        </section>
      ) : null}

      <RoleTable
        title="Top roles — Toronto"
        detail="Clinic front-desk postings by role, month over month. This is the demand the scoring bridge reads as market intent (inferential — Job Bank does not disclose employers)."
        roles={view.toronto.roles}
        current={view.periods.current}
        previous={view.periods.previous}
      />
      <RoleTable
        title="Top roles — Canada"
        detail="The same role family across every city in the snapshot."
        roles={view.nationalRoles}
        current={view.periods.current}
        previous={view.periods.previous}
      />

      <section className="panel">
        <div className="panel-head">
          <div>
            <h3>Top cities</h3>
            <p>
              Postings for clinic front-desk roles in the last{" "}
              {view.windowDays} days (Canada Job Bank open data).
            </p>
          </div>
        </div>
        <div className="table jobbank-cities-table">
          <div className="table-head">
            <span>City</span>
            <span>Province</span>
            <span>Postings</span>
            <span>Latest posting</span>
          </div>
          {view.cities.length ? (
            view.cities.map((row) => (
              <div
                className="table-row"
                key={`${row.city}-${row.province}`}
              >
                <span>{row.city}</span>
                <span>{row.province}</span>
                <span>{row.postings}</span>
                <span>{row.latestPosted ?? "—"}</span>
              </div>
            ))
          ) : (
            <div className="table-row">
              <span>No snapshot yet.</span>
              <span />
              <span />
              <span />
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
