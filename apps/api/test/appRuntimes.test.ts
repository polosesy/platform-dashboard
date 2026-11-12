// AKS 모니터링 › 클러스터 · 워크로드 › 조립식 표: what kind of application a workload is (evidence only — metrics, OpenTelemetry, the manifest, the image scan, an official image; never a name guess),
// the representative metrics of runtimes other than Java, and the block (column) set the viewer snaps together.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as ar from "../src/services/appRuntimes.js";
import * as ev from "../src/services/runtimeEvidence.js";
import * as blocksNs from "../../web/src/lib/workloadBlocks.ts";
const wb = ((blocksNs as unknown as { default?: typeof blocksNs }).default ?? blocksNs) as typeof blocksNs;

const row = (metric: Record<string, string>, value = 1) => ({ metric, value });
const owner = (pod: string, name: string, kind = "ReplicaSet") => row({ namespace: "shop", pod, owner_kind: kind, owner_name: name });
const rs = (name: string, dep: string) => row({ namespace: "shop", replicaset: name, owner_kind: "Deployment", owner_name: dep });

const RAW = {
  podOwners: [owner("web-7d9f8c6b5-abcde", "web-7d9f8c6b5"), owner("web-7d9f8c6b5-fghij", "web-7d9f8c6b5"), owner("cache-0", "cache", "StatefulSet"), owner("job-5c7d9b8f6-xk2lp", "job-5c7d9b8f6")],
  rsOwners: [rs("web-7d9f8c6b5", "web"), rs("job-5c7d9b8f6", "job")],
  "detect:nodejs": [row({ namespace: "shop", pod: "web-7d9f8c6b5-abcde" }), row({ namespace: "shop", pod: "web-7d9f8c6b5-fghij" })],
  images: [row({ namespace: "shop", pod: "cache-0", image: "docker.io/library/redis:7.4" }), row({ namespace: "shop", pod: "web-7d9f8c6b5-abcde", image: "registry.example/shop/web:1.2" })],
  "col:nodeEventLoopLag": [row({ namespace: "shop", pod: "web-7d9f8c6b5-abcde" }, 12), row({ namespace: "shop", pod: "web-7d9f8c6b5-fghij" }, 40)],
  "col:nginxConnections": [],
};

test("app runtimes: the kind comes from the metrics (fact); the image only hints, and never for an application image", () => {
  const a = ar.aggregateApps(RAW);
  const by = Object.fromEntries(a.workloads.map((w) => [w.workload, w]));
  assert.deepEqual(by.web!.kinds, [{ kind: "nodejs", basis: "metrics" }]);
  assert.deepEqual(by.cache!.kinds, [{ kind: "redis", basis: "image", evidence: "Docker Hub official image" }], "a Docker Hub official image states what it is");
  assert.deepEqual(by.job!.kinds, [], "no evidence = no kind (never guessed)");
  assert.equal(by.web!.values.nodeEventLoopLag, 40, "the worst pod");
  assert.equal(by.cache!.values.redisClients, undefined, "no series = no value (never 0)");
  assert.equal(ev.officialImageRuntime("registry.example/team/my-nginx-proxy-app:1"), null);
  assert.equal(ev.officialImageRuntime("mirror.example/redis:7"), null, "a mirror or a look-alike name is not claimed (2026-11-12: no name guessing)");
  assert.equal(ev.officialImageRuntime("mirror.example/bitnami/postgresql:16"), null);
  assert.equal(ev.officialImageRuntime("nginx"), "nginx");
  assert.equal(ev.officialImageRuntime("docker.io/library/postgres:16"), "postgres");
});

