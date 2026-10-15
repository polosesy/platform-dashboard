// Reverse-engineer resource relationships from Azure REST API specs (OpenAPI 2.0). See README.md.
// usage: node extract.mjs <repo root> <latest-files.txt> <out.json>
//   latest-files.txt = the newest STABLE version of every spec file (a version folder holds only the files that
//   changed in that version), newest first — the first definition of a resource type wins.
// For every ARM resource type (from PUT paths) walk its schema and record each property that references another
// resource:
//   arm-id     string with format "arm-id"; targets = x-ms-arm-id-details.allowedResources[].type (or "*")
//   typed-ref  $ref to a definition that is itself a resource body (e.g. Subnet, PublicIPAddress) → that type
//   subresource $ref to a SubResource-like { id } definition → target unknown ("?")
//   id-string  string property named *Id / *ResourceId / id under a reference-like name, no format → "?"
// readOnly marks back-references Azure fills in (e.g. subnet.ipConfigurations) vs references you configure.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, resolve, join } from "node:path";

const [, , ROOT, LATEST, OUT] = process.argv;
const specFiles = readFileSync(LATEST, "utf8").split(/\r?\n/).filter(Boolean);

const fileCache = new Map();
function load(file) {
  if (!fileCache.has(file)) {
    try { fileCache.set(file, JSON.parse(readFileSync(file, "utf8"))); } catch { fileCache.set(file, null); }
  }
  return fileCache.get(file);
}
/** Resolve a $ref relative to `file` → { file, name, schema } */
function deref(ref, file) {
  const [p, frag] = ref.split("#");
  const f = p ? resolve(dirname(file), p) : file;
  const doc = load(f);
  if (!doc || !frag) return null;
  const parts = frag.split("/").filter(Boolean);
  let cur = doc;
  for (const x of parts) cur = cur?.[x.replace(/~1/g, "/").replace(/~0/g, "~")];
  if (!cur) return null;
  return { file: f, name: parts.at(-1), schema: cur };
}

