import { test } from "node:test";
import assert from "node:assert/strict";
import {
  analyzePolicies,
  analyzeRbacRules,
  selectorMatches,
  type PolicyInventory,
} from "../src/services/policyAnalyzer.js";

const emptyInventory = (): PolicyInventory => ({
  namespaces: [],
  pods: [],
  workloads: [],
  networkPolicies: [],
  ciliumPolicies: [],
  roles: [],
  bindings: [],
  hpas: [],
  vpas: [],
  pdbs: [],
  resourceQuotas: [],
  limitRanges: [],
  capabilities: { vpaInstalled: true, ciliumInstalled: true, unavailable: [] },
});

const ids = (r: ReturnType<typeof analyzePolicies>, ruleId: string) => r.findings.filter((f) => f.ruleId === ruleId);

// ── Label selectors ──

test("selectorMatches: matchLabels and all matchExpressions operators", () => {
  const labels = { app: "web", tier: "front" };
  assert.equal(selectorMatches({ matchLabels: { app: "web" } }, labels), true);
  assert.equal(selectorMatches({ matchLabels: { app: "api" } }, labels), false);
  assert.equal(selectorMatches({ matchExpressions: [{ key: "tier", operator: "In", values: ["front", "x"] }] }, labels), true);
  assert.equal(selectorMatches({ matchExpressions: [{ key: "tier", operator: "NotIn", values: ["front"] }] }, labels), false);
  assert.equal(selectorMatches({ matchExpressions: [{ key: "missing", operator: "NotIn", values: ["a"] }] }, labels), true);
  assert.equal(selectorMatches({ matchExpressions: [{ key: "app", operator: "Exists" }] }, labels), true);
  assert.equal(selectorMatches({ matchExpressions: [{ key: "app", operator: "DoesNotExist" }] }, labels), false);
  assert.equal(selectorMatches({ matchExpressions: [{ key: "app", operator: "Bogus" }] }, labels), false);
  assert.equal(selectorMatches({}, labels), true, "empty selector selects everything");
});

test("selectorMatches: Cilium k8s: prefix and namespace pseudo-label", () => {
  assert.equal(selectorMatches({ matchLabels: { "k8s:app": "web" } }, { app: "web" }, "ns1"), true);
  assert.equal(selectorMatches({ matchLabels: { "k8s:io.kubernetes.pod.namespace": "ns1" } }, {}, "ns1"), true);
  assert.equal(selectorMatches({ matchLabels: { "k8s:io.kubernetes.pod.namespace": "ns1" } }, {}, "ns2"), false);
});

// ── RBAC rule analysis ──

test("analyzeRbacRules: escalation paths per RBAC good practices", () => {
  const codes = (rules: Parameters<typeof analyzeRbacRules>[0]) => analyzeRbacRules(rules).map((r) => r.label);
  assert.match(codes([{ apiGroups: ["*"], resources: ["*"], verbs: ["*"] }]).join(), /모든 API 그룹/);
  assert.match(codes([{ apiGroups: ["rbac.authorization.k8s.io"], resources: ["clusterroles"], verbs: ["escalate"] }]).join(), /escalate/);
  assert.match(codes([{ apiGroups: ["rbac.authorization.k8s.io"], resources: ["roles"], verbs: ["bind"] }]).join(), /bind/);
  assert.match(codes([{ apiGroups: [""], resources: ["users"], verbs: ["impersonate"] }]).join(), /impersonate/);
  assert.match(codes([{ apiGroups: [""], resources: ["secrets"], verbs: ["list"] }]).join(), /Secret/);
  assert.match(codes([{ apiGroups: [""], resources: ["nodes/proxy"], verbs: ["get"] }]).join(), /nodes\/proxy/);
  assert.match(codes([{ apiGroups: [""], resources: ["pods/exec"], verbs: ["create"] }]).join(), /exec/);
  assert.match(codes([{ apiGroups: ["admissionregistration.k8s.io"], resources: ["mutatingwebhookconfigurations"], verbs: ["patch"] }]).join(), /webhook/);
  assert.deepEqual(codes([{ apiGroups: [""], resources: ["secrets"], verbs: ["get"], resourceNames: ["one-secret"] }]), [], "resourceNames-scoped access is not flagged");
  assert.deepEqual(codes([{ apiGroups: [""], resources: ["configmaps", "pods"], verbs: ["get", "list", "watch"] }]), [], "read-only on ordinary resources is fine");
  assert.deepEqual(codes([{ nonResourceURLs: ["/healthz"], verbs: ["get"] }]), []);
});