test("app runtimes: the version the runtime reports; OpenTelemetry, the manifest and the image scan name a kind only when nothing stronger did", () => {
  const raw = {
    ...RAW,
    podOwners: [...RAW.podOwners, owner("api-6f7c8d9b5-q1w2e", "api-6f7c8d9b5"), owner("worker-0", "worker", "StatefulSet"), owner("batch-0", "batch", "StatefulSet")],
    rsOwners: [...RAW.rsOwners, rs("api-6f7c8d9b5", "api")],
    "ver:nodejs": [row({ namespace: "shop", pod: "web-7d9f8c6b5-abcde", version: "v20.11.0" })],
    otel: [row({ k8s_namespace_name: "shop", k8s_pod_name: "api-6f7c8d9b5-q1w2e", telemetry_sdk_language: "java", process_runtime_version: "17.0.9+9" }), row({ namespace: "shop", pod: "web-7d9f8c6b5-abcde", telemetry_sdk_language: "nodejs" })],
    images: [...RAW.images, row({ namespace: "shop", pod: "batch-0", image: "acr.example/shop/batch:3", image_id: "acr.example/shop/batch@sha256:" + "a".repeat(64) })],
  };
  const templates = {
    containers: new Map<string, unknown[]>([
      ["StatefulSet/shop/worker", [{ name: "app", command: ["/bin/sh", "-c", "exec python3 -m worker --role node"], env: [{ name: "PYTHONUNBUFFERED", value: "do-not-read" }] }]],
      ["Deployment/shop/job", [{ name: "app", args: ["java", "-jar", "x.jar"] }]],
      ["Deployment/shop/web", [{ name: "app", command: ["dotnet", "x.dll"] }]],
    ]),
    annotations: new Map<string, Record<string, string>>(),
  };
  const scan = [{ registry: "acr.example", repo: "shop/batch", digest: "sha256:" + "a".repeat(64), tags: "[\"3\"]", langs: ["java", "python"] }];
  const a = ar.aggregateApps(raw, new Set(), { templates, scan });
  const by = Object.fromEntries(a.workloads.map((w) => [w.workload, w]));
  assert.deepEqual(by.web!.kinds[0], { kind: "nodejs", basis: "metrics", version: "20.11.0" }, "metrics win; OpenTelemetry does not repeat the kind");
  assert.deepEqual(by.web!.kinds[1], { kind: "dotnet", basis: "spec", evidence: "command: dotnet" }, "another runtime the manifest starts is added, as declared");
  assert.deepEqual(by.api!.kinds, [{ kind: "jvm", basis: "telemetry", evidence: "telemetry.sdk.language: java", version: "17.0.9" }]);
  assert.deepEqual(by.worker!.kinds, [{ kind: "python", basis: "spec", evidence: "command: python3" }], "the executable behind sh -c; an argument called node is not a runtime");
  assert.deepEqual(by.job!.kinds, [], "args alone go to the image's entrypoint — not read");
  assert.deepEqual(by.batch!.kinds.map((k) => [k.kind, k.basis, k.evidence]), [["jvm", "scan", "scan: java"], ["python", "scan", "scan: python"]], "the scan says what the image contains — every language it found");
  assert.ok(!JSON.stringify(a).includes("do-not-read"), "values of variables never leave");
  const rt = Object.fromEntries(a.runtimes.map((r) => [r.kind, r]));
  assert.deepEqual([rt.jvm!.workloads, rt.jvm!.hinted], [0, 2]);
});

test("runtime evidence: the executable of a command, runtime-read variables only, the Operator's annotation", () => {
  assert.equal(ev.executableOf(["/usr/bin/tini", "--", "/opt/java/openjdk/bin/java", "-jar", "app.jar"]), "java");
  assert.equal(ev.executableOf(["env", "TZ=UTC", "node", "server.js"]), "node");
  assert.equal(ev.executableOf(["/app/server"]), "server");
  assert.equal(ev.executableOf(undefined), null);
  assert.deepEqual(ev.runtimesOfSpec([{ env: [{ name: "JAVA_OPTS" }, { name: "NODE_ENV" }] }]), [], "team conventions are not evidence");
  assert.deepEqual(ev.runtimesOfSpec([{ env: [{ name: "JAVA_TOOL_OPTIONS" }] }]), [{ kind: "jvm", evidence: "env: JAVA_TOOL_OPTIONS" }]);
  assert.deepEqual(ev.runtimesOfSpec([{}], { "instrumentation.opentelemetry.io/inject-python": "true", "instrumentation.opentelemetry.io/inject-java": "false" }), [{ kind: "python", evidence: "annotation: inject-python" }]);
  assert.match(ev.RUNTIME_SCAN_QUERY, /softwareDetails/);
  assert.equal(ar.cleanVersion("go1.22.3"), "1.22.3");
  assert.equal(ar.cleanVersion("n/a"), null);
  assert.equal(wb.shortVersion("jvm", "17.0.9"), "17");
  assert.equal(wb.shortVersion("python", "3.11.4"), "3.11");
});

test("app runtimes: runtimes and columns say measured · absent · queryFailed — a failed query is not 'absent'", () => {
  const a = ar.aggregateApps(RAW, new Set(["detect:go", "col:goGoroutines"]));
  const rt = Object.fromEntries(a.runtimes.map((r) => [r.kind, r]));
  assert.deepEqual([rt.nodejs!.state, rt.nodejs!.workloads], ["measured", 1]);
  assert.deepEqual([rt.redis!.state, rt.redis!.hinted], ["absent", 1]);
  assert.equal(rt.go!.state, "queryFailed");
  const col = Object.fromEntries(a.columns.map((c) => [c.id, c]));
  assert.equal(col.nodeEventLoopLag!.state, "measured");
  assert.equal(col.nginxConnections!.state, "absent");
  assert.equal(col.goGoroutines!.state, "queryFailed");
});

