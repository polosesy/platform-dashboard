import { test } from "node:test";
import assert from "node:assert/strict";
import type { NetMapData, NetMapEdge } from "@aud/types";
import * as ns from "../../web/src/lib/vnetFlowMap.ts";

const m = ((ns as unknown as { default?: typeof ns }).default ?? ns) as typeof ns;

// Synthetic (fake names): Internet → web → app → data, app ↔ cache cycle, app → Azure services, on-prem → app, web's own traffic
const e = (src: string, dst: string, bytes: number, denied = 0, malicious = 0): NetMapEdge => ({
  src, dst, bytes, allowedFlows: 10, deniedFlows: denied, records: 5, maliciousRecords: malicious, last: "2026-10-29T03:00:00Z",
  ports: [{ port: 443, proto: "TCP", bytes, allowedFlows: 10, deniedFlows: denied }], deniedPorts: denied ? [22] : [],
});
const data: NetMapData = {
  edges: [
    e("@internet", "rg/hub/web", 5e9, 40, 2), e("rg/hub/web", "rg/hub/app", 3e9), e("rg/hub/app", "rg/hub/data", 2e9),
    e("rg/hub/app", "rg/hub/cache", 1e8), e("rg/hub/cache", "rg/hub/app", 1e8), e("rg/hub/app", "@azure", 6e8), e("@onprem", "rg/hub/app", 4e7),
    e("rg/hub/web", "rg/hub/web", 7e9), e("rg/hub/app", "@internet", 1e6),
  ],
  omitted: 0, unplaced: { bytes: 1e9, records: 300 },
};

test("traffic map: classes in on the left, subnets by path step, classes out on the right; a subnet's own traffic is a value", () => {
  const map = m.buildVnetMap(data);
  const at = (id: string) => map.cards.find((c) => c.id === id)!;
  assert.deepEqual(map.cards.filter((c) => c.kind === "externalIn").map((c) => c.id).sort(), ["@internet#in", "@onprem#in"]);
  assert.deepEqual(map.cards.filter((c) => c.kind === "externalOut").map((c) => c.id).sort(), ["@azure#out", "@internet#out"]);
  assert.ok(at("@internet#in").x < at("rg/hub/web").x && at("rg/hub/web").x < at("rg/hub/app").x && at("rg/hub/app").x < at("rg/hub/data").x, "left → right = the way traffic goes");
  assert.ok(at("rg/hub/data").x < at("@azure#out").x);
  assert.equal(at("rg/hub/app").rank, at("rg/hub/cache").rank, "a cycle shares one step");
  assert.equal(map.links.some((l) => l.source === l.target), false, "no loop lines");
  assert.equal(at("rg/hub/web").bytesWithin, 7e9);
  assert.equal(at("rg/hub/web").status, "danger", "denied / malicious flows on its lines");
  assert.equal(at("rg/hub/data").status, "ok");
  assert.deepEqual(map.boxes.map((b) => b.kind).sort(), ["laneIn", "laneOut", "vnet"]);
  assert.equal(map.boxes.find((b) => b.kind === "vnet")!.title, "hub");
  assert.deepEqual([map.totals.subnets, map.totals.vnets, map.totals.deniedLinks, map.totals.maliciousLinks], [4, 1, 1, 1]);
  // Deterministic: same data → same picture
  assert.equal(JSON.stringify(m.buildVnetMap(data)), JSON.stringify(map));
});

test("traffic map filters: denied keeps the denied lines and their cards; search keeps matching subnets and their classes", () => {
  const denied = m.buildVnetMap(data, { denied: true });
  assert.deepEqual(denied.links.map((l) => l.id), ["@internet>rg/hub/web"]);
  assert.deepEqual(denied.cards.map((c) => c.id).sort(), ["@internet#in", "rg/hub/web"]);
  const found = m.buildVnetMap(data, { search: "data" });
  assert.deepEqual(found.cards.map((c) => c.id), ["rg/hub/data"], "a peer subnet is not dragged in by search");
  const app = m.buildVnetMap(data, { search: "app" });
  assert.deepEqual(app.cards.map((c) => c.id).sort(), ["@azure#out", "@internet#out", "@onprem#in", "rg/hub/app"]);
});

test("panel lines most bytes first; bytes for people", () => {
  const map = m.buildVnetMap(data);
  const { inbound, outbound } = m.vLinksOf(map, "rg/hub/app");
  assert.deepEqual(inbound.map((l) => l.source), ["rg/hub/web", "rg/hub/cache", "@onprem#in"]);
  assert.deepEqual(outbound.map((l) => l.target), ["rg/hub/data", "@azure#out", "rg/hub/cache", "@internet#out"]);
  assert.equal(m.formatBytes(512), "512 B");
  assert.equal(m.formatBytes(1536), "1.5 KB");
  assert.equal(m.formatBytes(64 * 1024 ** 3), "64 GB");
});
