import { test } from "node:test";
import assert from "node:assert/strict";
import type { OpsCase, OpsRunbook } from "@aud/types";
import { extractSignals, findSimilar, scopeOverlap, tokenize } from "../src/services/opsMatch.js";
import { CaseBody, RunbookBody, clearOpsMemory, maskTexts, readKnowledge, runbookUsage, visible, writeOps } from "../src/services/opsKnowledgeStore.js";
import * as webNs from "../../web/src/lib/opsKnowledge.ts";

const web = ((webNs as unknown as { default?: typeof webNs }).default ?? webNs) as typeof webNs;

// 사례·런북 (docs/architecture/ops-knowledge.md). Fake names only; the texts are shaped like the 2026-11-13 stg cases.

const NOW = "2026-11-13T07:00:00.000Z";
const kase = (id: string, over: Partial<OpsCase>): OpsCase => ({
  id, title: id, status: "resolved", severity: "sev3", occurredAt: NOW, symptoms: "", tags: [], signals: [], scope: {}, runbookIds: [],
  rev: 1, createdAt: NOW, updatedAt: NOW, ...over,
});
const book = (id: string, over: Partial<OpsRunbook>): OpsRunbook => ({
  id, title: id, when: "", signals: [], tags: [], steps: [{ title: "look" }], rev: 1, createdAt: NOW, updatedAt: NOW, ...over,
});

test("signals are pulled out of pasted text: K8s reasons, exit codes, drop reasons, Entra / ARM / platform codes, exceptions, HTTP, resource types", () => {
  const s = extractSignals([
    "Back-off restarting failed container backend in pod hubble-ui-xxx: OOMKilled, exit code 137",
    "HTTP 502 Bad Gateway: {\"error\":\"hubble_ui_unsupported\"} · drop reason UNSUPPORTED_L3_PROTOCOL",
    "AADSTS700016: application not found · AuthorizationFailed on Microsoft.ContainerService/managedClusters",
    "java.lang.OutOfMemoryError: Java heap space",
  ].join("\n"));
  const has = (kind: string, value: string) => assert.ok(s.some((x) => x.kind === kind && x.value === value), `${kind}:${value} in ${JSON.stringify(s)}`);
  has("k8sReason", "OOMKilled");
  has("exitCode", "137");
  has("httpStatus", "502");
  has("errorCode", "hubble_ui_unsupported");
  has("dropReason", "UNSUPPORTED_L3_PROTOCOL");
  has("errorCode", "AADSTS700016");
  has("errorCode", "AuthorizationFailed");
  has("resourceType", "Microsoft.ContainerService/managedClusters");
  has("exception", "OutOfMemoryError");
  assert.equal(new Set(s.map((x) => `${x.kind}:${x.value.toLowerCase()}`)).size, s.length, "no duplicates");
  assert.deepEqual(extractSignals("everything looks fine today"), []);
});

test("Korean text is compared in two-letter pieces — particles need no stemming", () => {
  assert.deepEqual(tokenize("메모리가"), ["메모", "모리", "리가"]);
  assert.ok(tokenize("파드가 메모리 부족으로 재시작").includes("메모"));
  assert.deepEqual(tokenize("the pod was OOMKilled"), ["pod", "oomkilled"]);
});

test("scope: same workload > namespace > resource type > cluster", () => {
  assert.deepEqual(scopeOverlap({ namespace: "kube-system", workload: "hubble-ui" }, { namespace: "kube-system", workload: "hubble-ui" }), { score: 1, on: ["workload", "namespace"] });
  assert.deepEqual(scopeOverlap({ namespace: "a" }, { namespace: "b" }).on, []);
  assert.equal(scopeOverlap({ clusterName: "stg" }, { clusterName: "STG" }).on[0], "cluster");
});

const CASES = [
  kase("hubble-ui-oom", {
    title: "hubble-ui backend OOMKilled — Pod 트래픽 화면 502", symptoms: "보안 탭 HTTP 502 hubble_ui_unsupported. hubble-ui backend 컨테이너 OOMKilled exit code 137, 메모리 한도 256Mi",
    cause: "채널마다 data_throttler 누수 + 대시보드가 채널을 동시에 여러 개 열었음", resolution: "채널 하나씩·공용 표본 2분, backend limit 512Mi + GOMEMLIMIT",
    scope: { namespace: "kube-system", workload: "hubble-ui" }, runbookIds: ["oom-response"], signals: [{ kind: "keyword", value: "hubble-ui" }],
  }),
  kase("ipv6-drops", {
    title: "서비스 맵 빨간 차단이 IPv6 패킷", symptoms: "UNSUPPORTED_L3_PROTOCOL ICMPv6 드롭이 unknown 대상으로", resolution: "드롭 분류: 정책/IPv6/기타",
  }),
  kase("entra-app", { title: "Grafana 가져오기 AADSTS700016", symptoms: "AADSTS700016 application not found in the directory", status: "open" }),
  kase("other-tenant", { title: "hidden", symptoms: "OOMKilled somewhere else" }),
];
const RUNBOOKS = [
  book("oom-response", { title: "컨테이너 OOMKilled 대응", when: "컨테이너가 OOMKilled로 재시작을 반복할 때", signals: [{ kind: "keyword", value: "OOMKilled" }],
    steps: [{ title: "이전 컨테이너 종료 이유 확인", command: "kubectl describe pod <pod> -n <ns>" }, { title: "메모리 사용량 vs limit 비교" }] }),
  book("token-expired", { title: "Azure 로그인 만료", when: "AADSTS70043 sign-in frequency", signals: [{ kind: "errorCode", value: "AADSTS70043" }] }),
];

