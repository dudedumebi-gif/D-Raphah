import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getAuthToken, notifyUnauthorized } from "./auth";

/* ── Types (mirror api/_lib/workflows.ts) ─────────────────────────────── */

export type NodeKind = string;

interface ConfigField {
  key: string;
  label: string;
  kind: "text" | "textarea" | "number" | "select" | "toggle" | "json";
  placeholder?: string;
  options?: Array<{ value: string; label: string }>;
  help?: string;
}

interface NodeSpec {
  kind: string;
  type: "trigger" | "action" | "logic";
  label: string;
  icon: string;
  description: string;
  defaultConfig: Record<string, unknown>;
  configSchema: ConfigField[];
}

interface BuilderNode {
  node_key: string;
  type: "trigger" | "action" | "logic";
  kind: string;
  label: string;
  position_x: number;
  position_y: number;
  config: Record<string, unknown>;
  enabled: boolean;
}

interface BuilderEdge {
  edge_key: string;
  from_node_key: string;
  to_node_key: string;
  from_port: string | null;
}

interface WorkflowSummary {
  id: string;
  name: string;
  status: "draft" | "published" | "archived";
  trigger_type: string;
  updated_at: string;
}

interface WorkflowDetail extends WorkflowSummary {
  description: string | null;
  nodes: BuilderNode[];
  edges: BuilderEdge[];
}

interface RunStep {
  node_key: string;
  node_kind: string;
  node_label: string;
  status: string;
  input: Record<string, unknown> | null;
  output: Record<string, unknown> | null;
  error: string | null;
  started_at: string;
  completed_at: string | null;
}

interface WorkflowRun {
  id: string;
  status: string;
  trigger_type: string;
  error: string | null;
  started_at: string;
  completed_at: string | null;
  steps?: RunStep[];
}

const NODE_W = 208;
const NODE_H = 84;

let keyCounter = 0;
function newKey(prefix: string): string {
  keyCounter += 1;
  return `${prefix}-${Date.now().toString(36)}-${keyCounter}`;
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  const initHeaders = init?.headers as Record<string, string> | undefined;
  if (initHeaders) Object.assign(headers, initHeaders);
  // Operator session token, same-origin DF API only (never leak it cross-origin).
  const token = getAuthToken();
  if (token && path.startsWith("/api/")) {
    headers.authorization = `Bearer ${token}`;
  }
  const res = await fetch(path, { ...init, headers });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) notifyUnauthorized();
    throw new Error(
      typeof data.error === "string" ? data.error : `Request failed (${res.status})`,
    );
  }
  return data as T;
}

/* ── Workflow list ───────────────────────────────────────────────────── */

