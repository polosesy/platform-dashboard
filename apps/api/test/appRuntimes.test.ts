// AKS 모니터링 › 클러스터 · 워크로드 › 조립식 표: what kind of application a workload is (metrics = fact, image = hint),
// the representative metrics of runtimes other than Java, and the block (column) set the viewer snaps together.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as ar from "../src/services/appRuntimes.js";
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
  assert.deepEqual(by.cache!.kinds, [{ kind: "redis", basis: "image" }], "redis by image name: a hint until redis_up is scraped");
  assert.deepEqual(by.job!.kinds, [], "no metrics, unknown image = no kind (not guessed)");
  assert.equal(by.web!.values.nodeEventLoopLag, 40, "the worst pod");
  assert.equal(by.cache!.values.redisClients, undefined, "no series = no value (never 0)");
  assert.equal(ar.runtimeOfImage("registry.example/team/my-nginx-proxy-app:1"), null, "only the image's own name counts");
  assert.equal(ar.runtimeOfImage("mirror.example/bitnami/postgresql:16"), "postgres");
  assert.equal(ar.runtimeOfImage("nginx"), "nginx");
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
  assert.match(heat, /stored \?\? autoBlocks\(cols\)/, "automatic until the viewer chooses");
  for (const k of ["ob.bl.preset.auto", "ob.bl.customize", "ob.bl.guideOpen", "ob.bl.lensHint"]) assert.ok(ops.includes(`"${k}"`), k);
});
