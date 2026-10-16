/* ── Workflow families ──────────────────────────────────────────────────
 * Use-case skeleton workflows carry their lineage in trigger_config
 * ({ projectId, packageId, requirementId, requirementCode } — written
 * by the skeleton generator in api/_lib/use-case-workflows.ts) and are
 * named "<Organization> — <title>". The Automations list groups them
 * under their project family, and each family (and a skeleton open in
 * the editor) offers the project's charter — fetched lazily from the
 * existing GET /api/projects/:id/charter endpoint — as a collapsible,
 * read-only summary. This module is the pure data shaping + fetch
 * cache behind that UI; the components live in workflows.tsx.
 */

export interface FamilyMemberLike {
  name: string;
  trigger_config?: Record<string, unknown> | null;
}

export interface SkeletonRef {
  projectId: string;
  requirementId: string | null;
  requirementCode: string | null;
}

/** The skeleton lineage of a workflow, or null when it is not a
 * use-case skeleton (no projectId in trigger_config). */
export function skeletonRef(member: FamilyMemberLike): SkeletonRef | null {
  const cfg = member.trigger_config;
  if (!cfg || typeof cfg !== "object") return null;
  const projectId = cfg.projectId;
  if (typeof projectId !== "string" || !projectId.trim()) return null;
  return {
    projectId,
    requirementId:
      typeof cfg.requirementId === "string" ? cfg.requirementId : null,
    requirementCode:
      typeof cfg.requirementCode === "string" ? cfg.requirementCode : null,
  };
}

export interface WorkflowFamily<T extends FamilyMemberLike> {
  projectId: string;
  /** Organization name, from the "<Organization> — <title>" prefix the
   * generator stamps on skeleton names. The charter summary shows the
   * authoritative organizationName once it is loaded. */
  title: string;
  workflows: T[];
  /** The family's skeleton lineage refs, in list order — the input
   * the charter summary matches requirements against. */
  skeletons: SkeletonRef[];
  /** Requirements this family's skeletons implement (ordered, deduped). */
  requirementIds: string[];
}

const NAME_SEPARATOR = " — ";

export function familyTitle(names: string[]): string {
  for (const name of names) {
    const idx = name.indexOf(NAME_SEPARATOR);
    if (idx > 0) return name.slice(0, idx).trim();
  }
  return "Project family";
}

/**
 * Split a workflow list into skeleton families (grouped by project,
 * in first-appearance order, list order preserved inside each family)
 * and the standalone workflows that belong to no family.
 */
export function groupWorkflowsByFamily<T extends FamilyMemberLike>(
  workflows: T[],
): { families: Array<WorkflowFamily<T>>; standalone: T[] } {
  const byProject = new Map<string, WorkflowFamily<T>>();
  const standalone: T[] = [];
  for (const w of workflows) {
    const ref = skeletonRef(w);
    if (!ref) {
      standalone.push(w);
      continue;
    }
    let family = byProject.get(ref.projectId);
    if (!family) {
      family = {
        projectId: ref.projectId,
        title: "Project family",
        workflows: [],
        skeletons: [],
        requirementIds: [],
      };
      byProject.set(ref.projectId, family);
    }
    family.workflows.push(w);
    family.skeletons.push(ref);
    if (ref.requirementId && !family.requirementIds.includes(ref.requirementId)) {
      family.requirementIds.push(ref.requirementId);
    }
  }
  const families = [...byProject.values()];
  for (const family of families) {
    family.title = familyTitle(family.workflows.map((w) => w.name));
  }
  return { families, standalone };
}

/* ── Charter summary ─────────────────────────────────────────────────── */

/** The subset of the charter endpoint payload the summary renders.
 * Structurally compatible with the full charter (api/_lib/projects.ts
 * ProjectCharter); the endpoint returns more than the summary needs. */
export interface CharterLike {
  project: { organizationName: string };
  problemStatement: string | null;
  requirements: Array<{
    id: string;
    code: string;
    statement: string;
    priority: string;
  }>;
  kpis: Array<{ id: string; metric: string; target: string }>;
}

export interface CharterSummary {
  organizationName: string;
  problemStatement: string | null;
  requirements: Array<{
    id: string;
    code: string;
    statement: string;
    priority: string;
    /** True when one of the family's skeletons implements it. */
    implemented: boolean;
  }>;
  kpis: Array<{ id: string; metric: string; target: string }>;
}

export const PROBLEM_STATEMENT_MAX = 240;

export function shortenText(text: string, max = PROBLEM_STATEMENT_MAX): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trimEnd()}…`;
}

/** Shape a charter payload into the compact read-only summary, marking
 * the requirements the given skeletons implement. Matching is by
 * requirement ID: a skeleton that carries an ID matches ONLY that
 * requirement, never by code — duplicate (truncated) display codes
 * are possible, and code-matching an id-carrying skeleton would
 * falsely mark a sibling requirement that shares its code. The code
 * is a fallback key ONLY for legacy skeletons that carry no ID
 * (Codex P2 on PR #63). */
export function summarizeCharter(
  charter: CharterLike,
  skeletons: Array<{
    requirementId: string | null;
    requirementCode: string | null;
  }>,
): CharterSummary {
  const ids = new Set<string>();
  const legacyCodes = new Set<string>();
  for (const s of skeletons) {
    if (s.requirementId) ids.add(s.requirementId);
    else if (s.requirementCode) legacyCodes.add(s.requirementCode);
  }
  return {
    organizationName: charter.project.organizationName,
    problemStatement: charter.problemStatement
      ? shortenText(charter.problemStatement)
      : null,
    requirements: charter.requirements.map((r) => ({
      id: r.id,
      code: r.code,
      statement: r.statement,
      priority: r.priority,
      implemented: ids.has(r.id) || legacyCodes.has(r.code),
    })),
    kpis: charter.kpis.map((k) => ({
      id: k.id,
      metric: k.metric,
      target: k.target,
    })),
  };
}

/* ── Charter fetch cache ───────────────────────────────────────────────
 * Lazy per-project cache over the charter endpoint: nothing is fetched
 * until load() is called (the first expand), repeat loads resolve from
 * the cache, concurrent loads share one request, and failures are not
 * cached so a later expand can retry. */

export interface CharterCache {
  load: (projectId: string) => Promise<CharterLike>;
  peek: (projectId: string) => CharterLike | undefined;
}

export function createCharterCache(
  fetchCharter: (projectId: string) => Promise<CharterLike>,
): CharterCache {
  const done = new Map<string, CharterLike>();
  const inflight = new Map<string, Promise<CharterLike>>();
  return {
    peek: (projectId) => done.get(projectId),
    load: (projectId) => {
      const hit = done.get(projectId);
      if (hit) return Promise.resolve(hit);
      const pending = inflight.get(projectId);
      if (pending) return pending;
      const request = fetchCharter(projectId).then(
        (charter) => {
          done.set(projectId, charter);
          inflight.delete(projectId);
          return charter;
        },
        (error: unknown) => {
          inflight.delete(projectId);
          throw error;
        },
      );
      inflight.set(projectId, request);
      return request;
    },
  };
}
