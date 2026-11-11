// AKS 모니터링 › 로그 — a line's details like Grafana's (API services/lokiLogs.ts podEntries · getLogContext, web
// lib/podLogView.ts): indexed labels and structured metadata kept apart (Loki's categorize-labels answer), the exact
// timestamp as the context anchor, values masked and bounded; the viewer is built from the kit.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { PodLogEntry } from "@aud/types";
import { getLogContext, podEntries, safeLabels } from "../src/services/lokiLogs.js";
import * as viewNs from "../../web/src/lib/podLogView.ts";

const V = ((viewNs as unknown as { default?: typeof viewNs }).default ?? viewNs) as typeof viewNs;
const NS = (ms: number, extra = 0) => String(BigInt(ms) * 1_000_000n + BigInt(extra));
const T0 = Date.parse("2026-11-11T08:25:33.673Z");

// The shape Loki 3 answers with X-Loki-Response-Encoding-Flags: categorize-labels (names are placeholders)
const BODY = {
  data: { result: [{
    stream: { collector: "alloy", container: "api", job: "loki.source.kubernetes.pods", namespace: "app", pod: "api-7d9f8c6b5-bcdfg", service_name: "api" },
    values: [
      [NS(T0, 2), "2026-11-11 ERROR boom password=hunter2", { structuredMetadata: { detected_level: "error", level: "error" }, parsed: {} }],
      [NS(T0, 1), "2026-11-11 DEBUG Securing GET /actuator/health", { structuredMetadata: { detected_level: "debug" } }],
      [NS(T0 - 5), "plain line without a level"],
    ] as Array<[string, string, Record<string, string>?]>,
  }] },
};

test("entries: indexed labels from the stream, structured metadata from the line — kept apart; oldest first by the exact timestamp", () => {
  const { lines, redactions } = podEntries(BODY as never, "api-7d9f8c6b5-bcdfg");
  assert.deepEqual(lines.map((l) => l.level), ["unknown", "info", "error"], "oldest first; two lines of one millisecond keep their order");
  const err = lines[2]!;
  assert.deepEqual(Object.keys(err.labels!), ["collector", "container", "job", "namespace", "pod", "service_name"], "sorted, indexed only");
  assert.deepEqual(err.metadata, { detected_level: "error", level: "error" });
  assert.equal(err.tsNs, NS(T0, 2));
  assert.equal(err.containerName, "api");
  assert.ok(!err.logMessage.includes("hunter2") && redactions >= 1, "the line is masked like every log line");
  assert.equal(lines[0]!.metadata, undefined, "no structured metadata = no group (not an empty one)");
  assert.ok(!("level" in err.labels!), "a structured value is never listed as an indexed label");
});

test("labels are bounded and masked: valid names only, 30 at most, long values cut, secrets redacted", () => {
  const many = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`l${String(i).padStart(2, "0")}`, "v"]));
  assert.equal(Object.keys(safeLabels(many).labels).length, 30);
  const r = safeLabels({ ok: "x".repeat(400), "bad name": "v", n: 5, token: "Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefghijklmnop" });
  assert.deepEqual(Object.keys(r.labels), ["ok", "token"]);
  assert.equal(r.labels.ok!.length, 301);
  assert.ok(!r.labels.token!.includes("eyJhbGci") && r.redactions >= 1);
  assert.deepEqual(safeLabels(null).labels, {});
  assert.deepEqual(safeLabels(["a"]).labels, {});
});

test("context: signed-in, Kubernetes names, a nanosecond timestamp; the route keeps the pod-log gate", async () => {
  const env = { AUD_ANONYMOUS_SP: false, AUD_ANONYMOUS_K8S: false } as never;
  const C = "/subscriptions/00000000-0000-0000-0000-000000000001/resourceGroups/rg/providers/Microsoft.ContainerService/managedClusters/aks";
  const code = (c: string) => (e: unknown) => (e as { code?: string }).code === c;
  await assert.rejects(getLogContext(env, undefined, C, { namespace: "app", pod: "p", tsNs: NS(T0), lines: 20 }), code("signin_required"));
  await assert.rejects(getLogContext(env, "t", C, { namespace: "app", pod: 'p"} or {a="', tsNs: NS(T0), lines: 20 }), code("invalid_name"));
  await assert.rejects(getLogContext(env, "t", C, { namespace: "app", pod: "p", tsNs: "now", lines: 20 }), code("invalid_time"));
  const routes = readFileSync(new URL("../src/routes/observability.ts", import.meta.url), "utf8");
  assert.match(routes, /"\/api\/observability\/log-context", requireRole\(env, "operator"\)/);
  assert.match(routes, /log-context[\s\S]{0,500}podLogNamespaceAllowed\(env, clusterId, namespace!\)/);
  const src = readFileSync(new URL("../src/services/lokiLogs.ts", import.meta.url), "utf8");
  assert.match(src, /end: String\(ts\), limit: n, direction: "backward"/, "the line itself is not read again (end is exclusive)");
  assert.match(src, /start: String\(ts \+ 1n\)/);
});

