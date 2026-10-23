import { test } from "node:test";
import assert from "node:assert/strict";
import * as gl from "../../web/src/app/policies/insights/graphLabels.ts";
const { curvePoint, laneBounds, placeEdgeLabels, shortLabel, textWidth } = ((gl as { default?: typeof gl }).default ?? gl) as typeof gl;

const overlap = (p: { x: number; y: number; w: number; h: number }, q: { x: number; y: number; w: number; h: number }) =>
  p.x < q.x + q.w && q.x < p.x + p.w && p.y < q.y + q.h && q.y < p.y + p.h;

test("lane bands cover the whole width between column centres — no gaps, no overlaps", () => {
  const centers = [78, 254, 430, 606, 782];
  const b = laneBounds(centers, 860);
  assert.equal(b[0]!.x0, 0);
  assert.equal(b[4]!.x1, 860);
  for (let i = 1; i < b.length; i++) assert.equal(b[i]!.x0, b[i - 1]!.x1);
  assert.equal(b[1]!.x0, 166);
});

test("labels: a list shows its first item and the rest as +n; CJK is wider", () => {
  assert.equal(shortLabel("argocd-image-updater, bind-argo-image-updater-secret-reader"), "argocd-image-updater +1");
  assert.equal(shortLabel("a-very-long-service-account-name-that-overflows", 20), "a-very-long-service…");
  assert.ok(textWidth("차단됨") > textWidth("abc"));
});

test("fan-out labels from one node never overlap each other or a node and its caption", () => {
  const src = { x: 254, y: 82 };
  const targets = [82, 178, 274, 370].map((y) => ({ x: 606, y }));
  const nodes = [src, ...targets, { x: 782, y: 178 }];
  const reqs = targets.map((t, i) => ({ key: `e${i}`, from: { x: src.x + 24, y: src.y }, to: { x: t.x - 24, y: t.y }, w: 150, h: 17 }));
  const boxes = [...placeEdgeLabels(reqs, nodes).values()];
  assert.equal(boxes.length, 4);
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) assert.ok(!overlap(boxes[i]!, boxes[j]!), `labels ${i} and ${j} overlap`);
  for (const b of boxes) for (const n of nodes) assert.ok(!overlap(b, { x: n.x - 30, y: n.y - 30, w: 60, h: 60 }), "label over a node");
});

test("a blocked edge is placed first (its state must show) and always gets a box", () => {
  const nodes = [{ x: 100, y: 100 }, { x: 300, y: 100 }];
  const reqs = [
    { key: "plain", from: { x: 124, y: 100 }, to: { x: 276, y: 100 }, w: 100, h: 17 },
    { key: "blocked", from: { x: 124, y: 100 }, to: { x: 276, y: 100 }, w: 100, h: 17, priority: 2 },
  ];
  const m = placeEdgeLabels(reqs, nodes);
  assert.ok(m.has("blocked") && m.has("plain"));
  const mid = curvePoint({ x: 124, y: 100 }, { x: 276, y: 100 }, 0.5);
  assert.ok(Math.abs(m.get("blocked")!.x + 50 - mid.x) < 1, "the blocked label got the best (midpoint) spot");
});

test("a long chip in a narrow gap goes where it covers least — not onto a node caption", () => {
  // Graph geometry: columns 176 px apart, nodes at y 82 / 178, captions under each node (~200 px wide)
  const sa = { x: 430, y: 82, captionW: 200 }, role = { x: 606, y: 178, captionW: 120 };
  const w = textWidth("⊗ argocd-application-contro…") + 12;
  const box = placeEdgeLabels([{ key: "e", from: { x: sa.x + 24, y: sa.y }, to: { x: role.x - 24, y: role.y }, w, h: 17 }], [sa, role]).get("e")!;
  const saCaption = { x: sa.x - 100, y: sa.y + 28, w: 200, h: 42 };
  const roleCircle = { x: role.x - 30, y: role.y - 30, w: 60, h: 60 };
  assert.ok(!overlap(box, roleCircle), "never on a node");
  assert.ok(!overlap(box, saCaption), JSON.stringify(box));
});