test("similar: a new OOMKilled on hubble-ui finds the hubble-ui case (strong, with why) and the runbook it used — the helper puts it first", () => {
  const r = findSimilar({ text: "hubble-ui-69c45b889f backend OOMKilled, exit code 137", scope: { namespace: "kube-system", workload: "hubble-ui" } }, CASES.slice(0, 3), RUNBOOKS);
  assert.equal(r.cases[0]?.id, "hubble-ui-oom");
  assert.equal(r.cases[0]?.strength, "strong");
  assert.ok(r.cases[0]!.why.signals.some((s) => s.value === "OOMKilled"));
  assert.deepEqual(r.cases[0]!.why.scope, ["workload", "namespace"]);
  assert.ok(!r.cases.some((c) => c.id === "entra-app"), "an unrelated case is not listed");
  assert.equal(r.runbooks[0]?.id, "oom-response");
  assert.deepEqual(r.suggested[0], { runbookId: "oom-response", fromCases: ["hubble-ui-oom"], direct: true });
});

test("similar: Korean words alone find a case; an exact error code beats words; nothing in common = nothing listed", () => {
  const ko = findSimilar({ text: "서비스 맵에 빨간 차단 표시" }, CASES.slice(0, 3), RUNBOOKS);
  assert.equal(ko.cases[0]?.id, "ipv6-drops");
  const code = findSimilar({ text: "pull failed: AADSTS700016" }, CASES.slice(0, 3), RUNBOOKS);
  assert.equal(code.cases[0]?.id, "entra-app");
  assert.deepEqual(code.suggested, [], "the open case used no runbook, no runbook matches");
  const none = findSimilar({ text: "disk quota on the build server" }, CASES.slice(0, 3), RUNBOOKS);
  assert.deepEqual([none.cases, none.runbooks, none.suggested], [[], [], []]);
  assert.ok(!findSimilar({ text: "OOMKilled", exclude: "hubble-ui-oom" }, CASES.slice(0, 3), RUNBOOKS).cases.some((c) => c.id === "hubble-ui-oom"), "the case being edited is left out");
});

test("store: create · update by revision (409 otherwise) · connection visibility · delete; runbook usage is counted from cases", async () => {
  clearOpsMemory();
  const mayUse = (k: string) => k === "home";
  const make = (rev: number | null, title: string, connection: string | null = null) => writeOps<OpsCase>(undefined, "cases", rev === null ? null : "oom-case", (prev, id) =>
    kase(id, { title, rev: (prev?.rev ?? 0) + 1, symptoms: "OOMKilled", runbookIds: ["oom-response"] }), { baseRev: rev, connection, mayUse, title: "OOM case" });
  const a = await make(null, "first");
  assert.ok(a.ok && a.item?.id === "oom-case");
  const stale = await writeOps<OpsCase>(undefined, "cases", "oom-case", (p, id) => kase(id, { rev: 9 }), { baseRev: 5, connection: null, mayUse });
  assert.equal(stale.ok ? "" : stale.error, "conflict");
  const b = await make(1, "second");
  assert.ok(b.ok && b.item?.rev === 2);
  const other = await writeOps<OpsCase>(undefined, "cases", null, (p, id) => kase(id, { title: "theirs" }), { baseRev: null, connection: "cust-b", mayUse, title: "theirs" });
  assert.equal(other.ok ? "" : other.error, "forbidden", "a cluster of a connection my role cannot use");
  // written as admin, read as someone who cannot use cust-b
  await writeOps<OpsCase>(undefined, "cases", null, (p, id) => kase(id, { title: "theirs" }), { baseRev: null, connection: "cust-b", mayUse: () => true, title: "theirs" });
  assert.deepEqual((await readKnowledge(undefined, new Set(["home"]))).cases.map((c) => c.id), ["oom-case"]);
  assert.equal((await readKnowledge(undefined, new Set(["home", "cust-b"]))).cases.length, 2);
  assert.ok(!("connection" in (await readKnowledge(undefined, new Set(["cust-b"]))).cases[0]!), "the connection key is not sent");
  assert.deepEqual(visible([{ connection: "x" }, {}], new Set()), [{}]);
  assert.deepEqual(runbookUsage([kase("a", { runbookIds: ["r", "r"], occurredAt: "2026-11-01T00:00:00Z" }), kase("b", { runbookIds: ["r"], status: "open", occurredAt: "2026-11-10T00:00:00Z" })]),
    { r: { cases: 2, resolved: 1, lastUsedAt: "2026-11-10T00:00:00Z" } });
  const del = await writeOps<OpsCase>(undefined, "cases", "oom-case", null, { baseRev: 2, connection: null, mayUse });
  assert.ok(del.ok);
  clearOpsMemory();
});