test("app runtimes: queries are scoped to the cluster, one per detection metric and column; the web block list matches the API", () => {
  const q = ar.appQueries('cluster="c1"');
  for (const k of ar.RUNTIME_KINDS) assert.ok(q[`detect:${k}`]!.includes(ar.RUNTIME_DETECT[k]), k);
  for (const id of ar.APP_COLUMN_IDS) assert.ok(q[`col:${id}`]!.includes('cluster="c1"'), id);
  assert.ok(!Object.values(q).some((x) => /__name__\s*=~/.test(x)), "Azure Monitor workspaces refuse __name__ regexes");
  assert.deepEqual([...wb.APP_BLOCKS].sort(), [...ar.APP_COLUMN_IDS].sort());
  assert.deepEqual([...wb.RUNTIME_ORDER].sort(), [...ar.RUNTIME_KINDS].sort());
  for (const k of ar.RUNTIME_KINDS) assert.equal(wb.RUNTIME_GUIDE[k].detect, ar.RUNTIME_DETECT[k], `${k}: the guide names the metric the API detects by`);
  for (const id of ar.APP_COLUMN_IDS) assert.equal(wb.BLOCK_RUNTIME[`a:${id}`], ar.APP_COLUMNS[id].runtime, id);
});

test("blocks: add · remove · move · presets · the remembered set", () => {
  const basic = wb.PRESETS.basic;
  assert.equal(wb.presetOf(basic), "basic");
  const added = wb.addBlock(basic, "a:goGoroutines");
  assert.equal(added.at(-1), "a:goGoroutines");
  assert.equal(wb.presetOf(added), null, "the viewer's own set");
  assert.equal(wb.addBlock(added, "a:goGoroutines"), added, "no repeats");
  assert.equal(wb.addBlock(wb.PRESETS.all.slice(0, wb.MAX_BLOCKS), "a:openFds").length, wb.MAX_BLOCKS, "bounded");
  assert.deepEqual(wb.moveBlock(["kind", "h:ready", "h:cpu"], "h:cpu", -1), ["kind", "h:cpu", "h:ready"]);
  assert.deepEqual(wb.moveBlock(["kind", "h:ready"], "kind", -1), ["kind", "h:ready"], "the edge does not move");
  assert.deepEqual(wb.removeBlock(["kind", "h:ready"], "kind"), ["h:ready"]);
  assert.deepEqual(wb.removeBlock(["h:ready"], "h:ready"), ["h:ready"], "a table keeps one column");
  assert.deepEqual(wb.parseBlocks(JSON.stringify(["h:cpu", "nope", "h:cpu", "a:pyRss"])), ["h:cpu", "a:pyRss"]);
  assert.equal(wb.parseBlocks("{broken"), null, "unreadable = the automatic set");
  assert.equal(wb.parseBlocks(null), null);
  assert.equal(wb.parseBlocks(JSON.stringify(["nope"])), null);
  // automatic = the kind + what the table showed before blocks (every measured heatmap signal, in the heatmap's order)
  assert.deepEqual(wb.autoBlocks(["cpu", "ready", "oldGen"]), ["kind", "h:ready", "h:cpu", "h:oldGen"]);
  const rows = [{ n: "a", v: 3 }, { n: "b", v: undefined }, { n: "c", v: 9 }, { n: "d", v: undefined }];
  assert.deepEqual(wb.sortByApp(rows, (r) => r.v, "desc").map((r) => r.n), ["c", "a", "b", "d"], "no value goes last, in its order");
  assert.deepEqual(wb.sortByApp(rows, (r) => r.v, "asc").map((r) => r.n), ["a", "c", "b", "d"]);
  for (const p of wb.PRESET_IDS) assert.ok(wb.PRESETS[p].every((b) => wb.ALL_BLOCKS.includes(b)), p);
});

test("blocks: values in their unit; unidentified workloads first by hint", () => {
  assert.equal(wb.formatAppValue("ms", 12.34), "12.3ms");
  assert.equal(wb.formatAppValue("bytes", 300 * 1024 * 1024), "300Mi");
  assert.equal(wb.formatAppValue("bytes", 1.5 * 1024 ** 3), "1.5Gi");
  assert.equal(wb.formatAppValue("ratio", 0.42), "42%");
  assert.equal(wb.formatAppValue("perSec", 3.21), "3.2/s");
  assert.equal(wb.formatAppValue("count", NaN), "—");
  const a = ar.aggregateApps(RAW);
  assert.deepEqual(wb.unidentified(a.workloads).map((w) => w.workload), ["cache", "job"], "hinted first, measured (web) left out");
});

