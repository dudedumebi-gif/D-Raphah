import { useEffect, useRef, useState } from "react";
import { fetchJobEventsText, type JobRecord, type Session } from "./api";
import {
  eventTimeLabel,
  isTerminalJobStatus,
  latestJobStatus,
  parseJobEvents,
  summarizeEvent,
  type JobEvent,
} from "./jobEvents";

const POLL_INTERVAL_MS = 2500;

interface Props {
  job: JobRecord;
  session: Session;
  workspaceId: string;
  onClose: () => void;
}

function hostnameOf(targetUrl: string): string {
  try {
    return new URL(targetUrl).hostname;
  } catch {
    return targetUrl;
  }
}

/**
 * Small docked window showing live scrape-job progress. Polls the pollable
 * SSE timeline (GET /api/v1/scrape-jobs/{id}/events) while the job is active
 * and freezes on the final timeline once it reaches a terminal status.
 */
export function JobLiveWindow({ job, session, workspaceId, onClose }: Props) {
  const [events, setEvents] = useState<JobEvent[]>([]);
  const [error, setError] = useState("");
  const [live, setLive] = useState(true);
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);
  const timer = useRef<number | null>(null);
  const scroller = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function poll() {
      try {
        const payload = await fetchJobEventsText(
          session,
          workspaceId,
          job.id,
        );
        if (cancelled) return;
        const parsed = parseJobEvents(payload);
        setEvents(parsed);
        setError("");
        setUpdatedAt(new Date());
        const status = latestJobStatus(parsed, job.status);
        const terminal = isTerminalJobStatus(status);
        setLive(!terminal);
        if (terminal && timer.current !== null) {
          window.clearInterval(timer.current);
          timer.current = null;
        }
      } catch (err) {
        if (!cancelled)
          setError(err instanceof Error ? err.message : String(err));
      }
    }
    void poll();
    timer.current = window.setInterval(() => {
      if (document.visibilityState === "visible") void poll();
    }, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      if (timer.current !== null) window.clearInterval(timer.current);
    };
  }, [job.id, job.status, session, workspaceId]);

  useEffect(() => {
    const node = scroller.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [events.length]);

  const status = latestJobStatus(events, job.status) ?? job.status;
  const attemptEvents = events.filter((event) => event.type === "attempt");

  return (
    <div
      className="live-drawer"
      role="dialog"
      aria-label={`Live progress for scrape job ${job.id.slice(0, 8)}`}
    >
      <div className="live-drawer-head">
        <div>
          <b>{hostnameOf(job.target_url)}</b>
          <small>
            {job.id.slice(0, 8)} ·{" "}
            <span className={`badge status-${status.replace(/_/g, "-")}`}>
              {status.replace(/_/g, " ")}
            </span>
          </small>
        </div>
        <div className="live-drawer-meta">
          <span
            className={live ? "live-dot live" : "live-dot done"}
            title={live ? "Polling for updates" : "Job reached a terminal state"}
          />
          <button
            className="row-action"
            onClick={onClose}
            aria-label="Close live window"
          >
            Close
          </button>
        </div>
      </div>
      <div className="live-drawer-progress">
        <span>
          Attempt {job.attempt_count}/{job.max_attempts}
        </span>
        <span>{attemptEvents.length} attempt events</span>
        <span>
          {updatedAt
            ? `Updated ${updatedAt.toLocaleTimeString()}`
            : "Connecting…"}
        </span>
      </div>
      {error ? <div className="live-drawer-error">{error}</div> : null}
      <div className="live-timeline" ref={scroller}>
        {events.length === 0 && !error ? (
          <div className="live-empty">Waiting for the first events…</div>
        ) : null}
        {events.map((event, index) => (
          <div
            className={`live-row live-row-${event.type}`}
            key={`${event.at}-${event.type}-${index}`}
          >
            <time>{eventTimeLabel(event)}</time>
            <span className="live-type">{event.type}</span>
            <span className="live-summary">{summarizeEvent(event)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
