import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AdvisoriesResponse, IssueState, PolicyInsightsResponse, PostureAlert, WorkloadIdentityResponse } from "@aud/types";
import { ISSUE_KEY, clearIssueStateMemory, issueStateDir, readIssueStates, validateChange, writeIssueState } from "../src/services/issueStateStore.js";
import * as iq from "../../web/src/lib/issueQueue.ts";
const { buildIssueQueue, clusterScope, effectiveStatus, teamOf } = ((iq as { default?: typeof iq }).default ?? iq) as typeof iq;

const SUB = "00000000-0000-0000-0000-0000000000aa";
const CLUSTER = `/subscriptions/${SUB}/resourceGroups/RG-AKS/providers/Microsoft.ContainerService/managedClusters/AKS1`;
const NOW = new Date("2026-10-30T00:00:00Z");

// ── store ──

test("store: exception needs a reason and an end date within a year; only exceptions carry an end date", () => {
  assert.equal(validateChange({ status: "accepted", baseRev: null }, NOW), "issue_exception_reason");
  assert.equal(validateChange({ status: "accepted", note: "vendor chart", baseRev: null }, NOW), "issue_exception_until");
  assert.equal(validateChange({ status: "accepted", note: "vendor chart", until: "2026-10-29", baseRev: null }, NOW), "issue_exception_until", "past");
  assert.equal(validateChange({ status: "accepted", note: "vendor chart", until: "2027-12-01", baseRev: null }, NOW), "issue_exception_until", "over a year");
  assert.equal(validateChange({ status: "accepted", note: "vendor chart", until: "2026-12-01", baseRev: null }, NOW), null);
  assert.equal(validateChange({ status: "resolved", until: "2026-12-01", baseRev: null }, NOW), "issue_until_only_exception");
  assert.equal(validateChange({ status: "inProgress", baseRev: null }, NOW), null);
});

test("store: per-issue revisions — a stale write gets the current state, history newest first (≤ 20), keys validated", async () => {
  clearIssueStateMemory();
  const key = `combo:${clusterScope(CLUSTER)}:takeover:obs/agent`;
  assert.ok(ISSUE_KEY.test(key));
  const a = await writeIssueState(undefined, SUB, key, { status: "inProgress", assignee: "platform", baseRev: null }, { by: "Kim", now: NOW });
  assert.ok(a.ok && a.state.rev === 1 && a.state.updatedBy === "Kim");
  const stale = await writeIssueState(undefined, SUB, key, { status: "resolved", baseRev: null }, { now: NOW });
  assert.ok(!stale.ok && stale.error === "conflict" && "current" in stale && stale.current?.rev === 1, "another tab wrote first");
  const other = await writeIssueState(undefined, SUB, "alert:high:x", { status: "inProgress", baseRev: null }, { now: NOW });
  assert.ok(other.ok, "a different issue never conflicts");
  for (let i = 1; i <= 22; i++) await writeIssueState(undefined, SUB, key, { status: i % 2 ? "open" : "inProgress", baseRev: i }, { now: NOW });
  const st = (await readIssueStates(undefined, SUB))[key]!;
  assert.equal(st.rev, 23);
  assert.equal(st.history.length, 20);
  assert.equal(st.history[0]!.status, st.status, "newest first");
  assert.equal((await writeIssueState(undefined, SUB, "evil key with spaces", { status: "open", baseRev: null })).ok, false);
  assert.equal((await writeIssueState(undefined, SUB, "other:x", { status: "open", baseRev: null })).ok, false);
});