// ── Full scenario ──

function scenario(): PolicyInventory {
  const inv = emptyInventory();
  inv.namespaces = [
    { name: "app", labels: {} },
    {
      name: "secure",
      labels: {
        "pod-security.kubernetes.io/enforce": "restricted",
        "pod-security.kubernetes.io/enforce-version": "v1.33",
      },
    },
    { name: "legacy", labels: { "pod-security.kubernetes.io/enforce": "privileged" } },
    { name: "kube-system", labels: {} },
  ];
  inv.pods = [
    { namespace: "app", name: "web-1", labels: { app: "web" }, phase: "Running" },
    { namespace: "app", name: "api-1", labels: { app: "api" }, phase: "Running" },
    { namespace: "app", name: "node-agent", labels: { app: "agent" }, phase: "Running", hostNetwork: true },
    { namespace: "app", name: "job-done", labels: { app: "job" }, phase: "Succeeded" },
    { namespace: "secure", name: "svc-1", labels: { app: "svc" }, phase: "Running" },
    { namespace: "legacy", name: "old-1", labels: { app: "old" }, phase: "Running" },
    { namespace: "kube-system", name: "coredns-1", labels: { "k8s-app": "kube-dns" }, phase: "Running" },
  ];
  inv.workloads = [
    {
      kind: "Deployment", namespace: "app", name: "web", replicas: 3, podLabels: { app: "web" },
      containers: [{ name: "web", limits: { memory: "256Mi" } }],
    },
    {
      kind: "Deployment", namespace: "app", name: "api", replicas: 2, podLabels: { app: "api" },
      serviceAccountName: "api-sa",
      containers: [{ name: "api", requests: { cpu: "100m", memory: "128Mi" }, limits: { memory: "256Mi" } }],
    },
    {
      kind: "StatefulSet", namespace: "secure", name: "svc", replicas: 2, podLabels: { app: "svc" },
      serviceAccountName: "svc", automountServiceAccountToken: false,
      containers: [{ name: "svc", requests: { cpu: "50m", memory: "64Mi" }, limits: { memory: "64Mi" } }],
    },
  ];
  inv.networkPolicies = [
    { namespace: "app", name: "web-ingress", podSelector: { matchLabels: { app: "web" } }, policyTypes: ["Ingress"], ingress: [{ from: [] }] },
    { namespace: "app", name: "allow-all", podSelector: { matchLabels: { app: "web" } }, ingress: [{}] },
    { namespace: "app", name: "stale", podSelector: { matchLabels: { app: "gone" } }, policyTypes: ["Ingress"] },
    { namespace: "secure", name: "default-deny", podSelector: {}, policyTypes: ["Ingress", "Egress"] },
  ];
  // Cluster-wide Cilium egress policy for namespace "legacy"
  inv.ciliumPolicies = [
    { name: "legacy-egress", specs: [{ endpointSelector: { matchLabels: { "k8s:io.kubernetes.pod.namespace": "legacy" } }, egress: [{ toEntities: ["cluster"] }] }] },
  ];
  inv.hpas = [
    { namespace: "app", name: "api-hpa", target: { kind: "Deployment", name: "api" }, minReplicas: 2, maxReplicas: 5, metrics: [{ type: "Resource", name: "cpu", target: "70%" }] },
    { namespace: "app", name: "web-hpa", target: { kind: "Deployment", name: "web" }, minReplicas: 3, maxReplicas: 6, metrics: [{ type: "Resource", name: "cpu", target: "60%" }] },
    { namespace: "app", name: "ghost-hpa", target: { kind: "Deployment", name: "ghost" }, minReplicas: 1, maxReplicas: 2, metrics: [] },
  ];
  inv.vpas = [
    { namespace: "app", name: "api-vpa", target: { kind: "Deployment", name: "api" }, updateMode: "Recreate", recommendations: { api: { cpu: "120m" } } },
    { namespace: "secure", name: "svc-vpa", target: { kind: "StatefulSet", name: "svc" }, recommendations: {} },
    { namespace: "secure", name: "ghost-vpa", target: { kind: "Deployment", name: "ghost" }, updateMode: "Off", recommendations: {} },
  ];
  inv.pdbs = [
    { namespace: "secure", name: "svc-pdb", selector: { matchLabels: { app: "svc" } }, minAvailable: "2" },
    { namespace: "app", name: "orphan-pdb", selector: { matchLabels: { app: "nothing" } }, maxUnavailable: "1" },
  ];
  inv.resourceQuotas = [{ namespace: "secure", name: "q" }];
  inv.limitRanges = [{ namespace: "secure", name: "lr" }];
  inv.roles = [
    { kind: "ClusterRole", name: "cluster-admin", labels: { "kubernetes.io/bootstrapping": "rbac-defaults" }, rules: [{ apiGroups: ["*"], resources: ["*"], verbs: ["*"] }], aggregated: false },
    { kind: "ClusterRole", name: "secret-reader", labels: {}, rules: [{ apiGroups: [""], resources: ["secrets"], verbs: ["get", "list"] }], aggregated: false },
    { kind: "ClusterRole", name: "role-escalator", labels: {}, rules: [{ apiGroups: ["rbac.authorization.k8s.io"], resources: ["clusterroles"], verbs: ["escalate", "bind"] }], aggregated: false },
    { kind: "Role", namespace: "app", name: "viewer", labels: {}, rules: [{ apiGroups: [""], resources: ["pods"], verbs: ["get"] }], aggregated: false },
    { kind: "ClusterRole", name: "pod-viewer", labels: {}, rules: [{ apiGroups: [""], resources: ["pods"], verbs: ["get", "list"] }], aggregated: false },
  ];
  inv.bindings = [
    { kind: "ClusterRoleBinding", name: "cluster-admin", labels: { "kubernetes.io/bootstrapping": "rbac-defaults" }, roleRef: { kind: "ClusterRole", name: "cluster-admin" }, subjects: [{ kind: "Group", name: "system:masters" }] },
    { kind: "ClusterRoleBinding", name: "alice-admin", labels: {}, roleRef: { kind: "ClusterRole", name: "cluster-admin" }, subjects: [{ kind: "User", name: "alice" }] },
    { kind: "RoleBinding", namespace: "app", name: "read-secrets", labels: {}, roleRef: { kind: "ClusterRole", name: "secret-reader" }, subjects: [{ kind: "ServiceAccount", name: "default", namespace: "app" }] },
    { kind: "ClusterRoleBinding", name: "escalators", labels: {}, roleRef: { kind: "ClusterRole", name: "role-escalator" }, subjects: [{ kind: "Group", name: "devs" }] },
    { kind: "ClusterRoleBinding", name: "anon-view", labels: {}, roleRef: { kind: "ClusterRole", name: "pod-viewer" }, subjects: [{ kind: "Group", name: "system:unauthenticated" }] },
    { kind: "RoleBinding", namespace: "app", name: "dangling", labels: {}, roleRef: { kind: "Role", name: "does-not-exist" }, subjects: [{ kind: "User", name: "bob" }] },
    { kind: "RoleBinding", namespace: "app", name: "viewer-binding", labels: {}, roleRef: { kind: "Role", name: "viewer" }, subjects: [{ kind: "Group", name: "system:authenticated" }] },
  ];
  return inv;
}

