// Find $ref'd spec files that are not checked out yet; print sparse-checkout patterns for them.
// usage: node closure.mjs <repo root>
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, resolve, dirname, relative } from "node:path";
const ROOT = process.argv[2];
const files = [];
const walk = (d) => { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) walk(p); else if (p.endsWith(".json")) files.push(p); } };
walk(join(ROOT, "specification"));
const missing = new Set();
for (const f of files) {
  const text = readFileSync(f, "utf8");
  for (const m of text.matchAll(/"\$ref"\s*:\s*"([^"#]+\.json)(#[^"]*)?"/g)) {
    const target = resolve(dirname(f), m[1]);
    if (!existsSync(target)) missing.add("/" + relative(ROOT, target).split("\\").join("/"));
  }
}
console.log([...missing].join("\n"));