const line = (p: Partial<PodLogEntry>): PodLogEntry => ({ timestamp: "2026-11-11T08:25:33.673Z", podName: "api-0", containerName: "api", logMessage: "msg", stream: "unknown", ...p });

test("view: level from the API or the word the line states; filters and counts; row keys; what can show context", () => {
  assert.equal(V.levelOf(line({ level: "warn", logMessage: "ERROR in text" })), "warn", "the API's level wins");
  assert.equal(V.levelOf(line({ logMessage: "2026-11-11 08:00:00 ERROR boom" })), "error");
  assert.equal(V.levelOf(line({ logMessage: "[WARNING] slow" })), "warn");
  assert.equal(V.levelOf(line({ logMessage: "started in 3s" })), "unknown", "no level word = unknown, never guessed");
  assert.equal(V.levelOf(line({ logMessage: "terrorism INFORMATION" })), "unknown", "a word containing ERROR is not a level");
  const logs = [line({ level: "error" }), line({ level: "warn" }), line({ level: "info" }), line({})];
  assert.deepEqual(V.levelCounts(logs), { error: 1, warn: 1, info: 1, unknown: 1 });
  assert.deepEqual(["all", "warn", "error"].map((f) => logs.filter((l) => V.passesLevel(l, f as never)).length), [4, 2, 1]);
  assert.notEqual(V.lineKey(line({ tsNs: "1762849533673000001" }), 0), V.lineKey(line({ tsNs: "1762849533673000001" }), 1), "same instant, two rows");
  assert.equal(V.hasContext(line({ tsNs: "1762849533673000001" })), true);
  assert.equal(V.hasContext(line({})), false, "kubelet / Container Insights lines have no anchor");
});

test("view: label rows sorted, the first line as the summary, the copied text carries labels and metadata", () => {
  assert.deepEqual(V.labelRows({ pod: "p", namespace: "app" }), [["namespace", "app"], ["pod", "p"]]);
  assert.deepEqual(V.labelRows(undefined), []);
  assert.equal(V.firstLine("head\n\tat Foo.bar"), "head");
  assert.equal(V.firstLine("x".repeat(500)).length, 401);
  assert.equal(V.lineText(line({ labels: { pod: "p" }, metadata: { level: "error" } })), '2026-11-11T08:25:33.673Z msg\npod="p"\nlevel="error"');
});

test("the viewer is the kit's: no hand-made toolbar controls, the list grammar of the workload stream, every runtime key translated", () => {
  const tab = readFileSync(new URL("../../web/src/app/observability/components/LogsTab.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(tab, /<select|<input|<button/, "Select · SearchInput · Toggle · Segmented from the kit");
  assert.doesNotMatch(tab, /logContainer|logsToolbar|logAutoScroll/, "the dark console and its own toolbar are gone");
  const list = readFileSync(new URL("../../web/src/app/observability/components/PodLogList.tsx", import.meta.url), "utf8");
  assert.match(list, /className=\{styles\.lgList\}/);
  assert.match(list, /Indexed labels/);
  assert.match(list, /Structured metadata/);
  const msgs = readFileSync(new URL("../../web/src/lib/i18nOps.ts", import.meta.url), "utf8");
  const has = (k: string) => new RegExp(`"${k.replace(/\./g, "\\.")}": \\{ ko: "[^"]+", en: "[^"]+" \\}`).test(msgs);
  for (const k of ["error", "warn", "info", "unknown"].map((l) => `ob.pl.level.${l}`)) assert.ok(has(k), k);
});