test("PSA: missing / privileged / visibility / version rules", () => {
  const r = analyzePolicies(scenario(), "c1");
  assert.deepEqual(ids(r, "PSA-001").filter((f) => !f.system).map((f) => f.namespace), ["app"]);
  assert.equal(ids(r, "PSA-001").find((f) => f.namespace === "kube-system")?.system, true, "system namespace flagged as system");
  assert.deepEqual(ids(r, "PSA-002").map((f) => f.namespace), ["legacy"]);
  assert.deepEqual(ids(r, "PSA-003").map((f) => f.namespace), ["legacy"], "restricted enforce needs no warn/audit");
  assert.deepEqual(ids(r, "PSA-004").map((f) => f.namespace), ["legacy"], "secure pins enforce-version");
  const app = r.namespaces.find((n) => n.name === "app")!;
  assert.equal(app.psaEffectiveEnforce, "privileged");
});

test("NetworkPolicy: coverage counts pods, ignores hostNetwork/completed, honours Cilium cluster-wide", () => {
  const r = analyzePolicies(scenario(), "c1");
  const app = r.namespaces.find((n) => n.name === "app")!;
  assert.equal(app.networkPolicy.eligiblePods, 2, "hostNetwork + Succeeded pods excluded");
  assert.equal(app.networkPolicy.ingressIsolatedPods, 1);
  assert.equal(app.networkPolicy.egressIsolatedPods, 0);
  assert.equal(ids(r, "NET-002").map((f) => f.namespace).join(), "app");
  assert.ok(ids(r, "NET-003").some((f) => f.namespace === "app"));

  const secure = r.namespaces.find((n) => n.name === "secure")!;
  assert.equal(secure.networkPolicy.defaultDenyIngress, true);
  assert.equal(secure.networkPolicy.defaultDenyEgress, true);
  assert.equal(r.findings.some((f) => f.namespace === "secure" && f.category === "networkPolicy"), false);

  const legacy = r.namespaces.find((n) => n.name === "legacy")!;
  assert.equal(legacy.networkPolicy.egressIsolatedPods, 1, "CCNP selected by namespace pseudo-label");
  assert.equal(legacy.networkPolicy.ingressIsolatedPods, 0);
  assert.ok(ids(r, "NET-001").some((f) => f.namespace === "legacy"));

  const allowAll = r.networkPolicies.find((p) => p.name === "allow-all")!;
  assert.deepEqual(allowAll.policyTypes, ["Ingress"], "policyTypes defaults to Ingress");
  assert.equal(allowAll.allowsAllIngress, true);
  assert.equal(ids(r, "NET-004").length, 1);
  assert.equal(ids(r, "NET-005").map((f) => f.resource?.name).join(), "stale");
});