test("bodies: a case needs its symptoms, 'resolved' needs the fix; a runbook needs when and a step; pasted secrets are masked", () => {
  const base = { title: "t", status: "open", severity: "sev3", occurredAt: NOW, symptoms: "x", tags: [], signals: [], scope: {}, runbookIds: [], baseRev: null };
  assert.ok(CaseBody.safeParse(base).success);
  assert.ok(!CaseBody.safeParse({ ...base, symptoms: "  " }).success);
  assert.ok(!CaseBody.safeParse({ ...base, status: "resolved" }).success);
  assert.ok(CaseBody.safeParse({ ...base, status: "resolved", resolution: "raised the limit" }).success);
  assert.ok(!CaseBody.safeParse({ ...base, scope: { clusterId: "not-an-arm-id" } }).success);
  assert.ok(!RunbookBody.safeParse({ title: "r", when: "w", signals: [], tags: [], steps: [], baseRev: null }).success);
  const jwt = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJlLXNpZ25hdHVyZS1zaWduYXR1cmU";
  const m = maskTexts({ symptoms: `curl -H "Authorization: Bearer ${jwt}" → 401` }, ["symptoms"]);
  assert.ok(m.n >= 1 && !m.body.symptoms.includes(jwt));
});

test("web: the forms become the API bodies; an alert opens the find view with its text and scope", () => {
  const f = web.emptyCase(new Date(NOW), { title: "OOM", symptoms: "OOMKilled", status: "resolved", keywords: "hubble-ui, backend", alertRule: "KubePodCrashLooping", namespace: "kube-system" });
  assert.deepEqual(web.caseProblems(f), ["ops.kb.need.resolution"]);
  const body = web.caseBody({ ...f, resolution: "limit 512Mi" }, null);
  assert.ok(CaseBody.safeParse(body).success, JSON.stringify(CaseBody.safeParse(body).error?.issues));
  assert.deepEqual(body.signals.map((s) => `${s.kind}:${s.value}`), ["alertRule:KubePodCrashLooping", "keyword:hubble-ui", "keyword:backend"]);
  assert.deepEqual(body.scope, { namespace: "kube-system" });
  const rb = web.runbookBody({ ...web.emptyRunbook(), title: "r", when: "w", steps: [{ title: "a", command: "kubectl get pods" }, { title: " " }] }, null);
  assert.ok(RunbookBody.safeParse(rb).success);
  assert.equal(rb.steps.length, 1, "an empty step is dropped");
  const href = web.alertFindHref({ id: "gf:abc", rule: "KubePodCrashLooping", title: "Pod crash looping", summary: "backend OOMKilled", target: { namespace: "kube-system", workload: "hubble-ui" } });
  const u = new URL(href, "https://x.invalid");
  assert.equal(u.pathname, "/runbooks");
  assert.equal(u.searchParams.get("tab"), "find");
  assert.ok(u.searchParams.get("q")!.includes("OOMKilled"));
  assert.equal(u.searchParams.get("wl"), "hubble-ui");
  assert.equal(u.searchParams.get("alert"), "gf:abc");
  assert.deepEqual(web.filterCases(CASES, "hubble", "").map((c) => c.id), ["hubble-ui-oom"]);
  assert.deepEqual(web.filterCases(CASES, "", "open").map((c) => c.id), ["entra-app"]);
});

test("agent seam (skeleton): the context is the text + the closest experience, masked and cut; no provider = not configured", async () => {
  const { AGENT_LIMITS, agentContext, agentStatus, agentProvider } = await import("../src/services/opsAgent.js");
  const jwt = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJlLXNpZ25hdHVyZS1zaWduYXR1cmU";
  const text = `hubble-ui backend OOMKilled exit code 137 Authorization: Bearer ${jwt} ` + "x".repeat(6000);
  const similar = findSimilar({ text }, CASES.slice(0, 3), RUNBOOKS);
  const ctx = agentContext(text, similar, CASES.slice(0, 3), RUNBOOKS);
  assert.ok(ctx.text.length <= AGENT_LIMITS.textChars, "the text is cut");
  assert.ok(!ctx.text.includes(jwt) && ctx.redactions >= 1, "secrets masked before anything would leave");
  assert.equal(ctx.cases[0]?.id, "hubble-ui-oom", "the closest case first");
  assert.ok(ctx.cases.length <= AGENT_LIMITS.cases && ctx.runbooks.length <= AGENT_LIMITS.runbooks);
  assert.equal(ctx.runbooks[0]?.id, "oom-response", "the helper's runbook first");
  assert.deepEqual(ctx.runbooks[0]?.steps, ["이전 컨테이너 종료 이유 확인", "메모리 사용량 vs limit 비교"], "step titles only — commands are not sent");
  assert.equal(agentProvider({ AUD_OPS_AGENT: "off" }), null);
  assert.deepEqual(agentStatus({}).state, "notConfigured");
});