// ── pass 1: resource types and the definition that is each one's body ──
const resources = new Map(); // type → { spec, apiVersion, defKey, file }
const defToType = new Map(); // "file#name" → type
const typeFromPath = (path) => {
  const m = /\/providers\/([^/]+)\/(.+)$/i.exec(path);
  if (!m) return null;
  const segs = m[2].split("/");
  const out = [m[1]];
  for (let i = 0; i < segs.length; i += 2) {
    if (!segs[i] || segs[i].startsWith("{")) return null;
    out.push(segs[i]);
    if (!segs[i + 1] || !segs[i + 1].startsWith("{")) { if (i + 1 < segs.length) return null; }
  }
  return out.join("/").toLowerCase();
};
for (const rel of specFiles) {
  // Stable files first (newest first), then preview-only files (services with no stable version yet)
  const m = /^(.*)\/(stable|preview)\/([^/]+)\/[^/]+\.json$/.exec(rel);
  if (!m) continue;
  const g = `${m[1]}/${m[2]}/${m[3]}`, ver = m[3], stability = m[2];
  {
    const file = join(ROOT, rel);
    const doc = load(file);
    if (!doc?.paths) continue;
    for (const [path, ops] of Object.entries(doc.paths)) {
      if (!/\{[^}]+\}$/.test(path)) continue; // collection paths
      const type = typeFromPath(path);
      if (!type || !type.includes("/")) continue;
      const op = ops.put ?? ops.get;
      if (!op) continue;
      let schemaRef = null;
      if (ops.put) schemaRef = (op.parameters ?? []).map((p) => (p.$ref ? deref(p.$ref, file)?.schema : p)).find((p) => p?.in === "body")?.schema?.$ref;
      if (!schemaRef) schemaRef = op.responses?.["200"]?.schema?.$ref ?? op.responses?.["201"]?.schema?.$ref;
      if (!schemaRef) continue;
      const d = deref(schemaRef, file);
      if (!d) continue;
      const key = `${d.file}#${d.name}`;
      if (!resources.has(type)) resources.set(type, { spec: g.replace(/^specification\//, ""), apiVersion: ver, stability, defKey: key, writable: !!ops.put });
      if (!defToType.has(key)) defToType.set(key, type);
    }
  }
}

// Untyped references (SubResource {id}, *Id strings): the target the property name stands for (Network / Compute
// spec conventions). Marked inferred:"name" and checked against what the tenant actually holds (verify.mjs).
const BY_NAME = {
  subnet: "microsoft.network/virtualnetworks/subnets", subnets: "microsoft.network/virtualnetworks/subnets",
  virtualnetwork: "microsoft.network/virtualnetworks", remotevirtualnetwork: "microsoft.network/virtualnetworks",
  publicipaddress: "microsoft.network/publicipaddresses", publicipaddresses: "microsoft.network/publicipaddresses", publicips: "microsoft.network/publicipaddresses",
  publicipprefix: "microsoft.network/publicipprefixes", publicipprefixes: "microsoft.network/publicipprefixes",
  networksecuritygroup: "microsoft.network/networksecuritygroups", routetable: "microsoft.network/routetables",
  natgateway: "microsoft.network/natgateways", ddosprotectionplan: "microsoft.network/ddosprotectionplans",
  networkinterface: "microsoft.network/networkinterfaces", networkinterfaces: "microsoft.network/networkinterfaces",
  privateendpoint: "microsoft.network/privateendpoints", privatelinkservice: "microsoft.network/privatelinkservices",
  applicationsecuritygroups: "microsoft.network/applicationsecuritygroups", firewallpolicy: "microsoft.network/firewallpolicies",
  virtualhub: "microsoft.network/virtualhubs", virtualwan: "microsoft.network/virtualwans", vpngateway: "microsoft.network/vpngateways",
  virtualnetworkgateway1: "microsoft.network/virtualnetworkgateways", virtualnetworkgateway2: "microsoft.network/virtualnetworkgateways",
  localnetworkgateway2: "microsoft.network/localnetworkgateways", expressroutecircuit: "microsoft.network/expressroutecircuits",
  webapplicationfirewallpolicy: "microsoft.network/applicationgatewaywebapplicationfirewallpolicies",
  firewallpolicyid: "microsoft.network/firewallpolicies", gatewayloadbalancer: "microsoft.network/loadbalancers/frontendipconfigurations",
  loadbalancerbackendaddresspools: "microsoft.network/loadbalancers/backendaddresspools",
  applicationgatewaybackendaddresspools: "microsoft.network/applicationgateways/backendaddresspools",
  loadbalancerinboundnatrules: "microsoft.network/loadbalancers/inboundnatrules", loadbalancerinboundnatpools: "microsoft.network/loadbalancers/inboundnatpools",
  backendaddresspool: "(this)/backendaddresspools", backendaddresspools: "(this)/backendaddresspools",
  frontendipconfiguration: "(this)/frontendipconfigurations", backendhttpsettings: "(this)/backendhttpsettingscollection", httplistener: "(this)/httplisteners",
  probe: "(this)/probes", urlpathmap: "(this)/urlpathmaps", sslcertificate: "(this)/sslcertificates", frontendport: "(this)/frontendports",
  rewriteruleset: "(this)/rewriterulesets", redirectconfiguration: "(this)/redirectconfigurations",
  keyvault: "microsoft.keyvault/vaults", workspaceid: "microsoft.operationalinsights/workspaces", workspaceresourceid: "microsoft.operationalinsights/workspaces",
  storageaccountid: "microsoft.storage/storageaccounts", storageid: "microsoft.storage/storageaccounts", serverfarmid: "microsoft.web/serverfarms",
  virtualnetworksubnetid: "microsoft.network/virtualnetworks/subnets", userassignedidentityresourceid: "microsoft.managedidentity/userassignedidentities",
  diskencryptionset: "microsoft.compute/diskencryptionsets", availabilityset: "microsoft.compute/availabilitysets", proximityplacementgroup: "microsoft.compute/proximityplacementgroups",
  virtualmachinescaleset: "microsoft.compute/virtualmachinescalesets", hostgroup: "microsoft.compute/hostgroups", host: "microsoft.compute/hostgroups/hosts",
  capacityreservationgroup: "microsoft.compute/capacityreservationgroups",
  manageddisk: "microsoft.compute/disks", networkinterfaces: "microsoft.network/networkinterfaces",
  imagereference: "microsoft.compute/galleries/images/versions", virtualmachine: "microsoft.compute/virtualmachines",
  diskencryptionsetid: "microsoft.compute/diskencryptionsets", sourceresourceid: "*",
};
const lastName = (path) => (path.split(".").at(-1) ?? "").split("[").join("").split("]").join("").split("{").join("").split("}").join("").toLowerCase();
function inferTarget(type, path) {
  const n = lastName(path);
  const t = BY_NAME[n] ?? BY_NAME[n.replace(/id$/, "")];
  if (!t) return null;
  if (t.startsWith("(this)/")) return `${type.split("/").slice(0, 2).join("/")}/${t.slice(7)}`;
  return t;
}


// ── pass 2: walk each resource body ──
const SUBRES = /^(SubResource|.*SubResource|ResourceReference|ResourceId|IdReference|.*Reference)$/i;
const REFLIKE = /(id|ids|resourceid|resourceuri)$/i;
function walk(schema, file, path, out, seen, depth, readOnlyCtx, self = "", inAllOf = false) {
  if (!schema || depth > 60) return;
  if (schema.$ref) {
    const d = deref(schema.$ref, file);
    if (!d) return;
    const key = `${d.file}#${d.name}`;
    const t = defToType.get(key);
    // A child type of this resource (NIC → ipConfigurations, AGW → frontendIPConfigurations) is part of it: walk in
    const child = t && self && t.startsWith(`${self}/`);
    if (t && path && !child) { out.push({ path, kind: "typed-ref", targets: [t], readOnly: readOnlyCtx || !!schema.readOnly }); return; }
    // Compute-style references inherit SubResource: NetworkInterfaceReference, ManagedDiskParameters, ImageReference …
    const inheritsSub = (d.schema?.allOf ?? []).some((a) => typeof a.$ref === "string" && /#\/definitions\/SubResource$/.test(a.$ref));
    if (!inAllOf && !child && inheritsSub && /(Reference|ManagedDiskParameters|DiskEncryptionSetParameters|SubResourceWithColocationStatus)$/.test(d.name) && path) {
      out.push({ path, kind: "subresource", targets: ["?"], readOnly: readOnlyCtx || !!schema.readOnly });
      return;
    }
    // A foreign child object (NIC ipconfig → ApplicationGatewayBackendAddressPool): a reference when the property
    // name names another resource's child — typed by BY_NAME, never the source's own children ("(this)/…")
    const pname = lastName(path);
    if (!inAllOf && !child && inheritsSub && path && BY_NAME[pname] && !BY_NAME[pname].startsWith("(this)/")) {
      out.push({ path, kind: "subresource", targets: ["?"], readOnly: readOnlyCtx || !!schema.readOnly });
      return;
    }
    // Inheriting from SubResource (allOf parent) is not a reference to another resource
    if (!inAllOf && !child && SUBRES.test(d.name) && d.schema?.properties?.id && Object.keys(d.schema.properties).length <= 3 && path) {
      out.push({ path, kind: "subresource", targets: ["?"], readOnly: readOnlyCtx || !!schema.readOnly });
      return;
    }
    // A definition that is nothing but { id: string } is a reference whatever its name (AGC association
    // `subnet` → AssociationSubnet, WAF `policy` → WafPolicy)
    const props = d.schema?.properties;
    // (only a bare string id — an arm-id formatted one is walked into and recorded with its allowed targets)
    if (!inAllOf && !child && !t && path && props && Object.keys(props).length === 1 && props.id?.type === "string" && !props.id.format && !props.id["x-ms-arm-id-details"] && !d.schema?.allOf) {
      out.push({ path, kind: "subresource", targets: ["?"], readOnly: readOnlyCtx || !!schema.readOnly });
      return;
    }
    if (seen.has(key)) return;
    const next = new Set(seen); next.add(key);
    return walk(d.schema, d.file, path, out, next, depth + 1, readOnlyCtx || !!schema.readOnly, self, inAllOf);
  }
  const ro = readOnlyCtx || !!schema.readOnly;
  for (const part of schema.allOf ?? []) walk(part, file, path, out, seen, depth + 1, ro, self, true);
  if (schema.type === "array" || schema.items) return walk(schema.items, file, `${path}[]`, out, seen, depth + 1, ro, self);
  if (schema.type === "string" || (!schema.properties && !schema.allOf && !schema.$ref && schema.format === "arm-id")) {
    const name = path.split(".").at(-1)?.replace(/\[\]$/, "") ?? "";
    if (schema.format === "arm-id") {
      const allowed = (schema["x-ms-arm-id-details"]?.allowedResources ?? []).map((a) => String(a.type).toLowerCase());
      out.push({ path, kind: "arm-id", targets: allowed.length ? allowed : ["*"], readOnly: ro });
    } else if (REFLIKE.test(name) && name.toLowerCase() !== "id") {
      const desc = String(schema.description ?? "").toLowerCase();
      // Names that are usually GUIDs (tenantId, principalId, a workspace's customer id …) count only when the
      // description says ARM resource id (diagnosticSettings.workspaceId is "the full ARM resource ID")
      const guidish = /tenantid|subscriptionid|principalid|clientid|objectid|applicationid|appid|correlationid|requestid|operationid|uniqueid|vmid|workspaceid$|customerid|keyid|secretid|userid|groupid|sessionid|jobid|runid|deviceid/i.test(name);
      const armSaid = /arm resource id|full arm|resource id of|full resource id|azure resource manager id|arm id/.test(desc);
      if (guidish ? armSaid : /resource id|arm id|resource identifier|azure resource|arm resource|resource uri|the id of (the|an?) |full id/.test(desc)) out.push({ path, kind: "id-string", targets: ["?"], readOnly: ro });
    }
    return;
  }
  for (const [k, v] of Object.entries(schema.properties ?? {})) {
    if (path === "" && ["id", "name", "type", "location", "tags", "etag", "systemData", "identity", "sku", "kind", "zones", "extendedLocation", "managedBy", "plan"].includes(k)) {
      if (k === "managedBy") out.push({ path: "managedBy", kind: "id-string", targets: ["?"], readOnly: true });
      continue;
    }
    walk(v, file, path ? `${path}.${k}` : k, out, seen, depth + 1, ro, self);
  }
  if (schema.additionalProperties && typeof schema.additionalProperties === "object") walk(schema.additionalProperties, file, `${path}{}`, out, seen, depth + 1, ro, self);
}


const catalog = {};
let refs = 0;
for (const [type, r] of [...resources].sort()) {
  const [file, name] = r.defKey.split("#");
  const out = [];
  walk(load(file)?.definitions?.[name], file, "", out, new Set([r.defKey]), 0, false, type);
  // flatten "properties." prefix, dedupe
  const seen = new Set();
  const list = [];
  for (const x of out) {
    const p = x.path.replace(/(^|\.)properties\./g, "$1").replace(/^properties$/, "");
    const k = `${p}|${x.kind}|${x.targets.join(",")}`;
    if (!p || seen.has(k)) continue;
    seen.add(k);
    const guess = x.targets[0] === "?" ? inferTarget(type, p) : null;
    list.push({ ...x, path: p, ...(guess ? { targets: [guess], inferred: "name" } : {}) });
  }
  refs += list.length;
  catalog[type] = { spec: r.spec, apiVersion: r.apiVersion, stability: r.stability, writable: r.writable, refs: list };
}
writeFileSync(OUT, JSON.stringify({ types: Object.keys(catalog).length, refs, catalog }));
console.log("resource types:", Object.keys(catalog).length, "reference properties:", refs);