test("Autoscaling: VPA/HPA conflict, deprecated Auto, dangling targets, HPA without requests, PDB rules", () => {
  const r = analyzePolicies(scenario(), "c1");
  const conflict = ids(r, "VPA-002");
  assert.equal(conflict.length, 1);
  assert.equal(conflict[0]!.severity, "high");
  assert.equal(conflict[0]!.resource?.name, "api-vpa");
  assert.deepEqual(ids(r, "VPA-003").map((f) => f.resource?.name), ["svc-vpa"], "unset updateMode = Auto (deprecated)");
  assert.deepEqual(ids(r, "VPA-004").map((f) => f.resource?.name), ["ghost-vpa"]);
  assert.deepEqual(ids(r, "HPA-002").map((f) => f.resource?.name), ["ghost-hpa"]);
  assert.deepEqual(ids(r, "HPA-001").map((f) => f.resource?.name), ["web-hpa"], "web has no cpu request");
  assert.deepEqual(ids(r, "PDB-002").map((f) => f.resource?.name), ["svc-pdb"], "minAvailable == replicas blocks drain");
  assert.deepEqual(ids(r, "PDB-003").map((f) => f.resource?.name), ["orphan-pdb"]);
  assert.deepEqual(ids(r, "PDB-001").map((f) => f.resource?.name).sort(), ["api", "web"]);
  assert.equal(ids(r, "VPA-001").length, 0, "VPA installed → no install hint");

  const notInstalled = analyzePolicies({ ...scenario(), vpas: [], capabilities: { vpaInstalled: false, ciliumInstalled: false, unavailable: [] } }, "c1");
  assert.equal(ids(notInstalled, "VPA-001").length, 1);

  const web = r.workloads.find((w) => w.name === "web")!;
  assert.equal(web.containersWithoutRequests, 1);
  assert.equal(web.serviceAccount, "default");
  assert.equal(web.hpa?.name, "web-hpa");
  assert.equal(r.workloads.find((w) => w.name === "svc")!.pdb, "svc-pdb");
});

test("Resources / service accounts", () => {
  const r = analyzePolicies(scenario(), "c1");
  assert.deepEqual(ids(r, "RES-001").map((f) => f.resource?.name), ["web"]);
  assert.deepEqual(ids(r, "SA-001").map((f) => f.resource?.name), ["web"], "api/svc use dedicated SAs");
  assert.deepEqual(ids(r, "RES-003").map((f) => f.namespace), ["app"], "secure has quota + limitrange");
});

