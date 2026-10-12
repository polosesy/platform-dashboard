import { test } from "node:test";
import assert from "node:assert/strict";
// Pure layout shared with the web app (no DOM, no React)
// The web package is CommonJS-typed, so take the module namespace instead of named ESM exports
import * as nestModule from "../../web/src/lib/nestLayout.ts";
import type { NestNode } from "../../web/src/lib/nestLayout.ts";

const mod = ((nestModule as unknown as { default?: typeof nestModule }).default ?? nestModule) as typeof nestModule;
const { layoutNest, parentsOf, visibleAncestor, NEST } = mod;

const leaf = (id: string): NestNode => ({ id, kind: "leaf" });
const tree: NestNode = {
  id: "root", kind: "group", dir: "col", gap: 28, children: [
    { id: "internet", kind: "box", maxW: 600, children: [leaf("ip1"), leaf("ip2")] },
    { id: "azure", kind: "box", dir: "col", children: [
      { id: "rg", kind: "box", maxW: 1600, children: [
        { id: "cluster", kind: "box", maxW: 860, labelW: 220, children: [
          { id: "ns:a", kind: "box", maxW: 450, children: [leaf("a1"), leaf("a2"), leaf("a3"), leaf("a4")] },
          { id: "ns:b", kind: "box", maxW: 450, children: [leaf("b1")] },
        ] },
        { id: "paas", kind: "group", dir: "col", children: [leaf("pg"), leaf("redis")] },
      ] },
    ] },
  ],
};

const inside = (c: { x: number; y: number; w: number; h: number }, p: { x: number; y: number; w: number; h: number }) =>
  c.x >= p.x && c.y >= p.y && c.x + c.w <= p.x + p.w && c.y + c.h <= p.y + p.h;
const overlap = (a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

test("layoutNest is deterministic", () => {
  const a = layoutNest(tree, new Set());
  const b = layoutNest(tree, new Set());
  assert.deepEqual([...a.entries()], [...b.entries()]);
});

test("children stay inside their parent; siblings never overlap", () => {
  const r = layoutNest(tree, new Set());
  const parents = parentsOf(tree);
  for (const [id, rect] of r) {
    const p = parents.get(id);
    if (p) assert.ok(inside(rect, r.get(p)!), `${id} inside ${p}`);
  }
  const bySibling = new Map<string, string[]>();
  for (const [id, p] of parents) bySibling.set(p, [...(bySibling.get(p) ?? []), id]);
  for (const kids of bySibling.values()) {
    for (let i = 0; i < kids.length; i++) for (let j = i + 1; j < kids.length; j++) {
      assert.ok(!overlap(r.get(kids[i]!)!, r.get(kids[j]!)!), `${kids[i]} vs ${kids[j]}`);
    }
  }
});

test("shelf packing wraps at maxW; collapsed boxes become pills and hide children", () => {
  const r = layoutNest(tree, new Set());
  // 4 leaves of 136 + gaps exceed 450 → 3 on the first row, 1 on the next
  assert.equal(r.get("a1")!.y, r.get("a3")!.y);
  assert.ok(r.get("a4")!.y > r.get("a1")!.y);
  const c = layoutNest(tree, new Set(["ns:a"]));
  assert.equal(c.get("ns:a")!.w, NEST.PILL_W);
  assert.equal(c.get("ns:a")!.collapsed, true);
  assert.equal(c.get("a1"), undefined);
});

test("visibleAncestor rolls a hidden leaf up to its outermost collapsed box", () => {
  const p = parentsOf(tree);
  assert.equal(visibleAncestor("a1", p, new Set()), "a1");
  assert.equal(visibleAncestor("a1", p, new Set(["ns:a"])), "ns:a");
  assert.equal(visibleAncestor("a1", p, new Set(["ns:a", "cluster"])), "cluster");
});
