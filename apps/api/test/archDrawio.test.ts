import { test } from "node:test";
import assert from "node:assert/strict";
import type { ArchitectureGraph, ArchitectureNode } from "@aud/types";
// Pure web modules (no React) — the web package is CommonJS-typed, so read the namespace
import * as modelNs from "../../web/src/lib/archModel.ts";
import * as drawioNs from "../../web/src/lib/archDrawio.ts";

const m = ((modelNs as unknown as { default?: typeof modelNs }).default ?? modelNs) as typeof modelNs;
const d = ((drawioNs as unknown as { default?: typeof drawioNs }).default ?? drawioNs) as typeof drawioNs;

const SUBID = "12345678-aaaa-bbbb-cccc-1234567890ab";
const SUB = `/subscriptions/${SUBID}`;
const rid = (type: string, name: string) => `${SUB}/resourceGroups/rg-${SUBID}/providers/${type}/${name}`.toLowerCase();
const VNET = rid("microsoft.network/virtualnetworks", "vnet-a");
const SUBNET = `${VNET}/subnets/s1`;
const NIC = rid("microsoft.network/networkinterfaces", "nic1");
const VM = rid("microsoft.compute/virtualmachines", `a&b<c>"d'`);
const LA = rid("microsoft.operationalinsights/workspaces", `DefaultWorkspace-${SUBID}-EUS`);
const LB = rid("microsoft.network/loadbalancers", "lb1");
const PIP = rid("microsoft.network/publicipaddresses", "pip1");
const KV = rid("microsoft.keyvault/vaults", "kv1");

function graph(): ArchitectureGraph {
  const n = (id: string, kind: ArchitectureNode["kind"], name: string, extra: Partial<ArchitectureNode> = {}): ArchitectureNode => ({ id, kind, name, location: "koreacentral", azureId: id, ...extra });
  return {
    generatedAt: "2026-01-01T00:00:00Z",
    nodes: [
      n(VNET, "vnet", "vnet-a", { endpoint: "10.0.0.0/16" }),
      n(SUBNET, "subnet", "s1", { endpoint: "10.0.1.0/24" }),
      n(NIC, "nic", "nic1", { endpoint: "10.0.1.4" }),
      n(VM, "vm", `a&b<c>"d'\u0001`),
      n(LA, "logAnalytics", `DefaultWorkspace-${SUBID}-EUS`),
      n(LB, "lb", "lb1", { endpoint: "20.0.0.9" }),
      n(PIP, "publicIP", "pip1", { endpoint: "20.0.0.9", metadata: { attachedTo: LB } }),
      n(KV, "keyVault", "kv1"),
    ],
    edges: [
      { id: "e1", source: SUBNET, target: NIC, kind: "attached-to" },
      { id: "e2", source: NIC, target: VM, kind: "bound-to" },
      { id: "e3", source: LB, target: NIC, kind: "routes" },
    ],
  };
}

const model = m.buildArchModel(graph());
const layout = m.layoutArch(model, { region: "koreacentral", collapsed: new Set(), expandedStacks: new Set() });
const label = (s: modelNs.ArchPlaced) => {
  if (s.shape === "box") return s.type === "vnet" || s.type === "subnet" ? model.nodes.get(s.id)?.name ?? s.label : s.label;
  if (s.shape === "tile") return `${model.resources.get(s.ref)?.node.name}\n${model.resources.get(s.ref)?.privateIps[0] ?? ""}`;
  return s.id;
};
const xml = d.toDrawio(layout, { label, title: `infra ${SUBID}`, caption: ["인프라 구성도 · koreacentral", "구성 기준"] });

