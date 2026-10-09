import { useMemo, useState } from "react";
import {
  EXPORT_FORMATS,
  NODE_MAPPINGS,
  mappingFor,
  type ExportFormat,
  type ExportWorkflow,
} from "./export";
import "./export.css";

/* ── Export panel (Phase 4) ────────────────────────────────────────────
 * Download a workflow as portable DF JSON, a workflows-as-code scaffold,
 * or a cloud transpilation (Step Functions ASL / Logic Apps / Google
 * Cloud Workflows). The node-mapping table is shown before the download
 * so the fidelity gaps — draft-first outreach, DF-internal ops — are
 * explicit, and every generated file carries the same notes.
 */

const FIDELITY_LABEL = {
  native: "Native",
  approximate: "Approximate",
  manual: "Manual pattern",
} as const;

export function ExportPanel({
  workflow,
  onClose,
}: {
  workflow: ExportWorkflow;
  onClose: () => void;
}) {
  const [formatId, setFormatId] = useState<ExportFormat["id"]>("df-json");
  const [copied, setCopied] = useState(false);
  const format = EXPORT_FORMATS.find((f) => f.id === formatId) ?? EXPORT_FORMATS[0];
  const content = useMemo(() => format.generate(workflow), [format, workflow]);
  const filename = format.filename(workflow);
  const presentKinds = useMemo(
    () => [...new Set(workflow.nodes.map((n) => n.kind))],
    [workflow],
  );

  const download = () => {
    const blob = new Blob([content], { type: format.mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(content);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div
      className="export-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section className="export-panel" role="dialog" aria-modal="true">
        <div className="export-head">
          <div>
            <p className="eyebrow accent">Export workflow</p>
            <h3>{workflow.name}</h3>
            <p className="muted">
              {workflow.environment} · {workflow.nodes.length} nodes ·{" "}
              {workflow.edges.length} edges. Exports are scaffolds generated
              from the live definition — review before deploying anywhere.
            </p>
          </div>
          <button className="btn-ghost" onClick={onClose}>
            Close
          </button>
        </div>

        <div className="export-formats" role="tablist">
          {EXPORT_FORMATS.map((f) => (
            <button
              key={f.id}
              role="tab"
              aria-selected={f.id === formatId}
              className={f.id === formatId ? "active" : ""}
              onClick={() => setFormatId(f.id)}
            >
              {f.label}
            </button>
          ))}
        </div>

        <div className="export-actions">
          <code className="export-filename">{filename}</code>
          <button className="btn-primary" onClick={download}>
            Download
          </button>
          <button className="btn-ghost" onClick={() => void copy()}>
            {copied ? "Copied ✓" : "Copy"}
          </button>
        </div>
        <pre className="export-preview">{content}</pre>

        <h4 className="export-table-title">
          Node mapping — how this workflow's steps translate
        </h4>
        <div className="export-table-wrap">
          <table className="export-table">
            <thead>
              <tr>
                <th>DF node</th>
                <th>AWS Step Functions</th>
                <th>Azure Logic Apps</th>
                <th>Google Cloud Workflows</th>
                <th>Fidelity</th>
              </tr>
            </thead>
            <tbody>
              {presentKinds.map((kind) => {
                const m = mappingFor(kind);
                return (
                  <tr key={kind}>
                    <td>
                      <b>{kind}</b>
                    </td>
                    <td>{m.aws}</td>
                    <td>{m.azure}</td>
                    <td>{m.gcp}</td>
                    <td>
                      <span className={`fidelity fidelity-${m.fidelity}`}>
                        {FIDELITY_LABEL[m.fidelity]}
                      </span>
                      <small className="export-note">{m.note}</small>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="muted export-footnote">
          Full mapping covers all {NODE_MAPPINGS.length} DF node kinds; the
          same notes are embedded in the generated files. The honest gaps:
          DF outreach is draft-first (a human approves before anything
          sends) and DF-internal operations (create_project, update_status,
          assign_gate) have no cloud equivalent — they become calls to your
          own systems.
        </p>
      </section>
    </div>
  );
}
