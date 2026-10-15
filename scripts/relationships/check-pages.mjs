// Mechanical check of the relationship dictionary pages against the spec catalog. See README.md.
// usage: node check-pages.mjs [--strict]
//   - row ids: prefix of the page, unique across the core page and every domain page
//   - ARM paths (backticked tokens in the "ARM 속성 경로" column): found as a reference path in catalog.json
//     (any type — the page names the source type in prose), or the row's evidence column says docs / tenant
//   - sources: learn.microsoft.com (or the Azure GitHub org) URLs; no GUIDs anywhere
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const DIR = join(ROOT, "docs/architecture/relationships");
const PREFIX = { "network-core": "NET", "network-edge": "EDG", "compute-containers": "CMP", "app-integration": "APP", data: "DAT", "identity-security-monitoring": "IDM" };
const cat = JSON.parse(readFileSync(join(DIR, "catalog.json"), "utf8")).catalog;
const known = new Set();
for (const t of Object.values(cat)) for (const r of t.refs) {
  const p = r.path.toLowerCase();
  known.add(p);
  // every suffix after a dot also counts (pages often name the tail of a long path)
  const parts = p.split(".");
  for (let i = 1; i < parts.length; i++) known.add(parts.slice(i).join("."));
}
const norm = (s) => s.replace(/^properties\./i, "").replace(/\.properties(?=\.|$)/gi, "").toLowerCase();
// Type names that prose puts in front of a path ("fleets.hubProfile…", "networkInterfaces.privateLinkService")
const typeNames = new Set(Object.keys(cat).flatMap((t) => { const n = t.split("/").at(-1); return [n, n.replace(/s$/, "")]; }));
/** Path candidates for a token: as written, without a leading type name, with / without a trailing ".id" */
function candidates(token) {
  const p = norm(token);
  const out = new Set([p]);
  const head = p.split(".")[0].replace(/\[\]$/, "");
  if (typeNames.has(head)) out.add(p.slice(p.indexOf(".") + 1));
  for (const x of [...out]) { out.add(x.replace(/\.id$/, "")); out.add(x.replace(/\[\]\.id$/, "[]")); }
  return [...out];
}
const GUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

const ids = new Map();
const issues = [];
const core = readFileSync(join(ROOT, "docs/architecture/azure-resource-relationships.md"), "utf8");
for (const m of core.matchAll(/^\| ([A-Z]+-\d{2}) \|/gm)) ids.set(m[1], "core");
let rows = 0, paths = 0, pathMiss = 0;
for (const f of readdirSync(DIR).filter((x) => x.endsWith(".md")).sort()) {
  const key = f.replace(/\.md$/, "");
  const text = readFileSync(join(DIR, f), "utf8");
  if (GUID.test(text)) issues.push(`${f}: contains a GUID`);
  for (const sec of ["## 1.", "## 2.", "## 3.", "## 4.", "## 5."]) if (!text.includes(sec)) issues.push(`${f}: missing section ${sec}`);
  for (const line of text.split("\n")) {
    const m = /^\| ([A-Z]+-\d{2}) \|(.*)\|\s*$/.exec(line);
    if (!m) continue;
    rows++;
    const [id, rest] = [m[1], m[2]];
    if (!id.startsWith(`${PREFIX[key]}-`)) issues.push(`${f}: ${id} does not use the page prefix ${PREFIX[key]}-`);
    if (ids.has(id)) issues.push(`${f}: ${id} already defined in ${ids.get(id)}`);
    ids.set(id, key);
    const cells = rest.split(" | ").map((c) => c.trim());
    const pathCell = cells[2] ?? "", evidence = (cells[3] ?? "").toLowerCase(), source = cells.at(-1) ?? "";
    const docsOnly = /docs|tenant|문서/.test(evidence);
    for (const t of pathCell.matchAll(/`([A-Za-z][\w.[\]{}]*[.[][\w.[\]{}]*)`/g)) {
      if (/^microsoft\./i.test(t[1])) continue; // a type name, not a path
      paths++;
      // A container token ("privateLinkServiceConnections[]") passes when a reference path lives under it
      const under = (c) => [...known].some((k) => k.startsWith(`${c}.`) || k.startsWith(`${c}[`));
      if (!candidates(t[1]).some((c) => known.has(c) || under(c)) && !docsOnly) { pathMiss++; issues.push(`${f}: ${id} path not in the spec catalog: ${t[1]}`); }
    }
    if (!/https:\/\/(learn\.microsoft\.com|github\.com\/Azure)/.test(source) && !/참고|→/.test(rest)) issues.push(`${f}: ${id} has no learn.microsoft.com source`);
  }
}
console.log(`rows ${rows} · ids ${ids.size} · backticked paths ${paths} (not in spec, non-docs rows: ${pathMiss})`);
for (const i of issues) console.log("  -", i);
if (process.argv.includes("--strict") && issues.length) process.exit(1);
