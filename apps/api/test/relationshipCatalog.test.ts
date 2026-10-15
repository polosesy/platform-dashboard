// The relationship catalog (docs/architecture/azure-resource-relationships.md) is the source of every derived edge:
// each REL id is a catalog row, each row whose "구현" column names a file appears in that file, and the graph
// builder creates edges only through relEdge.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REL } from "../src/services/relationships.js";

const root = join(import.meta.dirname, "../../..");
const doc = readFileSync(join(root, "docs/architecture/azure-resource-relationships.md"), "utf8");
const FILES: Record<string, string> = {
  "azure.ts": "apps/api/src/services/azure.ts",
  "specGenerator.ts": "apps/api/src/services/specGenerator.ts",
  "archModel.ts": "apps/web/src/lib/archModel.ts",
};

const rows = [...doc.matchAll(/^\| ([A-Z]+-\d{2}) \|(.*)$/gm)].map((m) => ({ id: m[1]!, cells: m[2]!.split("|").map((c) => c.trim()) }));

test("every REL id in the code is a catalog row (catalog first, then code)", () => {
  const ids = new Set(rows.map((r) => r.id));
  for (const id of Object.keys(REL)) assert.ok(ids.has(id), `${id} has no row in azure-resource-relationships.md`);
  assert.equal(rows.length, ids.size, "catalog ids are unique");
});

test("a row that names an implementing file is cited in that file", () => {
  const src = new Map(Object.entries(FILES).map(([k, p]) => [k, readFileSync(join(root, p), "utf8")]));
  for (const r of rows) {
    // The implementation column is the second to last (REG rows have fewer columns: also second to last)
    const impl = r.cells[r.cells.length - 3];
    if (!impl || impl.startsWith("—")) continue;
    const file = Object.keys(FILES).find((f) => impl.includes(f));
    if (!file) continue;
    const text = src.get(file)!;
    const cited = text.includes(`"${r.id}"`) || text.includes(r.id);
    // Rows implemented in archModel / specGenerator as rules (not edges) are cited by their id in a comment
    assert.ok(cited, `${r.id} says it is implemented in ${file}, but the file never mentions it`);
  }
});

test("the graph builder makes edges only through relEdge", () => {
  const azure = readFileSync(join(root, FILES["azure.ts"]!), "utf8");
  assert.equal((azure.match(/edges\.push\(\{/g) ?? []).length, 0, "an edge literal bypasses the catalog");
  const used = [...azure.matchAll(/relEdge\("([A-Z]+-\d{2})"/g)].map((m) => m[1]!);
  for (const id of used) assert.ok(id in REL, `${id} is not in REL`);
  assert.ok(used.length >= 20);
});

// ── the code's relationships are backed by the Azure REST API specs (docs/architecture/relationships/catalog.json) ──

type Catalog = { types: number; references: number; scope: Record<string, string>; catalog: Record<string, { scope: string; refs: Array<{ path: string; kind: string; targets: string[]; readOnly: boolean; observed?: unknown }> }> };
const catalogText = readFileSync(join(root, "docs/architecture/relationships/catalog.json"), "utf8");
const cat = JSON.parse(catalogText) as Catalog;

test("the public catalog carries no tenant data and no GUIDs", () => {
  assert.ok(cat.types > 2000 && cat.references > 2000, "spec extraction is complete enough");
  assert.ok(!/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(catalogText), "no GUID");
  assert.ok(!/"observed"|"inTenant"|"observedTargets"/.test(catalogText), "no tenant observations");
});

test("every relationship the code draws names the ARM property that sets it, and the spec has that property", () => {
  for (const [id, row] of Object.entries(REL) as Array<[string, { spec?: { type: string; path: string } }]>) {
    if (!row.spec) continue;
    const t = cat.catalog[row.spec.type];
    assert.ok(t, `${id}: type ${row.spec.type} is not in the spec catalog`);
    const hit = t.refs.find((r) => r.path.toLowerCase() === row.spec!.path.toLowerCase());
    assert.ok(hit, `${id}: ${row.spec.type} has no property ${row.spec.path} in the spec`);
  }
  // Regional scope rules (REG-02): Front Door, Traffic Manager and DNS zones are non-regional
  for (const t of ["microsoft.network/trafficmanagerprofiles", "microsoft.network/dnszones", "microsoft.network/privatednszones"]) assert.equal(cat.scope[t], "global", t);
  assert.equal(cat.scope["microsoft.containerservice/managedclusters"], "regional");
});

test("domain pages (docs/architecture/relationships/*.md): ids unique with their prefix, every ARM path in the spec, every row sourced", async () => {
  const { execFileSync } = await import("node:child_process");
  const out = execFileSync(process.execPath, [join(root, "scripts/relationships/check-pages.mjs"), "--strict"], { encoding: "utf8" });
  assert.match(out, /not in spec, non-docs rows: 0\)/, out);
  const rowsN = Number(/rows (\d+)/.exec(out)?.[1] ?? 0);
  assert.ok(rowsN >= 200, `the six domain pages hold ${rowsN} relationship rows`);
});
