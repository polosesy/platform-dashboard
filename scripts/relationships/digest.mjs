// Per-domain digests of the verified catalog for the expert agents (no ids, no counts — types and paths only).
// usage: node digest.mjs <catalog.json> <providers.json> <outdir>
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
const [, , CAT, PROV, OUT] = process.argv;
const { catalog, tenantOnly, stats } = JSON.parse(readFileSync(CAT, "utf8"));
const prov = JSON.parse(readFileSync(PROV, "utf8")).types;
mkdirSync(OUT, { recursive: true });

const EDGE_NET = /^microsoft\.network\/(applicationgateway|azurefirewall|firewallpolic|bastionhost|virtualnetworkgateway|localnetworkgateway|connections|expressroute|vpn|virtualwan|virtualhub|privateendpoint|privatelinkservice|privatednszone|dnszone|dnsresolver|frontdoor|trafficmanager|networkwatcher|ddos|applicationgatewaywebapplicationfirewall|natgateway|publicipprefix)/;
const DOMAINS = {
  "network-core": (t) => t.startsWith("microsoft.network/") && !EDGE_NET.test(t),
  "network-edge": (t) => EDGE_NET.test(t) || t.startsWith("microsoft.cdn/"),
  "compute-containers": (t) => /^microsoft\.(compute|containerservice|containerinstance|app|containerregistry|batch|desktopvirtualization|avs|hybridcompute|kubernetes|kubernetesconfiguration|servicefabric)\//.test(t),
  "app-integration": (t) => /^microsoft\.(web|apimanagement|servicebus|eventhub|eventgrid|logic|signalrservice|communication|notificationhubs|relay|search|cognitiveservices|machinelearningservices|botservice|appconfiguration)\//.test(t),
  "data": (t) => /^microsoft\.(sql|dbforpostgresql|dbformysql|documentdb|cache|storage|datafactory|synapse|databricks|kusto|netapp|storagecache|elasticsan|purview|streamanalytics)\//.test(t),
  "identity-security-monitoring": (t) => /^microsoft\.(keyvault|managedidentity|authorization|insights|operationalinsights|alertsmanagement|monitor|security|policyinsights|recoveryservices|dataprotection|operationsmanagement|dashboard|resourcegraph|resources|management|automation|securityinsights|maintenance)\//.test(t),
};
const index = [];
for (const [dom, match] of Object.entries(DOMAINS)) {
  const types = Object.keys(catalog).filter(match).sort();
  const lines = [`# ${dom} — ${types.length} resource types (latest stable REST spec; scope from the providers API)`, "",
    "Legend: kind = arm-id (format arm-id, allowed targets from x-ms-arm-id-details) | typed-ref ($ref to another resource body) | subresource ({id} reference) | id-string (string id by name/description).",
    "targets '(name)' = inferred from the property name; 'tenant' = target resolved from what a real tenant holds; ✓ = seen in a real tenant; ⚠ = the tenant holds other target types than the spec lists.",
    "Only configurable references are listed; read-only back-references are summarized as 'back-refs'.", ""];
  for (const t of types) {
    const r = catalog[t];
    const cfg = r.refs.filter((x) => !x.readOnly);
    const back = r.refs.filter((x) => x.readOnly).map((x) => x.path).slice(0, 8);
    if (!cfg.length && !back.length && t.split("/").length > 3) continue;
    lines.push(`## ${t}  [scope ${r.scope}${r.inTenant ? ", present in tenant" : ""}] spec ${r.spec.split("/")[0]} ${r.apiVersion}`);
    for (const x of cfg.slice(0, 45)) lines.push(`- ${x.kind} \`${x.path}\` → ${x.targets.join(", ")}${x.inferred ? ` (${x.inferred})` : ""}${x.observed ? " ✓" : ""}${x.targetDiffers ? ` ⚠ tenant: ${x.observedTargets.join(", ")}` : ""}`);
    if (cfg.length > 45) lines.push(`- … ${cfg.length - 45} more`);
    if (back.length) lines.push(`- back-refs (read-only): ${back.map((b) => `\`${b}\``).join(", ")}`);
    lines.push("");
  }
  const extra = tenantOnly.filter((o) => match(o.source));
  if (extra.length) {
    lines.push("## Observed in a real tenant but not in the latest stable spec (spec gap or older/preview property)");
    for (const o of extra) lines.push(`- ${o.source} \`${o.path}\` → ${o.target}`);
  }
  writeFileSync(`${OUT}/${dom}.md`, lines.join("\n"));
  index.push(`${dom}: ${types.length} types`);
}
// Regional scope of the main namespaces' top-level types
const scopeLines = ["# Regional scope of resource types (providers API, one subscription)", "scope: regional = has regions · global = only 'global' · mixed = both · none = no location (extension/proxy types)", ""];
for (const t of prov.filter((p) => p.type.split("/").length === 2).sort((a, b) => a.type.localeCompare(b.type))) scopeLines.push(`${t.type} ${t.scope}`);
writeFileSync(`${OUT}/scope.txt`, scopeLines.join("\n"));
writeFileSync(`${OUT}/README.txt`, [`Verification stats: ${JSON.stringify(stats)}`, ...index].join("\n"));
console.log(index.join(" | "));
