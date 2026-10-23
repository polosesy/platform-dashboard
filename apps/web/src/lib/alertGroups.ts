// Defender alerts grouped for triage (pure): the same detection (title + severity) on several containers is one row
// with ×n, its instances listed inside — a SOC reader sees what / where / when first, details on demand.

import type { PostureAlert } from "@aud/types";

export type AlertGroup = {
  key: string;
  title: string;
  severity: PostureAlert["severity"];
  items: PostureAlert[];
  /** Unique affected resource names / Kubernetes workloads and intents across the instances */
  resources: string[];
  intents: string[];
  firstAt: string;
  lastAt: string;
};

const SEV: Record<PostureAlert["severity"], number> = { High: 0, Medium: 1, Low: 2, Informational: 3 };

const whereOf = (a: PostureAlert): string[] =>
  a.k8s?.namespace || a.k8s?.pod ? [`${a.k8s?.namespace ?? "?"}/${a.k8s?.pod ?? a.k8s?.container ?? ""}`.replace(/\/$/, "")] : a.resources.map((r) => r.name);

export function groupAlerts(alerts: PostureAlert[]): AlertGroup[] {
  const map = new Map<string, AlertGroup>();
  for (const a of alerts) {
    const key = `${a.severity}|${a.title}`;
    const g = map.get(key) ?? { key, title: a.title, severity: a.severity, items: [], resources: [], intents: [], firstAt: a.firstAt ?? a.detectedAt, lastAt: a.detectedAt };
    g.items.push(a);
    for (const i of (a.intent ?? "").split(",").map((x) => x.trim()).filter(Boolean)) if (!g.intents.includes(i)) g.intents.push(i);
    const first = a.firstAt ?? a.detectedAt;
    if (first && (!g.firstAt || first < g.firstAt)) g.firstAt = first;
    if (a.detectedAt > g.lastAt) g.lastAt = a.detectedAt;
    map.set(key, g);
  }
  return [...map.values()]
    .map((g) => {
      // Instances newest first; resource chips follow the same order (the latest affected workload leads)
      const items = [...g.items].sort((a, b) => b.detectedAt.localeCompare(a.detectedAt));
      const resources: string[] = [];
      for (const a of items) for (const r of whereOf(a)) if (r && !resources.includes(r)) resources.push(r);
      return { ...g, items, resources };
    })
    .sort((a, b) => SEV[a.severity] - SEV[b.severity] || b.lastAt.localeCompare(a.lastAt));
}

/** Search over title, description, resources and Kubernetes entities (case-insensitive) */
export function matchesAlert(g: AlertGroup, q: string): boolean {
  const s = q.trim().toLowerCase();
  if (!s) return true;
  return [g.title, ...g.resources, ...g.items.map((a) => a.description), ...g.items.map((a) => a.entity ?? "")]
    .some((x) => x.toLowerCase().includes(s));
}
