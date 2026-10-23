import { test } from "node:test";
import assert from "node:assert/strict";
import type { PolicyInsightsResponse, PostureAlert, WorkloadRiskRow } from "@aud/types";
import * as ag from "../../web/src/lib/alertGroups.ts";
import * as hv from "../../web/src/app/policies/insights/heatView.ts";
import { alertExtras } from "../src/services/securityPosture.js";

const { groupAlerts, matchesAlert } = ((ag as { default?: typeof ag }).default ?? ag) as typeof ag;
const { visibleFactors, rowRisk, sortRows, cellText, splitFactors, textColumns, showsCellText } = ((hv as { default?: typeof hv }).default ?? hv) as typeof hv;

const alert = (id: string, title: string, severity: PostureAlert["severity"], t: string, ns?: string, pod?: string): PostureAlert => ({
  id, title, severity, status: "Active", detectedAt: t, description: "desc", resources: [{ id: "x", name: "aks-a", type: "managedclusters", resourceGroup: "rg" }],
  ...(ns ? { k8s: { namespace: ns, pod } } : {}), intent: "PrivilegeEscalation",
});

test("alerts: the same detection is one row (×n), instances newest first, severity order", () => {
  const g = groupAlerts([
    alert("1", "Container with a sensitive volume mount detected", "Informational", "2026-10-23T01:00:00Z", "monitor", "alloy-0"),
    alert("2", "Container with a sensitive volume mount detected", "Informational", "2026-10-23T03:00:00Z", "monitor", "tempo-0"),
    alert("3", "Container with a sensitive volume mount detected", "Informational", "2026-10-23T02:00:00Z", "monitor", "alloy-0"),
    alert("4", "Access to kubelet kubeconfig file detected", "Medium", "2026-10-22T09:00:00Z"),
  ]);
  assert.deepEqual(g.map((x) => [x.title.slice(0, 6), x.items.length]), [["Access", 1], ["Contai", 3]], "Medium before Informational");
  assert.deepEqual(g[1]!.items.map((a) => a.id), ["2", "3", "1"]);
  assert.deepEqual(g[1]!.resources, ["monitor/tempo-0", "monitor/alloy-0"]);
  assert.equal(g[1]!.lastAt, "2026-10-23T03:00:00Z");
  assert.ok(matchesAlert(g[1]!, "TEMPO"));
  assert.ok(!matchesAlert(g[1]!, "kubeconfig"));
});

test("alert extras: remediation, Kubernetes entities, portal link only on portal.azure.com, GUIDs masked", () => {
  const x = alertExtras({ id: "a", rem: ["<b>Review</b> the pod", "Remove the mount"], ce: "pod 12345678-1234-1234-1234-123456789abc",
    ent: [{ Type: "K8s-namespace", Name: "monitor" }, { Type: "K8s-pod", Name: "alloy-0" }, { Type: "container", Name: "alloy" }],
    t0: "2026-10-23T00:00:00Z", uri: "https://portal.azure.com/#blade/x" });
  assert.deepEqual(x.k8s, { namespace: "monitor", pod: "alloy-0", container: "alloy" });
  assert.equal(x.remediation?.length, 2);
  assert.ok(!x.entity!.includes("12345678-"));
  assert.equal(x.portalUrl, "https://portal.azure.com/#blade/x");
  assert.equal(alertExtras({ id: "a", uri: "https://evil.example.com/x" }).portalUrl, undefined);
});

type Factor = PolicyInsightsResponse["factors"][number];
const F = [
  { key: "secretUse", label: "Secret", group: "ID", ev: "cfg", weight: "warn", desc: "" },
  { key: "highRbac", label: "RBAC", group: "ID", ev: "perm", weight: "crit", desc: "" },
  { key: "extExposure", label: "Exposure", group: "Exposure", ev: "cfg", weight: "crit", desc: "" },
] as unknown as Factor[];
const row = (name: string, cells: Record<string, string>, combos = 0): WorkloadRiskRow => ({
  id: name, name, namespace: "ns", kind: "StatefulSet", pods: 1, owner: "Helm", serviceAccount: "sa", managed: false,
  cells, weights: { secretUse: "warn", highRbac: "crit", extExposure: "crit" }, combos: Array.from({ length: combos }, () => ({ type: "standing", keys: ["highRbac"], issueId: "i1" })),
} as unknown as WorkloadRiskRow);

test("heatmap view: empty columns folded, rows by risk (combos first), short cell text, drawer split", () => {
  const rows = [row("fluentd", { secretUse: "envFrom secretKeyRef" }), row("argocd-controller", { secretUse: "volume", highRbac: "cluster-admin" }, 1)];
  assert.deepEqual(visibleFactors(rows, F, false).map((f) => f.key), ["secretUse", "highRbac"]);
  assert.equal(visibleFactors(rows, F, true).length, 3);
  assert.equal(rowRisk(rows[1]!, F), 2 + 3 + 2);
  assert.deepEqual(sortRows(rows, F, "risk").map((r) => r.name), ["argocd-controller", "fluentd"]);
  assert.deepEqual(sortRows(rows, F, "name").map((r) => r.name), ["argocd-controller", "fluentd"]);
  assert.equal(cellText("cluster-admin (ClusterRoleBinding)"), "cluster…");
  assert.equal(cellText("envFrom secretKeyRef"), "envFrom");
  const split = splitFactors(rows[0]!, F);
  assert.deepEqual([split.hits.length, split.nonHits.length], [1, 2]);
});

test("heatmap cell text: only where it tells rows apart or the hit is critical", () => {
  const rows = [
    row("a", { secretUse: "envFrom secretKeyRef", highRbac: "cluster-admin" }),
    row("b", { secretUse: "envFrom secretKeyRef", highRbac: "nodes/proxy", extExposure: "공인 LoadBalancer" }),
    row("c", { secretUse: "envFrom secretKeyRef", extExposure: "내부 LoadBalancer" }),
  ];
  const cols = textColumns(rows, F);
  assert.deepEqual([...cols].sort(), ["extExposure", "highRbac"], "the same 'envFrom' everywhere → glyph only");
  assert.equal(showsCellText(rows[0]!, F[0]!, cols), false);
  // a single critical hit keeps its text even though the column has one value
  assert.equal(showsCellText(row("d", { highRbac: "cluster-admin" }), F[1]!, new Set()), true);
});