test("store: a directory makes it durable (temp file → rename); default dir is the team-layout volume", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "aud-issues-"));
  try {
    const r = await writeIssueState(dir, SUB.toUpperCase(), "wi:rg/aks1:WI-17:mi:abc", { status: "accepted", note: "until the chart moves to WI", until: "2026-12-31", baseRev: null }, { now: NOW });
    assert.ok(r.ok);
    const raw = JSON.parse(await readFile(path.join(dir, `${SUB}.json`), "utf8"));
    assert.equal(raw.v, 1);
    assert.equal(raw.states["wi:rg/aks1:WI-17:mi:abc"].until, "2026-12-31");
    assert.deepEqual(Object.keys(await readIssueStates(dir, SUB)), ["wi:rg/aks1:WI-17:mi:abc"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  assert.equal(issueStateDir({ AUD_ARRANGEMENT_DIR: "/var/lib/aud/arrangements" }), path.join("/var/lib/aud/arrangements", "issues"));
  assert.equal(issueStateDir({ AUD_ISSUE_STATE_DIR: "/data/issues", AUD_ARRANGEMENT_DIR: "/x" }), "/data/issues");
  assert.equal(issueStateDir({}), undefined);
});

// ── queue ──

const state = (over: Partial<IssueState>): IssueState => ({ status: "open", rev: 1, updatedAt: "2026-10-29T00:00:00Z", history: [], ...over });

test("effective status: the source wins — resolved but read again later = reopened; read before the claim = verifying; exception ends", () => {
  assert.deepEqual(effectiveStatus(null, null, NOW), { status: "open", flag: null });
  assert.deepEqual(effectiveStatus(state({ status: "resolved", updatedAt: "2026-10-29T10:00:00Z" }), "2026-10-29T12:00:00Z", NOW), { status: "open", flag: "reopened" });
  assert.deepEqual(effectiveStatus(state({ status: "resolved", updatedAt: "2026-10-29T10:00:00Z" }), "2026-10-29T09:00:00Z", NOW), { status: "resolved", flag: "verifying" });
  assert.deepEqual(effectiveStatus(state({ status: "accepted", until: "2026-10-29" }), null, NOW), { status: "open", flag: "expired" });
  assert.deepEqual(effectiveStatus(state({ status: "accepted", until: "2026-11-30" }), null, NOW), { status: "accepted", flag: null });
});

const insights = {
  clusterId: CLUSTER, generatedAt: "2026-10-30T00:00:00Z",
  issues: [
    { id: "standing:crit", sev: "crit", kind: "standing", title: "클러스터 장악 수준 권한을 상시 가진 서비스 계정 3개", owner: "Helm argo-cd", edges: [{ from: "w0", to: "p0", ev: "perm" }],
      nodes: [{ id: "w0", refs: ["argo/app-controller"] }], members: [{ rowId: "argo/app-controller", namespace: "argo" }] },
    { id: "takeover:obs/agent", sev: "crit", kind: "takeover", title: "agent의 SA 토큰 …", owner: "kubectl · obs", edges: [{ from: "entry", to: "app", ev: "obs" }],
      nodes: [{ id: "app", refs: ["obs/agent"] }, { id: "api", refs: ["apiserver"] }] },
    { id: "standing", sev: "warn", kind: "standing", title: "고권한을 상시 가진 서비스 계정 6개", owner: "Helm", edges: [], nodes: [] },
  ],
} as unknown as PolicyInsightsResponse;
const wi = { clusterId: CLUSTER, generatedAt: "2026-10-30T00:00:00Z", findings: [
  { id: "WI-17:mi:abc", rule: "WI-17", sev: "warn", ev: "cfg", title: "IMDS 경로", refs: ["mi:abc", "w:payments/Deployment/api"] },
  { id: "WI-06:fic:x:aud", rule: "WI-06", sev: "low", ev: "cfg", title: "audience", refs: [] },
] } as unknown as WorkloadIdentityResponse;
const advisories = { clusterId: CLUSTER, generatedAt: "2026-10-30T00:00:00Z", items: [
  { key: "vendor:nodejs:2026-10-21", status: "affected", title: "Node.js 보안 릴리스", cves: [{ id: "CVE-2026-1", kev: { dateAdded: "x" }, exploitation: null, cvss: null }], targets: [{ where: "이 대시보드", status: "affected" }] },
  { key: "kev:CVE-2026-2", status: "clear", title: "x", cves: [], targets: [] },
] } as unknown as AdvisoriesResponse;
const alert = (title: string, severity: PostureAlert["severity"], at: string): PostureAlert => ({ id: `${title}${at}`, title, severity, status: "Active", detectedAt: at, description: "", resources: [{ name: "aks1", type: "managedClusters", resourceGroup: "rg-aks" }] });

test("queue: four sources, one key each (ASCII), severity mapped, informational and low WI dropped, open critical first", () => {
  const alerts = [alert("Container with a sensitive volume mount detected", "Medium", "2026-10-20T00:00:00Z"), alert("Container with a sensitive volume mount detected", "Medium", "2026-10-21T00:00:00Z"), alert("Note", "Informational", "2026-10-21T00:00:00Z")];
  const q = buildIssueQueue({ clusterId: CLUSTER, insights, wi, advisories, alerts, alertsAt: "2026-10-30T00:00:00Z", states: {}, now: NOW });
  assert.deepEqual(q.items.map((i) => [i.source, i.sev]), [["combo", "critical"], ["combo", "critical"], ["vuln", "critical"], ["combo", "high"], ["wi", "high"], ["alert", "medium"]]);
  for (const i of q.items) assert.ok(ISSUE_KEY.test(i.key), i.key);
  assert.ok(q.items.every((i) => !i.key.includes("subscriptions")), "scope = rg/cluster (the state file is per subscription)");
  const al = q.items.find((i) => i.source === "alert")!;
  assert.match(al.title, /×2$/, "the same detection twice is one issue");
  assert.equal(al.evidence, "obs");
  assert.match(q.items.find((i) => i.source === "combo")!.href, /issue=standing%3Acrit/);
  assert.deepEqual(q.counts, { open: 6, openCritical: 3, inProgress: 0, accepted: 0, resolved: 0 });
});

test("queue: stored states apply by key; states of issues no longer found count as 'not detected' only for sources that were read", () => {
  const scope = clusterScope(CLUSTER);
  const states: Record<string, IssueState> = {
    [`combo:${scope}:standing`]: state({ status: "accepted", note: "vendor", until: "2026-12-31" }),
    [`combo:${scope}:takeover:obs/agent`]: state({ status: "resolved", updatedAt: "2026-10-29T00:00:00Z" }),
    [`combo:${scope}:exfil:app/gone`]: state({ status: "resolved" }),
    [`wi:${scope}:WI-05:fic:old`]: state({ status: "inProgress" }),
    "combo:other-rg/aks2:standing": state({ status: "inProgress" }),
  };
  const q = buildIssueQueue({ clusterId: CLUSTER, insights, wi: null, states, now: NOW });
  const by = (k: string) => q.items.find((i) => i.key === `combo:${scope}:${k}`)!;
  assert.equal(by("standing").status, "accepted");
  assert.deepEqual([by("takeover:obs/agent").status, by("takeover:obs/agent").flag], ["open", "reopened"], "read again after the claim");
  assert.equal(q.notDetected, 1, "the gone combo — not the WI one (WI not read), not another cluster's");
  assert.equal(q.counts.accepted, 1);
});

test("teams: namespace rules before resource-group rules, file order, prefix*, case-insensitive; issues carry their namespaces", () => {
  const rules = [
    { team: "platform", resourceGroups: ["rg-aks"] },
    { team: "gitops", namespaces: ["argo*"] },
    { team: "observability", namespaces: ["obs", "monitor"] },
  ];
  assert.equal(teamOf(["argo"], ["rg-aks"], rules), "gitops", "a namespace rule beats an earlier resource-group rule");
  assert.equal(teamOf(["OBS"], [], rules), "observability");
  assert.equal(teamOf([], ["RG-AKS"], rules), "platform");
  assert.equal(teamOf(["payments"], ["rg-other"], rules), null);
  const q = buildIssueQueue({ clusterId: CLUSTER, insights, wi, states: {}, owners: rules, now: NOW });
  const by = (id: string) => q.items.find((i) => i.key.endsWith(id))!;
  assert.deepEqual(by(":standing:crit").namespaces, ["argo"]);
  assert.equal(by(":standing:crit").team, "gitops");
  assert.deepEqual(by(":takeover:obs/agent").namespaces, ["obs"], "apiserver is not a namespace");
  assert.equal(by(":takeover:obs/agent").team, "observability");
  assert.equal(by(":standing").team, "platform", "no namespace → the cluster's resource group");
  assert.deepEqual(by("WI-17:mi:abc").namespaces, ["payments"], "w:<ns>/<kind>/<name> graph ids");
});