test("blocks: every runtime, block and guide step has ko / en strings; the route and the view are wired", () => {
  const ops = readFileSync(new URL("../../web/src/lib/i18nOps.ts", import.meta.url), "utf8");
  for (const k of ar.RUNTIME_KINDS) assert.ok(ops.includes(`"ob.bl.rt.${k}"`), `runtime ${k}`);
  for (const id of ar.APP_COLUMN_IDS) assert.ok(ops.includes(`"ob.bl.col.${id}"`), `col ${id}`);
  for (const p of wb.PRESET_IDS) assert.ok(ops.includes(`"ob.bl.preset.${p}"`), `preset ${p}`);
  const routes = readFileSync(new URL("../src/routes/observability.ts", import.meta.url), "utf8");
  assert.match(routes, /\/api\/observability\/app-metrics/);
  // Not a view of its own: the blocks customise the heatmap (tile text) and its table (columns) — one screen, one request each
  const page = readFileSync(new URL("../../web/src/app/observability/page.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(page, /WorkloadBlocks|"blocks"/);
  const heat = readFileSync(new URL("../../web/src/app/observability/components/WorkloadHeatmap.tsx", import.meta.url), "utf8");
  assert.match(heat, /<BlockEditor /);
  assert.match(heat, /<RuntimeGuide /);
  assert.match(heat, /blocks\.map\(\(b\) =>/, "the table's columns are the viewer's blocks");
  assert.match(heat, /chosen \?\? autoBlocks\(cols\)/, "automatic until the viewer chooses");
  // the guide lives inside the editor (not a button of its own on the bar), and changes are kept only by "저장"
  assert.match(heat, /\{editing && guide && <RuntimeGuide /);
  assert.doesNotMatch(heat, /setItem\(BLOCKS_STORAGE_KEY[^\n]+\n?[^\n]*onChange/);
  assert.match(heat, /onChange=\{setDraft\}/, "a change is a draft");
  assert.match(heat, /className=\{styles\.hmKindCol\}/, "the runtime column is centred");
  for (const k of ["ob.bl.save", "ob.bl.unsaved", "ob.bl.sets", "ob.bl.kindHint", "ob.bl.kindLong"]) assert.ok(ops.includes(`"${k}"`), k);
  for (const k of ["ob.bl.preset.auto", "ob.bl.customize", "ob.bl.guideOpen", "ob.bl.lensHint"]) assert.ok(ops.includes(`"${k}"`), k);
});

test("blocks: saved sets — named, replaced by name, bounded; unsaved = differs from what is kept", () => {
  assert.equal(wb.setName("  내   세트  "), "내 세트");
  assert.equal(wb.setName("x".repeat(80)).length, wb.SET_NAME_MAX);
  let sets = wb.saveSet([], "Go 서비스", ["kind", "a:goGoroutines"]);
  sets = wb.saveSet(sets, "데이터", ["kind", "a:redisClients"]);
  assert.deepEqual(sets.map((s) => s.name), ["Go 서비스", "데이터"]);
  sets = wb.saveSet(sets, " Go 서비스 ", ["kind", "a:goHeapInuse"]);
  assert.deepEqual(sets[0], { name: "Go 서비스", blocks: ["kind", "a:goHeapInuse"] }, "the same name is replaced in place");
  assert.equal(wb.saveSet(sets, "  ", ["kind"]), sets, "no name = not a named set");
  let full = sets;
  for (let i = 0; i < 20; i++) full = wb.saveSet(full, `s${i}`, ["kind"]);
  assert.equal(full.length, wb.MAX_SETS);
  assert.deepEqual(wb.deleteSet(sets, "데이터").map((s) => s.name), ["Go 서비스"]);
  const round = wb.parseSets(JSON.stringify([...sets, { name: "Go 서비스", blocks: ["kind"] }, { name: "bad", blocks: ["nope"] }, { blocks: ["kind"] }, 7]));
  assert.deepEqual(round, sets, "repeated names, unknown blocks and nameless entries are dropped");
  assert.deepEqual(wb.parseSets("{broken"), []);
  assert.ok(wb.sameBlocks(null, null));
  assert.ok(wb.sameBlocks(["kind", "h:cpu"], ["kind", "h:cpu"]));
  assert.ok(!wb.sameBlocks(["kind", "h:cpu"], ["h:cpu", "kind"]), "order counts");
  assert.ok(!wb.sameBlocks(null, ["kind"]), "automatic is not a chosen set");
});
