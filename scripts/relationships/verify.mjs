// Join spec-derived references with the regional scope of each type, documented corrections and (optionally) what
// a real tenant holds. See scripts/relationships/README.md.
//
// usage: node verify.mjs <spec-refs.json> <providers.json> <out catalog.json> [--tenant <tenant-refs.json>] [--public]
//   --tenant  cross-check with a tenant scan (apps/api/scripts/relationship-scan.ts): confirmed / resolved / differs /
//             tenant-only statistics are printed
//   --public  the committed catalog: no tenant data at all (no counts, no "observed" flags) — public sources only
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const [SPEC, PROV, OUT] = args;
const TENANT = args.includes("--tenant") ? args[args.indexOf("--tenant") + 1] : null;
const PUBLIC = args.includes("--public");

const spec = JSON.parse(readFileSync(SPEC, "utf8")).catalog;
const prov = JSON.parse(readFileSync(PROV, "utf8")).types;
const scopeOf = new Map(prov.map((t) => [t.type, t.scope]));
const overrides = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "overrides.json"), "utf8")).overrides;

const norm = (p) => p.replace(/^properties\./, "").replace(/\.properties(?=\.|$)/g, "").replace(/\.id$/, "").replace(/^properties$/, "").toLowerCase();
const specIndex = new Map();
for (const [type, r] of Object.entries(spec)) for (const x of r.refs) specIndex.set(`${type}|${norm(x.path)}`, x);

// Documented corrections (Learn says more than the spec metadata): extra targets with their source
for (const o of overrides) {
  const x = specIndex.get(`${o.type}|${norm(o.path)}`);
  if (!x) { console.warn("override not found in spec:", o.type, o.path); continue; }
  x.targets = [...new Set([...x.targets.filter((t) => t !== "?"), ...o.targets])];
  x.correction = { reason: o.reason, source: o.source };
}

let stats = null, tenantOnly = [];
if (TENANT) {
  const tenant = JSON.parse(readFileSync(TENANT, "utf8"));
  stats = { confirmed: 0, resolvedUnknown: 0, targetDiffers: 0, tenantOnly: 0 };
  for (const o of tenant.refs) {
    const x = specIndex.get(`${o.source}|${norm(o.path)}`);
    if (!x) { stats.tenantOnly++; tenantOnly.push({ source: o.source, path: norm(o.path), target: o.target }); continue; }
    if (x.targets.includes(o.target) || x.targets.includes("*")) { stats.confirmed++; if (!PUBLIC) x.observed = true; }
    else if (x.targets[0] === "?") { stats.resolvedUnknown++; x.targets = [o.target]; x.inferred = "tenant"; if (!PUBLIC) x.observed = true; }
    else { stats.targetDiffers++; if (!PUBLIC) { x.observed = true; x.observedTargets = [...new Set([...(x.observedTargets ?? []), o.target])]; } }
  }
}

const catalog = {};
for (const [type, r] of Object.entries(spec)) {
  catalog[type] = {
    scope: scopeOf.get(type) ?? (type.split("/").length > 2 ? "child" : "unknown"),
    spec: r.spec, apiVersion: r.apiVersion, stability: r.stability, writable: r.writable,
    refs: r.refs.map(({ observed, observedTargets, ...x }) => (PUBLIC ? x : { ...x, ...(observed ? { observed } : {}), ...(observedTargets ? { observedTargets } : {}) })),
  };
}
const scope = Object.fromEntries(prov.filter((t) => t.type.split("/").length === 2).map((t) => [t.type, t.scope]).sort());
writeFileSync(OUT, JSON.stringify({
  generated: new Date().toISOString().slice(0, 10),
  sources: ["github.com/Azure/azure-rest-api-specs (latest stable per spec group)", "ARM providers API (resource type locations)", "scripts/relationships/overrides.json (Learn corrections)"],
  legend: {
    kind: { "arm-id": "format arm-id; targets from x-ms-arm-id-details.allowedResources", "typed-ref": "$ref to another resource's body schema", subresource: "{id} reference", "id-string": "string id found by name/description" },
    inferred: { name: "target from the property name (hypothesis)", tenant: "target resolved from a real tenant" },
    readOnly: "back-reference Azure fills in; configure the other side",
    scope: { regional: "has regions", global: "only 'global'", mixed: "both", none: "no location (extension / proxy type)", child: "lives with its parent" },
  },
  types: Object.keys(catalog).length,
  references: Object.values(catalog).reduce((n, r) => n + r.refs.length, 0),
  scope,
  catalog,
}, null, PUBLIC ? 0 : 0));
console.log("types", Object.keys(catalog).length, "| scope entries", Object.keys(scope).length, stats ? `| ${JSON.stringify(stats)}` : "", PUBLIC ? "| public (no tenant data)" : "");
for (const t of tenantOnly.slice(0, 30)) console.log("   tenant-only", t.source, t.path, "→", t.target);