function WorkflowList(props: {
  onOpen: (id: string) => void;
  onNew: () => void;
  refreshToken: number;
}) {
  const [workflows, setWorkflows] = useState<WorkflowSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    api<{ workflows: WorkflowSummary[] }>("/api/workflows")
      .then((d) => {
        setWorkflows(d.workflows);
        setError(null);
      })
      .catch((e: unknown) =>
        setError(e instanceof Error ? e.message : "Failed to load"),
      )
      .finally(() => setLoading(false));
  }, [props.refreshToken]);

  return (
    <div className="wf-list">
      <div className="wf-list-head">
        <div>
          <h2>Automation workflows</h2>
          <p className="muted">
            Visual, auditable automations — triggers, actions and logic gates.
            Every run is recorded step by step.
          </p>
        </div>
        <button className="btn-primary" onClick={props.onNew}>
          + New workflow
        </button>
      </div>
      {loading && <p className="muted">Loading…</p>}
      {error && <p className="wf-error">{error}</p>}
      {!loading && !error && workflows.length === 0 && (
        <p className="muted">
          No workflows yet. Create one to automate lead follow-up, status
          updates, notifications and more.
        </p>
      )}
      <div className="wf-cards">
        {workflows.map((w) => (
          <button
            key={w.id}
            className="wf-card"
            onClick={() => props.onOpen(w.id)}
          >
            <span className={`wf-badge wf-badge-${w.status}`}>{w.status}</span>
            <span className="wf-card-name">{w.name}</span>
            <span className="wf-card-meta">
              {w.trigger_type} · updated{" "}
              {new Date(w.updated_at).toLocaleString()}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

/* ── Canvas editor ───────────────────────────────────────────────────── */

function edgePath(
  from: { x: number; y: number },
  to: { x: number; y: number },
): string {
  const dx = Math.max(40, Math.abs(to.x - from.x) / 2);
  return `M ${from.x} ${from.y} C ${from.x + dx} ${from.y}, ${to.x - dx} ${to.y}, ${to.x} ${to.y}`;
}

function BuilderCanvas(props: {
  workflow: WorkflowDetail;
  catalog: NodeSpec[];
  onChange: (wf: WorkflowDetail) => void;
}) {
  const { workflow, onChange } = props;
  const canvasRef = useRef<HTMLDivElement>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [selectedEdge, setSelectedEdge] = useState<string | null>(null);
  const [connectFrom, setConnectFrom] = useState<{
    nodeKey: string;
    port: string | null;
  } | null>(null);
  const [portMenu, setPortMenu] = useState<string | null>(null);
  const dragRef = useRef<{
    key: string;
    dx: number;
    dy: number;
  } | null>(null);

  const nodeByKey = useMemo(
    () => new Map(workflow.nodes.map((n) => [n.node_key, n])),
    [workflow.nodes],
  );

  const patchNode = useCallback(
    (key: string, patch: Partial<BuilderNode>) => {
      onChange({
        ...workflow,
        nodes: workflow.nodes.map((n) =>
          n.node_key === key ? { ...n, ...patch } : n,
        ),
      });
    },
    [workflow, onChange],
  );

  const addNode = useCallback(
    (spec: NodeSpec, x: number, y: number) => {
      const node: BuilderNode = {
        node_key: newKey("node"),
        type: spec.type,
        kind: spec.kind,
        label: spec.label,
        position_x: Math.round(x),
        position_y: Math.round(y),
        config: JSON.parse(JSON.stringify(spec.defaultConfig)) as Record<
          string,
          unknown
        >,
        enabled: true,
      };
      const next = {
        ...workflow,
        nodes: [...workflow.nodes, node],
      };
      // Auto-connect: if there is a selected node, link it to the new one.
      if (selectedKey && nodeByKey.has(selectedKey)) {
        next.edges = [
          ...next.edges,
          {
            edge_key: newKey("edge"),
            from_node_key: selectedKey,
            to_node_key: node.node_key,
            from_port: null,
          },
        ];
      }
      onChange(next);
      setSelectedKey(node.node_key);
      setSelectedEdge(null);
    },
    [workflow, onChange, selectedKey, nodeByKey],
  );

  const deleteSelected = useCallback(() => {
    if (selectedEdge) {
      onChange({
        ...workflow,
        edges: workflow.edges.filter((e) => e.edge_key !== selectedEdge),
      });
      setSelectedEdge(null);
      return;
    }
    if (selectedKey) {
      onChange({
        ...workflow,
        nodes: workflow.nodes.filter((n) => n.node_key !== selectedKey),
        edges: workflow.edges.filter(
          (e) =>
            e.from_node_key !== selectedKey && e.to_node_key !== selectedKey,
        ),
      });
      setSelectedKey(null);
    }
  }, [workflow, onChange, selectedKey, selectedEdge]);

  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if (
        (ev.key === "Delete" || ev.key === "Backspace") &&
        !(ev.target instanceof HTMLInputElement) &&
        !(ev.target instanceof HTMLTextAreaElement)
      ) {
        deleteSelected();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [deleteSelected]);

  const onNodeMouseDown = (
    ev: React.MouseEvent,
    node: BuilderNode,
  ) => {
    ev.stopPropagation();
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    dragRef.current = {
      key: node.node_key,
      dx: ev.clientX - rect.left - node.position_x,
      dy: ev.clientY - rect.top - node.position_y,
    };
    setSelectedKey(node.node_key);
    setSelectedEdge(null);
  };

  const onCanvasMouseMove = (ev: React.MouseEvent) => {
    const drag = dragRef.current;
    if (!drag) return;
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    patchNode(drag.key, {
      position_x: Math.max(0, Math.round(ev.clientX - rect.left - drag.dx)),
      position_y: Math.max(0, Math.round(ev.clientY - rect.top - drag.dy)),
    });
  };

  const onCanvasMouseUp = () => {
    dragRef.current = null;
  };

  const portPos = (node: BuilderNode, side: "in" | "out") => ({
    x: node.position_x + (side === "out" ? NODE_W : 0),
    y: node.position_y + NODE_H / 2,
  });

  const onOutputPortClick = (ev: React.MouseEvent, node: BuilderNode) => {
    ev.stopPropagation();
    if (node.kind === "if_else") {
      setPortMenu(portMenu === node.node_key ? null : node.node_key);
      return;
    }
    setConnectFrom({ nodeKey: node.node_key, port: null });
    setPortMenu(null);
  };

  const startBranchConnect = (nodeKey: string, port: "true" | "false") => {
    setConnectFrom({ nodeKey, port });
    setPortMenu(null);
  };

  const onInputPortClick = (ev: React.MouseEvent, node: BuilderNode) => {
    ev.stopPropagation();
    if (!connectFrom || connectFrom.nodeKey === node.node_key) {
      setConnectFrom(null);
      return;
    }
    // Avoid duplicate edges.
    const exists = workflow.edges.some(
      (e) =>
        e.from_node_key === connectFrom.nodeKey &&
        e.to_node_key === node.node_key &&
        (e.from_port ?? null) === connectFrom.port,
    );
    if (!exists) {
      onChange({
        ...workflow,
        edges: [
          ...workflow.edges,
          {
            edge_key: newKey("edge"),
            from_node_key: connectFrom.nodeKey,
            to_node_key: node.node_key,
            from_port: connectFrom.port,
          },
        ],
      });
    }
    setConnectFrom(null);
  };

  const groups = useMemo(() => {
    const g: Record<string, NodeSpec[]> = {
      Triggers: [],
      Actions: [],
      Logic: [],
    };
    for (const s of props.catalog) {
      if (s.type === "trigger") g.Triggers.push(s);
      else if (s.type === "action") g.Actions.push(s);
      else g.Logic.push(s);
    }
    return g;
  }, [props.catalog]);

  const selected = selectedKey ? nodeByKey.get(selectedKey) : undefined;
  const selectedSpec = selected
    ? props.catalog.find((s) => s.kind === selected.kind)
    : undefined;

  return (
    <div className="wf-builder">
      {/* Palette */}
      <aside className="wf-palette">
        {Object.entries(groups).map(([group, specs]) => (
          <div key={group} className="wf-palette-group">
            <h4>{group}</h4>
            <div className="wf-palette-items">
              {specs.map((s) => (
                <button
                  key={s.kind}
                  className="wf-palette-item"
                  title={s.description}
                  onClick={() =>
                    addNode(
                      s,
                      120 + (workflow.nodes.length % 4) * 60,
                      80 + (workflow.nodes.length % 6) * 70,
                    )
                  }
                >
                  <span className="wf-palette-icon">{s.icon}</span>
                  <span>{s.label}</span>
                </button>
              ))}
            </div>
          </div>
        ))}
        <p className="wf-hint">
          Click a block to add it. Drag blocks to arrange. Click a right-side
          port, then a left-side port to connect. If/Else ports branch on
          true/false.
        </p>
      </aside>

      {/* Canvas */}
      <div
        className="wf-canvas"
        ref={canvasRef}
        onMouseMove={onCanvasMouseMove}
        onMouseUp={onCanvasMouseUp}
        onMouseLeave={onCanvasMouseUp}
        onClick={() => {
          setSelectedKey(null);
          setSelectedEdge(null);
          setConnectFrom(null);
          setPortMenu(null);
        }}
      >
        <svg className="wf-edges">
          {workflow.edges.map((e) => {
            const from = nodeByKey.get(e.from_node_key);
            const to = nodeByKey.get(e.to_node_key);
            if (!from || !to) return null;
            const p1 = portPos(from, "out");
            const p2 = portPos(to, "in");
            const isSel = selectedEdge === e.edge_key;
            return (
              <g key={e.edge_key}>
                <path
                  d={edgePath(p1, p2)}
                  className={`wf-edge${isSel ? " selected" : ""}${
                    e.from_port ? ` wf-edge-${e.from_port}` : ""
                  }`}
                  onClick={(ev) => {
                    ev.stopPropagation();
                    setSelectedEdge(e.edge_key);
                    setSelectedKey(null);
                  }}
                />
                {e.from_port && (
                  <text
                    x={(p1.x + p2.x) / 2}
                    y={(p1.y + p2.y) / 2 - 8}
                    className="wf-edge-label"
                    textAnchor="middle"
                  >
                    {e.from_port}
                  </text>
                )}
              </g>
            );
          })}
        </svg>

        {workflow.nodes.map((n) => {
          const spec = props.catalog.find((s) => s.kind === n.kind);
          const isSel = selectedKey === n.node_key;
          return (
            <div
              key={n.node_key}
              className={`wf-node wf-node-${n.type}${isSel ? " selected" : ""}${
                n.enabled ? "" : " disabled"
              }`}
              style={{ left: n.position_x, top: n.position_y }}
              onMouseDown={(ev) => onNodeMouseDown(ev, n)}
            >
              <button
                className={`wf-port wf-port-in${
                  connectFrom ? " awaiting" : ""
                }`}
                title="Input — click after choosing an output port"
                onClick={(ev) => onInputPortClick(ev, n)}
              />
              <div className="wf-node-head">
                <span className="wf-node-icon">{spec?.icon ?? "⬛"}</span>
                <span className="wf-node-label">{n.label}</span>
                {!n.enabled && <span className="wf-node-off">off</span>}
              </div>
              <div className="wf-node-kind">{spec?.label ?? n.kind}</div>
              <button
                className={`wf-port wf-port-out${
                  connectFrom?.nodeKey === n.node_key ? " active" : ""
                }`}
                title="Output — click, then click a target input port"
                onClick={(ev) => onOutputPortClick(ev, n)}
              />
              {portMenu === n.node_key && (
                <div className="wf-port-menu" onMouseDown={(e) => e.stopPropagation()}>
                  <button onClick={() => startBranchConnect(n.node_key, "true")}>
                    ✓ true branch
                  </button>
                  <button onClick={() => startBranchConnect(n.node_key, "false")}>
                    ✗ false branch
                  </button>
                </div>
              )}
            </div>
          );
        })}

        {workflow.nodes.length === 0 && (
          <div className="wf-empty">
            <p>Empty canvas — add a trigger from the left palette to begin.</p>
          </div>
        )}

        {(selectedKey || selectedEdge) && (
          <button
            className="wf-delete"
            onMouseDown={(e) => e.stopPropagation()}
            onClick={deleteSelected}
          >
            Delete selected (Del)
          </button>
        )}
      </div>

      {/* Properties panel */}
      <aside className="wf-props">
        {selected && selectedSpec ? (
          <>
            <h3>Selected block</h3>
            <p className="wf-props-title">
              {selectedSpec.icon} {selectedSpec.label}
            </p>
            <label className="wf-field">
              <span>Block name</span>
              <input
                value={selected.label}
                onChange={(e) => patchNode(selected.node_key, { label: e.target.value })}
              />
            </label>
            <label className="wf-toggle">
              <span>Enable block</span>
              <button
                className={`toggle${selected.enabled ? " on" : ""}`}
                onClick={() =>
                  patchNode(selected.node_key, { enabled: !selected.enabled })
                }
                aria-pressed={selected.enabled}
              >
                <span className="toggle-knob" />
              </button>
            </label>
            {selectedSpec.configSchema.map((f) => (
              <ConfigInput
                key={f.key}
                field={f}
                value={selected.config[f.key]}
                onChange={(v) =>
                  patchNode(selected.node_key, {
                    config: { ...selected.config, [f.key]: v },
                  })
                }
              />
            ))}
            <p className="wf-hint">{selectedSpec.description}</p>
            <p className="wf-hint">
              Tip: use {"{{trigger.lead.name}}"} style variables — they resolve
              against the run context.
            </p>
          </>
        ) : (
          <>
            <h3>Selected block</h3>
            <p className="muted">Click a block on the canvas to edit it.</p>
          </>
        )}
      </aside>
    </div>
  );
}

function ConfigInput(props: {
  field: ConfigField;
  value: unknown;
  onChange: (v: unknown) => void;
}) {
  const { field, value, onChange } = props;
  const str = value == null ? "" : String(value);
  const jsonText =
    value == null ? "" : JSON.stringify(value, null, 2);

  switch (field.kind) {
    case "textarea":
      return (
        <label className="wf-field">
          <span>{field.label}</span>
          <textarea
            value={str}
            placeholder={field.placeholder}
            rows={4}
            onChange={(e) => onChange(e.target.value)}
          />
          {field.help && <small>{field.help}</small>}
        </label>
      );
    case "number":
      return (
        <label className="wf-field">
          <span>{field.label}</span>
          <input
            type="number"
            value={str}
            placeholder={field.placeholder}
            onChange={(e) => onChange(Number(e.target.value))}
          />
          {field.help && <small>{field.help}</small>}
        </label>
      );
    case "select":
      return (
        <label className="wf-field">
          <span>{field.label}</span>
          <select value={str} onChange={(e) => onChange(e.target.value)}>
            {field.options?.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
      );
    case "toggle":
      return (
        <label className="wf-toggle">
          <span>{field.label}</span>
          <button
            className={`toggle${value ? " on" : ""}`}
            onClick={() => onChange(!value)}
            aria-pressed={Boolean(value)}
          >
            <span className="toggle-knob" />
          </button>
        </label>
      );
    case "json":
      return (
        <label className="wf-field">
          <span>{field.label} (JSON)</span>
          <textarea
            className="wf-json"
            value={jsonText}
            rows={6}
            spellCheck={false}
            onChange={(e) => {
              try {
                onChange(JSON.parse(e.target.value));
              } catch {
                /* keep typing; validate on blur */
              }
            }}
            onBlur={(e) => {
              try {
                onChange(JSON.parse(e.target.value));
              } catch {
                onChange({});
              }
            }}
          />
          {field.help && <small>{field.help}</small>}
        </label>
      );
    default:
      return (
        <label className="wf-field">
          <span>{field.label}</span>
          <input
            value={str}
            placeholder={field.placeholder}
            onChange={(e) => onChange(e.target.value)}
          />
          {field.help && <small>{field.help}</small>}
        </label>
      );
  }
}

/* ── Run history ─────────────────────────────────────────────────────── */

function RunHistory(props: { workflowId: string }) {
  const [runs, setRuns] = useState<WorkflowRun[]>([]);
  const [openRun, setOpenRun] = useState<WorkflowRun | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    setLoading(true);
    api<{ runs: WorkflowRun[] }>(`/api/workflows/${props.workflowId}/runs`)
      .then((d) => setRuns(d.runs))
      .catch(() => setRuns([]))
      .finally(() => setLoading(false));
  }, [props.workflowId]);

  useEffect(() => {
    load();
  }, [load]);

  const openDetail = (id: string) => {
    api<{ run: WorkflowRun }>(`/api/workflows/runs/${id}`)
      .then((d) => setOpenRun(d.run))
      .catch(() => setOpenRun(null));
  };

  return (
    <div className="wf-runs">
      <div className="wf-list-head">
        <h3>Run history & audit</h3>
        <button className="btn-ghost" onClick={load}>
          Refresh
        </button>
      </div>
      {loading && <p className="muted">Loading…</p>}
      {!loading && runs.length === 0 && (
        <p className="muted">No runs yet — publish the workflow and execute it.</p>
      )}
      <ul className="wf-run-list">
        {runs.map((r) => (
          <li key={r.id}>
            <button
              className={`wf-run-row wf-run-${r.status}`}
              onClick={() => openDetail(r.id)}
            >
              <span className="wf-run-status">{r.status}</span>
              <span className="wf-run-time">
                {new Date(r.started_at).toLocaleString()}
              </span>
              {r.error && <span className="wf-run-error">{r.error}</span>}
            </button>
          </li>
        ))}
      </ul>
      {openRun && (
        <div className="wf-run-detail">
          <h4>
            Run {openRun.id.slice(0, 8)} — {openRun.status}
          </h4>
          {openRun.error && <p className="wf-error">{openRun.error}</p>}
          <ol className="wf-steps">
            {(openRun.steps ?? []).map((s) => (
              <li key={s.node_key} className={`wf-step wf-step-${s.status}`}>
                <div className="wf-step-head">
                  <span className="wf-step-icon">
                    {s.status === "success" ? "✅" : s.status === "failed" ? "❌" : s.status === "skipped" ? "⏭️" : "…"}{" "}
                  </span>
                  <strong>{s.node_label}</strong>
                  <span className="muted">{s.node_kind}</span>
                </div>
                {s.error && <p className="wf-error">{s.error}</p>}
                {s.output && (
                  <details>
                    <summary>Output</summary>
                    <pre>{JSON.stringify(s.output, null, 2)}</pre>
                  </details>
                )}
              </li>
            ))}
          </ol>
          <button className="btn-ghost" onClick={() => setOpenRun(null)}>
            Close
          </button>
        </div>
      )}
    </div>
  );
}

/* ── Top-level section ───────────────────────────────────────────────── */

export function WorkflowsSection() {
  const [catalog, setCatalog] = useState<NodeSpec[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [workflow, setWorkflow] = useState<WorkflowDetail | null>(null);
  const [tab, setTab] = useState<"builder" | "runs">("builder");
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [refreshToken, setRefreshToken] = useState(0);

  useEffect(() => {
    api<{ nodes: NodeSpec[] }>("/api/workflows/catalog")
      .then((d) => setCatalog(d.nodes))
      .catch(() => setCatalog([]));
  }, []);

  const open = useCallback((id: string) => {
    api<{ workflow: WorkflowDetail }>(`/api/workflows/${id}`)
      .then((d) => {
        setWorkflow(d.workflow);
        setName(d.workflow.name);
        setOpenId(id);
        setTab("builder");
        setNotice(null);
      })
      .catch((e: unknown) =>
        setNotice(e instanceof Error ? e.message : "Failed to open"),
      );
  }, []);

  const createNew = useCallback(() => {
    api<{ workflow: WorkflowDetail }>("/api/workflows", {
      method: "POST",
      body: JSON.stringify({
        name: "Untitled workflow",
        trigger_type: "manual",
        nodes: [],
        edges: [],
      }),
    })
      .then((d) => {
        setRefreshToken((t) => t + 1);
        open(d.workflow.id);
      })
      .catch((e: unknown) =>
        setNotice(e instanceof Error ? e.message : "Failed to create"),
      );
  }, [open]);

  const save = useCallback(async () => {
    if (!workflow) return;
    setSaving(true);
    setNotice(null);
    try {
      const d = await api<{ workflow: WorkflowDetail }>(
        `/api/workflows/${workflow.id}`,
        {
          method: "PUT",
          body: JSON.stringify({
            name,
            description: workflow.description,
            trigger_type: workflow.trigger_type,
            nodes: workflow.nodes,
            edges: workflow.edges,
          }),
        },
      );
      setWorkflow(d.workflow);
      setNotice("Draft saved.");
    } catch (e: unknown) {
      setNotice(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }, [workflow, name]);

  const publish = useCallback(async () => {
    if (!workflow) return;
    setSaving(true);
    setNotice(null);
    try {
      await save();
      const d = await api<{ workflow: WorkflowDetail }>(
        `/api/workflows/${workflow.id}`,
        { method: "PUT", body: JSON.stringify({ action: "publish" }) },
      );
      setWorkflow(d.workflow);
      setNotice("Published — the workflow can now execute.");
    } catch (e: unknown) {
      setNotice(e instanceof Error ? e.message : "Publish failed");
    } finally {
      setSaving(false);
    }
  }, [workflow, save]);

  const execute = useCallback(async () => {
    if (!workflow) return;
    setSaving(true);
    setNotice(null);
    try {
      const d = await api<{ run: WorkflowRun }>(
        `/api/workflows/${workflow.id}/execute`,
        { method: "POST", body: JSON.stringify({ input: {} }) },
      );
      setNotice(
        `Run ${d.run.status}: ${d.run.id.slice(0, 8)} — see Run history.`,
      );
      setTab("runs");
    } catch (e: unknown) {
      setNotice(e instanceof Error ? e.message : "Execute failed");
    } finally {
      setSaving(false);
    }
  }, [workflow]);

  const back = () => {
    setOpenId(null);
    setWorkflow(null);
    setRefreshToken((t) => t + 1);
  };

  if (!openId || !workflow) {
    return (
      <div className="wf-section">
        {notice && <p className="wf-notice">{notice}</p>}
        <WorkflowList
          onOpen={open}
          onNew={createNew}
          refreshToken={refreshToken}
        />
      </div>
    );
  }

  const isDraft = workflow.status === "draft";

  return (
    <div className="wf-section">
      <div className="wf-topbar">
        <button className="btn-ghost" onClick={back}>
          ← All workflows
        </button>
        <input
          className="wf-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          disabled={!isDraft}
          aria-label="Workflow name"
        />
        <span className={`wf-badge wf-badge-${workflow.status}`}>
          {workflow.status}
        </span>
        <div className="wf-tabs">
          <button
            className={tab === "builder" ? "active" : ""}
            onClick={() => setTab("builder")}
          >
            Builder
          </button>
          <button
            className={tab === "runs" ? "active" : ""}
            onClick={() => setTab("runs")}
          >
            Run history
          </button>
        </div>
        <div className="wf-actions">
          <button
            className="btn-ghost"
            onClick={save}
            disabled={saving || !isDraft}
          >
            {saving ? "Saving…" : "Save draft"}
          </button>
          {isDraft && (
            <button
              className="btn-primary"
              onClick={publish}
              disabled={saving}
            >
              Publish
            </button>
          )}
          {!isDraft && (
            <button
              className="btn-primary"
              onClick={execute}
              disabled={saving}
            >
              ▶ Execute
            </button>
          )}
        </div>
      </div>
      {notice && <p className="wf-notice">{notice}</p>}
      {!isDraft && tab === "builder" && (
        <p className="wf-hint" style={{ padding: "8px 16px" }}>
          Published workflows are immutable — duplicate via API to iterate, or
          archive and create a new version.
        </p>
      )}
      {tab === "builder" ? (
        <BuilderCanvas
          workflow={workflow}
          catalog={catalog}
          onChange={isDraft ? setWorkflow : () => {}}
        />
      ) : (
        <RunHistory workflowId={workflow.id} />
      )}
    </div>
  );
}
