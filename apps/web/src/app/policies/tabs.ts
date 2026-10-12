// Cluster security (/policies) tab structure — pure data, tested in apps/api/test/policyTabs.test.ts.
// Ten existing panels are grouped on the Wiz/KSPM axes; the URL keeps the panel id (?tab=rbac),
// so deep links name an exact panel and the group follows from it.

export const PANELS = ["overview", "network", "networkPolicy", "permissions", "rbac", "findings", "psa", "namespaces", "autoscaling", "kbom"] as const;
export type Panel = (typeof PANELS)[number];

export type PolicyGroup = { id: "overview" | "exposure" | "identity" | "config" | "inventory"; panels: Panel[] };

export const POLICY_GROUPS: PolicyGroup[] = [
  { id: "overview", panels: ["overview"] },
  { id: "exposure", panels: ["network", "networkPolicy"] },
  { id: "identity", panels: ["permissions", "rbac"] },
  { id: "config", panels: ["findings", "psa", "namespaces", "autoscaling"] },
  { id: "inventory", panels: ["kbom"] },
];

/** Group that shows `panel`; unknown values fall back to the overview. */
export function groupOfPanel(panel: string | null | undefined): PolicyGroup {
  return POLICY_GROUPS.find((g) => (g.panels as string[]).includes(panel ?? "")) ?? POLICY_GROUPS[0]!;
}
