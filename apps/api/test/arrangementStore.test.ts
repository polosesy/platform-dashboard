import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ArrangementBody, clearArrangementMemory, readArrangement, writeArrangement } from "../src/services/arrangementStore.js";

const SUB = "00000000-0000-0000-0000-00000000abcd";
const body = (n: number) => ({ order: [[`c${n}`, ["a", "b"]]] as Array<[string, string[]]>, lines: [{ source: "a", target: "b", style: "elbow" as const, bend: 0.3 }] });

for (const where of ["memory", "file"] as const) {
  test(`team layout (${where}): versions, stale writes refused with the current document, force overwrites`, async () => {
    clearArrangementMemory();
    const dir = where === "file" ? mkdtempSync(path.join(tmpdir(), "aud-arr-")) : undefined;
    try {
      assert.equal(await readArrangement(dir, SUB), null);
      const a = await writeArrangement(dir, SUB, body(1), { baseVersion: null, force: false, by: "Kim" });
      assert.ok(a.ok && a.doc.version === 1 && a.doc.updatedBy === "Kim");
      const b = await writeArrangement(dir, SUB, body(2), { baseVersion: 1, force: false });
      assert.ok(b.ok && b.doc.version === 2);
      const stale = await writeArrangement(dir, SUB, body(3), { baseVersion: 1, force: false });
      assert.ok(!stale.ok && stale.conflict.version === 2, "someone published in between");
      const forced = await writeArrangement(dir, SUB, body(4), { baseVersion: 1, force: true });
      assert.ok(forced.ok && forced.doc.version === 3);
      const read = await readArrangement(dir, SUB.toUpperCase());
      assert.deepEqual(read?.order, [["c4", ["a", "b"]]]);
      if (dir) assert.deepEqual(readdirSync(dir), [`${SUB}.json`], "temp files renamed away");
      // Concurrent writers from the same version: exactly one wins
      const [x, y] = await Promise.all([
        writeArrangement(dir, SUB, body(5), { baseVersion: 3, force: false }),
        writeArrangement(dir, SUB, body(6), { baseVersion: 3, force: false }),
      ]);
      assert.equal([x, y].filter((r) => r.ok).length, 1);
    } finally {
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  });
}

test("team layout body: only order and lines, sizes and values bounded", () => {
  assert.ok(ArrangementBody.safeParse(body(1)).success);
  assert.ok(!ArrangementBody.safeParse({ ...body(1), extra: 1 }).success);
  assert.ok(!ArrangementBody.safeParse({ order: [], lines: [{ source: "a", target: "b", style: "zigzag" }] }).success);
  assert.ok(!ArrangementBody.safeParse({ order: [], lines: [{ source: "a", target: "b", style: "curve", bulge: 5 }] }).success);
  assert.ok(!ArrangementBody.safeParse({ order: Array.from({ length: 501 }, (_, i) => [`c${i}`, []]), lines: [] }).success);
});

test("team layout body: grids are optional, bounded (tile grids 1..6, a VNet's subnet columns up to 16)", () => {
  assert.ok(ArrangementBody.safeParse({ ...body(1), grid: [["s1", { cols: 2, cells: [["a", 1, 0]] }]] }).success);
  assert.ok(ArrangementBody.safeParse({ ...body(1), grid: [["vband:v", { cols: 8, cells: [["a", 7, 0]] }]] }).success);
  assert.ok(!ArrangementBody.safeParse({ ...body(1), grid: [["s1", { cols: 0 }]] }).success);
  assert.ok(!ArrangementBody.safeParse({ ...body(1), grid: [["s1", { cols: 17 }]] }).success);
  assert.ok(!ArrangementBody.safeParse({ ...body(1), grid: [["s1", { cells: [["a", 16, 0]] }]] }).success);
  assert.ok(!ArrangementBody.safeParse({ ...body(1), grid: [["s1", { cols: 2, x: 1 }]] }).success);
});

test("team layout: a document with grids is version 2 and reads back with them; without, version 1", async () => {
  clearArrangementMemory();
  const w = await writeArrangement(undefined, SUB, { ...body(1), grid: [["s1", { cols: 2 }]] }, { baseVersion: null, force: false });
  assert.ok(w.ok && w.doc.v === 2);
  const back = await readArrangement(undefined, SUB);
  assert.deepEqual(back?.grid, [["s1", { cols: 2 }]]);
  clearArrangementMemory();
  const w1 = await writeArrangement(undefined, SUB, body(2), { baseVersion: null, force: false });
  assert.ok(w1.ok && w1.doc.v === 1);
});
