import { test } from "node:test";
import assert from "node:assert/strict";
import { fixAtText, parseArgoApplications, repoShort, sanitizeRepoUrl, sourceOf } from "../src/services/gitopsSource.js";

test("repo URLs never carry credentials; short form for the screen", () => {
  assert.equal(sanitizeRepoUrl("https://user:ghp_secret@github.com/org/infra.git?ref=x#frag"), "https://github.com/org/infra.git");
  assert.equal(sanitizeRepoUrl("https://dev.azure.com/org/proj/_git/infra"), "https://dev.azure.com/org/proj/_git/infra");
  assert.equal(sanitizeRepoUrl("git@github.com:org/infra.git"), "git@github.com:org/infra.git");
  assert.equal(repoShort("https://github.com/org/infra.git"), "github.com/org/infra");
  assert.equal(repoShort("git@github.com:org/infra.git"), "github.com/org/infra");
});

const apps = parseArgoApplications([
  { // single source, path
    metadata: { name: "payments", namespace: "argocd" },
    spec: { source: { repoURL: "https://bot:token@github.com/org/gitops.git", path: "apps/payments/overlays/stg", targetRevision: "main" } },
    status: { sync: { status: "Synced", revision: "0123456789abcdef" }, resources: [
      { group: "apps", kind: "Deployment", namespace: "payments", name: "api" },
      { group: "", kind: "Service", namespace: "payments", name: "api" },
    ] },
  },
  { // multi-source Helm: chart from a chart repo, values from the git repo ($values)
    metadata: { name: "monitoring", namespace: "argocd" },
    spec: { sources: [
      { repoURL: "https://grafana.github.io/helm-charts", chart: "alloy", targetRevision: "1.2.0", helm: { valueFiles: ["$values/env/stg/alloy.yaml", "extra.yaml"] } },
      { repoURL: "https://github.com/org/gitops.git", ref: "values" },
    ] },
    status: { sync: { status: "OutOfSync", revisions: ["1.2.0", "fedcba98"] }, resources: [{ group: "apps", kind: "DaemonSet", namespace: "monitor", name: "alloy" }] },
  },
  { metadata: { name: "no-source" }, spec: {} },
]);

test("Argo CD applications → source per app (multi-source primary, $ref value files resolved, synced revision of the primary)", () => {
  assert.deepEqual(apps.map((a) => a.name), ["monitoring", "payments"], "an app without a repository is skipped; sorted");
  const pay = apps.find((a) => a.name === "payments")!;
  assert.equal(pay.source.repo, "https://github.com/org/gitops.git", "credentials removed");
  assert.deepEqual(pay.manages, ["Deployment/payments/api"], "workloads only (apps group)");
  const mon = apps.find((a) => a.name === "monitoring")!;
  assert.deepEqual([mon.source.chart, mon.source.targetRevision, mon.source.syncedRevision, mon.source.sync], ["alloy", "1.2.0", "1.2.0", "OutOfSync"]);
  assert.deepEqual(mon.source.valueFiles, ["github.com/org/gitops: env/stg/alloy.yaml", "extra.yaml"]);
});

test("workload → its Application by status.resources (not by name), and the 'change it in' line", () => {
  const s = sourceOf(apps, { kind: "Deployment", namespace: "payments", name: "api" })!;
  assert.deepEqual([s.tool, s.app, s.appNamespace, s.path], ["argocd", "payments", "argocd", "apps/payments/overlays/stg"]);
  assert.equal(sourceOf(apps, { kind: "Deployment", namespace: "payments", name: "worker" }), undefined, "not listed = unknown, never guessed");
  assert.equal(sourceOf(apps, { kind: "StatefulSet", namespace: "payments", name: "api" }), undefined, "kind must match");
  assert.equal(fixAtText(s), "Argo CD payments → github.com/org/gitops/apps/payments/overlays/stg @main");
  assert.equal(fixAtText(sourceOf(apps, { kind: "DaemonSet", namespace: "monitor", name: "alloy" })!),
    "Argo CD monitoring → grafana.github.io/helm-charts (chart alloy 1.2.0) · values: github.com/org/gitops: env/stg/alloy.yaml, extra.yaml");
});
