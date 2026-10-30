// AKS 보안 점검 — "where to fix it" (보안 고도화 P4): the GitOps source of each workload. Argo CD lists, in each
// Application's status.resources, exactly the objects it manages — so a workload maps to its Application (and its
// repository · path or chart · Helm value files · synced commit) without guessing from names or labels.
// Pure: the collector lists applications.argoproj.io (list only, CRD optional) and hands the items here.

import type { WorkloadSource } from "@aud/types";

/** One Argo CD Application, reduced to what tells where a workload's manifests live */
export type InvGitopsApp = {
  namespace: string;
  name: string;
  source: Omit<WorkloadSource, "tool" | "app" | "appNamespace">;
  /** Workloads it manages: "Kind/namespace/name" (apps group only) */
  manages: string[];
};

/**
 * A repository URL without secrets: user-info (https://user:token@host), query and fragment removed. SSH and OCI
 * forms are kept (no password in them). Long values are cut.
 */
export function sanitizeRepoUrl(url: string): string {
  const u = url.trim();
  const m = /^(https?:\/\/)([^/@]*@)?([^?#]*)/i.exec(u);
  const out = m ? `${m[1]}${m[3]}` : u.replace(/[?#].*$/, "");
  return out.slice(0, 300);
}

/** "https://github.com/org/repo.git" → "github.com/org/repo"; "git@host:org/repo.git" → "host/org/repo" */
export function repoShort(url: string): string {
  return url.replace(/^[a-z]+:\/\//i, "").replace(/^git@([^:]+):/i, "$1/").replace(/\.git$/i, "");
}

type ArgoSource = { repoURL?: string; path?: string; chart?: string; targetRevision?: string; ref?: string; helm?: { valueFiles?: string[] } };
type ArgoApp = {
  metadata?: { name?: string; namespace?: string };
  spec?: { source?: ArgoSource; sources?: ArgoSource[] };
  status?: { sync?: { status?: string; revision?: string; revisions?: string[] }; resources?: Array<{ group?: string; kind?: string; namespace?: string; name?: string }> };
};

const WORKLOAD_KINDS = new Set(["Deployment", "StatefulSet", "DaemonSet"]);

/**
 * Applications → sources. Multi-source apps: the primary is the first source with a path or a chart; "$ref/x" value
 * files are resolved to the ref source's repository. The synced revision is the primary's.
 */
export function parseArgoApplications(items: unknown[]): InvGitopsApp[] {
  const out: InvGitopsApp[] = [];
  for (const raw of items) {
    const a = (raw ?? {}) as ArgoApp;
    const name = a.metadata?.name;
    if (!name) continue;
    const sources = a.spec?.sources?.length ? a.spec.sources : a.spec?.source ? [a.spec.source] : [];
    const idx = Math.max(0, sources.findIndex((s) => s.path || s.chart));
    const p = sources[idx];
    if (!p?.repoURL) continue;
    const refs = new Map(sources.filter((s) => s.ref && s.repoURL).map((s) => [s.ref!, repoShort(sanitizeRepoUrl(s.repoURL!))]));
    const valueFiles = (p.helm?.valueFiles ?? []).slice(0, 10).map((f) => {
      const m = /^\$([\w-]+)\/(.+)$/.exec(f);
      return m && refs.has(m[1]!) ? `${refs.get(m[1]!)}: ${m[2]}` : f;
    });
    const sync = a.status?.sync;
    const synced = sync?.revisions?.[idx] ?? sync?.revision;
    out.push({
      namespace: a.metadata?.namespace ?? "",
      name,
      source: {
        repo: sanitizeRepoUrl(p.repoURL),
        ...(p.path ? { path: p.path } : {}),
        ...(p.chart ? { chart: p.chart } : {}),
        ...(p.targetRevision ? { targetRevision: p.targetRevision } : {}),
        ...(synced ? { syncedRevision: synced } : {}),
        valueFiles,
        ...(sync?.status ? { sync: sync.status } : {}),
      },
      manages: (a.status?.resources ?? [])
        .filter((r) => (r.group ?? "") === "apps" && WORKLOAD_KINDS.has(r.kind ?? "") && r.name)
        .map((r) => `${r.kind}/${r.namespace ?? ""}/${r.name}`),
    });
  }
  return out.sort((x, y) => (x.name < y.name ? -1 : x.name > y.name ? 1 : 0));
}

/** The Application that manages this workload (first by name when two claim it — Argo CD reports that as a conflict) */
export function sourceOf(apps: InvGitopsApp[], w: { kind: string; namespace: string; name: string }): WorkloadSource | undefined {
  const key = `${w.kind}/${w.namespace}/${w.name}`;
  const a = apps.find((x) => x.manages.includes(key));
  return a ? { tool: "argocd", app: a.name, appNamespace: a.namespace, ...a.source } : undefined;
}

/** "Argo CD app-x → github.com/org/repo/deploy/app · values: …" — the line under a remediation */
export function fixAtText(s: WorkloadSource): string {
  const where = `${repoShort(s.repo)}${s.path ? `/${s.path.replace(/^\/+/, "")}` : s.chart ? ` (chart ${s.chart}${s.targetRevision ? ` ${s.targetRevision}` : ""})` : ""}`;
  const values = s.valueFiles.length ? ` · values: ${s.valueFiles.slice(0, 3).join(", ")}${s.valueFiles.length > 3 ? ` +${s.valueFiles.length - 3}` : ""}` : "";
  const rev = s.targetRevision && s.path ? ` @${s.targetRevision}` : "";
  return `Argo CD ${s.app} → ${where}${rev}${values}`;
}