/** Minimal well-formedness check: balanced tags, quoted attributes, no raw & or < in text */
function wellFormed(s: string): string | null {
  const body = s.replace(/^<\?xml[^?]*\?>\s*/, "");
  const stack: string[] = [];
  let i = 0;
  for (const m2 of body.matchAll(/<(\/?)([A-Za-z][\w:-]*)((?:\s+[\w:-]+="[^"<]*")*)\s*(\/?)>|([^<]+)/g)) {
    if (m2.index !== i) return `unparsed at ${i}: ${body.slice(i, i + 40)}`;
    i += m2[0].length;
    if (m2[5] !== undefined) {
      if (/&(?!(amp|lt|gt|quot|apos|#\d+);)/.test(m2[5])) return `raw & in text`;
      continue;
    }
    for (const a of (m2[3] ?? "").matchAll(/="([^"]*)"/g)) if (/&(?!(amp|lt|gt|quot|apos|#\d+);)/.test(a[1]!)) return `raw & in attribute ${a[1]}`;
    if (m2[1]) { if (stack.pop() !== m2[2]) return `mismatched </${m2[2]}>`; }
    else if (!m2[4]) stack.push(m2[2]!);
  }
  if (i !== body.length) return "trailing content";
  return stack.length ? `unclosed ${stack.join(",")}` : null;
}

test("drawio: well-formed XML with one cell per shape and edge", () => {
  assert.equal(wellFormed(xml), null);
  const vertices = [...xml.matchAll(/<mxCell id="(c\d+)"[^>]*vertex="1"/g)].map((x) => x[1]);
  assert.equal(vertices.length, layout.shapes.length);
  const edges = [...xml.matchAll(/<mxCell id="e\d+"[^>]*edge="1"[^>]*source="(c\d+)" target="(c\d+)"/g)];
  assert.equal(edges.length, layout.edges.length);
  const ids = [...xml.matchAll(/<mxCell id="([^"]+)"/g)].map((x) => x[1]);
  assert.equal(new Set(ids).size, ids.length, "ids are unique");
  for (const e of edges) assert.ok(vertices.includes(e[1]!) && vertices.includes(e[2]!));
  assert.ok(edges.every((e) => /<mxGeometry relative="1" as="geometry"\/>/.test(xml.slice(e.index!, xml.indexOf("</mxCell>", e.index!)))));
});

test("drawio: parents come first and children sit inside their parent", () => {
  const cells = [...xml.matchAll(/<mxCell id="(c\d+)"[^>]*parent="([^"]+)"[^>]*><mxGeometry x="(-?[\d.]+)" y="(-?[\d.]+)" width="([\d.]+)" height="([\d.]+)"/g)].map((x) => ({ id: x[1]!, parent: x[2]!, x: +x[3]!, y: +x[4]!, w: +x[5]!, h: +x[6]! }));
  const seen = new Map<string, (typeof cells)[number]>();
  for (const c of cells) {
    if (c.parent !== "1") {
      const p = seen.get(c.parent);
      assert.ok(p, `${c.id} parent ${c.parent} declared before it`);
      assert.ok(c.x >= 0 && c.y >= 0 && c.x + c.w <= p!.w && c.y + c.h <= p!.h, `${c.id} inside ${c.parent}`);
    }
    seen.set(c.id, c);
  }
});

test("drawio: no subscription IDs, ARM IDs or markup; names escaped and control characters removed", () => {
  assert.ok(!xml.includes("/subscriptions/"));
  assert.ok(!/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(xml), "GUIDs masked");
  assert.ok(xml.includes("DefaultWorkspace-…90ab-EUS"));
  assert.ok(xml.includes("a&amp;b&lt;c&gt;&quot;d&apos;"));
  assert.ok(!xml.includes("\u0001"));
  for (const st of xml.matchAll(/style="([^"]*)" vertex="1"/g)) if (!st[1]!.startsWith("text;")) assert.match(st[1]!, /html=0/);
  for (const st of xml.matchAll(/style="([^"]*)" edge="1"/g)) {
    assert.match(st[1]!, /strokeColor=#[0-9a-f]{6};/, "opaque hex colours only (draw.io ignores rgba)");
    assert.doesNotMatch(st[1]!, /rgba|var\(/);
  }
});

test("drawio: deterministic, collapsed VNet is a single cell, context tiles are dashed", () => {
  assert.equal(d.toDrawio(layout, { label, title: "t", caption: ["x"] }), d.toDrawio(layout, { label, title: "t", caption: ["x"] }));
  const closed = m.layoutArch(model, { region: "koreacentral", collapsed: new Set([VNET]), expandedStacks: new Set() });
  const x2 = d.toDrawio(closed, { label, title: "t", caption: ["x"] });
  assert.equal((x2.match(/vertex="1"/g) ?? []).length - 1, closed.shapes.length);
  assert.ok(!closed.shapes.some((s) => s.id === SUBNET));
  const v = m.filterArchModel(model, new Set<modelNs.ArchCategory>(["network"]));
  const fl = m.layoutArch(v.model, { region: "koreacentral", collapsed: new Set(), expandedStacks: new Set() });
  const x3 = d.toDrawio(fl, { label, title: "t", caption: ["x"], context: v.context });
  assert.ok(v.context.has(VM), "VM behind the LB is context in a network view");
  assert.match(x3, /a&amp;b[^"]*" style="[^"]*dashed=1;opacity=55;/);
  assert.ok(!x3.includes("kv1"), "hidden resources are not in the file");
});

test("drawio: export file name has no subscription data", () => {
  const f = d.archExportFileName({ region: "Korea Central", filtered: true, sample: true, now: new Date(2026, 9, 13, 9, 5), ext: "drawio" });
  assert.equal(f, "infra-diagram_korea_central_filtered_sample_20261013-0905.drawio");
  assert.match(d.archExportFileName({ region: "all", filtered: false, sample: false, now: new Date(), ext: "png" }), /^infra-diagram_all_\d{8}-\d{4}\.png$/);
});