test("RBAC: cluster-admin, escalation, anonymous, authenticated, default SA, dangling", () => {
  const r = analyzePolicies(scenario(), "c1");
  const admin = ids(r, "RBAC-001");
  assert.deepEqual(admin.map((f) => f.resource?.name), ["alice-admin"], "system:masters default binding is not flagged");
  assert.equal(admin[0]!.severity, "high");

  const risky = ids(r, "RBAC-002");
  const secrets = risky.find((f) => f.resource?.name === "read-secrets")!;
  assert.equal(secrets.severity, "low", "namespaced RoleBinding lowers a medium risk to low");
  const esc = risky.filter((f) => f.resource?.name === "escalators");
  assert.equal(esc.length, 1, "one finding per binding");
  assert.equal(esc[0]!.severity, "high");
  assert.match(esc[0]!.detail, /escalate/);
  assert.match(esc[0]!.detail, /bind/);
  assert.deepEqual(r.rbac.bindings.find((b) => b.name === "escalators")!.risks.length, 2);

  assert.deepEqual(ids(r, "RBAC-003").map((f) => f.resource?.name), ["anon-view"]);
  assert.deepEqual(ids(r, "RBAC-004").map((f) => f.resource?.name), ["viewer-binding"]);
  assert.deepEqual(ids(r, "RBAC-005").map((f) => f.resource?.name), ["read-secrets"]);
  assert.deepEqual(ids(r, "RBAC-006").map((f) => f.resource?.name), ["dangling"]);

  const masters = r.rbac.bindings.find((b) => b.name === "cluster-admin")!;
  assert.equal(masters.system, true);
  const reader = r.rbac.roles.find((x) => x.name === "secret-reader")!;
  assert.equal(reader.bindingCount, 1);
  assert.equal(r.rbac.roles.find((x) => x.name === "viewer")!.bindingCount, 1, "namespaced Role counts only same-namespace RoleBindings");
});

test("RBAC: AKS local-account admin binding is surfaced; Eno-managed objects are system", () => {
  const inv = emptyInventory();
  inv.roles = [
    { kind: "ClusterRole", name: "cluster-admin", labels: { "kubernetes.io/bootstrapping": "rbac-defaults" }, rules: [{ apiGroups: ["*"], resources: ["*"], verbs: ["*"] }], aggregated: false },
    { kind: "ClusterRole", name: "cilium-operator", labels: { "app.kubernetes.io/actually-managed-by": "Eno" }, rules: [{ apiGroups: [""], resources: ["secrets"], verbs: ["get"] }], aggregated: false },
  ];
  inv.bindings = [
    { kind: "ClusterRoleBinding", name: "aks-cluster-admin-binding", labels: { "addonmanager.kubernetes.io/mode": "Reconcile" }, roleRef: { kind: "ClusterRole", name: "cluster-admin" }, subjects: [{ kind: "User", name: "clusterUser" }] },
    { kind: "ClusterRoleBinding", name: "cilium-operator", labels: { "app.kubernetes.io/actually-managed-by": "Eno" }, roleRef: { kind: "ClusterRole", name: "cilium-operator" }, subjects: [{ kind: "ServiceAccount", name: "cilium-operator", namespace: "kube-system" }] },
  ];
  const r = analyzePolicies(inv, "c1");
  const aks = ids(r, "RBAC-001")[0]!;
  assert.equal(aks.system, false);
  assert.match(aks.recommendation, /disable-local-accounts/);
  assert.equal(ids(r, "RBAC-002")[0]!.system, true);
});

test("Scoring excludes system findings; finding ids are unique; order puts user findings first", () => {
  const r = analyzePolicies(scenario(), "c1");
  const ids = r.findings.map((f) => f.id);
  assert.equal(new Set(ids).size, ids.length, "unique ids");
  assert.ok(r.summary.score >= 0 && r.summary.score <= 100);
  const nonSystemHigh = r.findings.filter((f) => !f.system && f.severity === "high").length;
  assert.equal(r.summary.findings.high, nonSystemHigh);
  const firstSystem = r.findings.findIndex((f) => f.system);
  assert.ok(firstSystem === -1 || r.findings.slice(firstSystem).every((f) => f.system), "system findings sorted last");

  // A clean cluster scores 100
  const clean = emptyInventory();
  clean.namespaces = [{ name: "empty", labels: { "pod-security.kubernetes.io/enforce": "restricted", "pod-security.kubernetes.io/enforce-version": "v1.33" } }];
  const cr = analyzePolicies(clean, "c1");
  assert.equal(cr.summary.score, 100);
  assert.equal(cr.findings.length, 0);
});
