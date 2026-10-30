// Workload identity map (pure — no I/O): pods → ServiceAccount → federated identity credential (FIC) →
// user-assigned managed identity → Azure role assignments, plus the ServiceAccount's Kubernetes RBAC.
// Rules WI-01…16 carry the official document they rest on (quoted). Matching is byte-exact, like the token exchange
// ("must case-sensitively match"); near misses are findings, never matches. Unknown stays unknown (ev "unk", no
// colour). Subscription IDs, principal IDs and ARM IDs never leave this module: ids are opaque hashes, client and
// tenant IDs show their last 4 characters, issuers are masked.

import { createHash } from "node:crypto";
import type {
  RbacRiskKey, WiFic, WiFinding, WiIdentity, WiImds, WiK8sBinding, WiMatch, WiNodePool, WiOtherWorkload, WiRoleAssignment, WiRoleUsage,
  WiRuleId, WiScope, WiScopeLevel, WiServiceAccount, WiSeverity, WiWorkload, WorkloadIdentityResponse, EvidenceKind,
} from "@aud/types";
import type { PolicyInventory } from "./policyAnalyzer.js";
import { GRADE, isAksManaged, rbacRiskKeys, roleRules } from "./policyInsights.js";
import { maskGuids } from "../infra/requestParams.js";
import { L } from "../infra/lang.js";

export const WI_ANN = {
  clientId: "azure.workload.identity/client-id",
  tenantId: "azure.workload.identity/tenant-id",
  exp: "azure.workload.identity/service-account-token-expiration",
} as const;
export const WI_USE_LABEL = "azure.workload.identity/use";
export const WI_AUDIENCE = "api://AzureADTokenExchange";
export const WI_IB_AUDIENCE = "api://AKSIdentityBinding";
/** "A maximum of 20 federated identity credentials can be added to an application or user-assigned managed identity." */
export const FIC_LIMIT = 20;
/** Dashboard threshold for "near the limit" (not a Microsoft number — labelled so) */
export const FIC_NEAR = 16;
/** Regions where FICs can't be created on user-assigned identities (Learn snapshot, workload-identity-federation-considerations) */
export const FIC_UNSUPPORTED_REGIONS = ["malaysiasouth"];
/** Built-in privileged roles by definition ID (Learn: built-in-roles/privileged) — decided by ID, never by name */
export const PRIVILEGED_ROLES: Record<string, "owner" | "contributor" | "uaa" | "rbacAdmin"> = {
  "8e3af657-a8ff-443c-a75c-2fe8c4bcb635": "owner",
  "b24988ac-6180-42a0-ab88-20f7382dd24c": "contributor",
  "18d7d88d-d35e-4fb5-a5c3-7773c20a72d9": "uaa",
  "f58310d9-a9f6-439a-9e8d-f62e7b41a168": "rbacAdmin",
};
export const SCAN_CAP = 50;
/** AcrPull — the kubelet identity's usual only role (decided by definition ID) */
export const ACR_PULL_ROLE = "7f951dda-4ed3-4680-a7ca-43fe172d538d";

const DOC = {
  considerations: "https://learn.microsoft.com/en-us/entra/workload-id/workload-identity-federation-considerations",
  federation: "https://learn.microsoft.com/en-us/entra/workload-id/workload-identity-federation",
  aksOverview: "https://learn.microsoft.com/en-us/azure/aks/workload-identity-overview",
  aksDeploy: "https://learn.microsoft.com/en-us/azure/aks/workload-identity-deploy-cluster",
  miBest: "https://learn.microsoft.com/en-us/entra/identity/managed-identities-azure-resources/managed-identity-best-practice-recommendations",
  rbacBest: "https://learn.microsoft.com/en-us/azure/role-based-access-control/best-practices",
  k8sRbac: "https://kubernetes.io/docs/reference/access-authn-authz/rbac/",
  imds: "https://learn.microsoft.com/en-us/azure/aks/imds-restriction",
};
/** One documented basis per rule (URL + the sentence it rests on) */
export const WI_RULE_DOCS: Record<WiRuleId, { url: string; quote: string }> = {
  "WI-01": { url: DOC.considerations, quote: "A maximum of 20 federated identity credentials can be added to an application or user-assigned managed identity." },
  "WI-02": { url: DOC.considerations, quote: "A maximum of 20 federated identity credentials can be added to an application or user-assigned managed identity." },
  "WI-03": { url: DOC.considerations, quote: "If you accidentally add the incorrect external workload information in the subject setting the federated identity credential is created successfully without error. The error does not become apparent until the token exchange fails." },
  "WI-04": { url: DOC.federation, quote: "The Federated Identity Credential issuer, subject, and audience values must case-sensitively match the corresponding issuer, subject and audience values contained in the token" },
  "WI-05": { url: DOC.considerations, quote: "The combination of issuer and subject must be unique on the app." },
  "WI-06": { url: DOC.considerations, quote: "You must add a single audience value… The recommended value is \"api://AzureADTokenExchange\"." },
  "WI-07": { url: DOC.aksOverview, quote: "Only pods with this label are mutated by the azure-workload-identity mutating admission webhook" },
  "WI-08": { url: DOC.aksOverview, quote: "You must enable workload identity and the OIDC issuer on your cluster before your pods can use workload identity." },
  "WI-09": { url: DOC.aksOverview, quote: "azure.workload.identity/tenant-id — Represents the Azure tenant ID where the Microsoft Entra application is registered." },
  "WI-10": { url: DOC.miBest, quote: "If the virtual machines' identity requires more role assignments, they are granted to all the resources associated with this identity." },
  "WI-11": { url: DOC.rbacBest, quote: "If you must assign a privileged administrator role, use a narrow scope, such as resource group or resource, instead of a broader scope, such as management group or subscription." },
  "WI-12": { url: DOC.rbacBest, quote: "It's recommended that you specify Actions and DataActions explicitly instead of using the wildcard (*)" },
  "WI-13": { url: DOC.k8sRbac, quote: "Broader grants can give unnecessary (and potentially escalating) API access to ServiceAccounts" },
  "WI-14": { url: DOC.miBest, quote: "if a user has access to install or execute code on this resource, then the user has access to all the identities assigned/associated to the Azure resource." },
  "WI-15": { url: DOC.considerations, quote: "Creation of federated identity credentials is currently not supported on user-assigned managed identities created in the following regions" },
  "WI-16": { url: DOC.aksOverview, quote: "If you update the service account annotations, you must restart the pod for the changes to take effect." },
  "WI-17": { url: DOC.imds, quote: "The IMDS REST API is available at a well-known, nonroutable IP address (169.254.169.254) that is by default accessible from all pods running in an AKS cluster." },
  "WI-18": { url: DOC.rbacBest, quote: "By limiting roles and scopes, you limit what resources are at risk if the security principal is ever compromised." },
};

// ── Granted vs used (WI-18): data-plane roles whose use the resource's own access log records ──

/** Days of access log read for "used / not used" */
export const USAGE_DAYS = 30;
/**
 * Data-plane roles by definition ID (names can change): which access log shows their use, and whether they write.
 * Control-plane roles (Contributor, Key Vault Reader …) and AcrPull are not here — no log records their reads, so their
 * use stays "unknown".
 */
export const DATA_ROLES: Record<string, { svc: "keyVault" | "storage"; write: boolean }> = {
  "00482a5a-887f-4fb3-b363-3b7fe8e74483": { svc: "keyVault", write: true },  // Key Vault Administrator
  "a4417e6f-fecd-4de8-b567-7b0420556985": { svc: "keyVault", write: true },  // Key Vault Certificates Officer
  "14b46e9e-c2b7-41b4-b07b-48a6ebf60603": { svc: "keyVault", write: true },  // Key Vault Crypto Officer
  "b86a8fe4-44ce-4948-aee5-eccb2c155cd7": { svc: "keyVault", write: true },  // Key Vault Secrets Officer
  "db79e9a7-68ee-4b58-9aeb-b90e7c24fcba": { svc: "keyVault", write: false }, // Key Vault Certificate User
  "e147488a-f6f5-4113-8e2d-b22465e65bf6": { svc: "keyVault", write: false }, // Key Vault Crypto Service Encryption User
  "08bbd89e-9f13-488c-ac41-acfcb10c90ab": { svc: "keyVault", write: false }, // Key Vault Crypto Service Release User
  "12338af0-0e69-4776-bea7-57ae8d297424": { svc: "keyVault", write: false }, // Key Vault Crypto User
  "4633458b-17de-408a-b874-0445c86b69e6": { svc: "keyVault", write: false }, // Key Vault Secrets User
  "ba92f5b4-2d11-453d-a403-e96b0029c9fe": { svc: "storage", write: true },   // Storage Blob Data Contributor
  "b7e6dc6d-f1e8-4753-8033-0f276bb0955b": { svc: "storage", write: true },   // Storage Blob Data Owner
  "2a2b9908-6ea1-4ae2-8e65-a410df84e7d1": { svc: "storage", write: false },  // Storage Blob Data Reader
  "974c5e8b-45b9-4653-ba55-5f855dd0fb88": { svc: "storage", write: true },   // Storage Queue Data Contributor
  "8a0f0c08-91a1-4084-bc3d-661d67233fed": { svc: "storage", write: true },   // Storage Queue Data Message Processor
  "c6a89b2d-59bc-44d0-9896-0f6e12d7b80a": { svc: "storage", write: true },   // Storage Queue Data Message Sender
  "19e7f393-937e-4f77-808e-94535e297925": { svc: "storage", write: false },  // Storage Queue Data Reader
  "0a9a7e1f-b9d0-4cc4-a60d-0319b160aaa3": { svc: "storage", write: true },   // Storage Table Data Contributor
  "76199698-9eea-4c19-bc75-cec21354c6b6": { svc: "storage", write: false },  // Storage Table Data Reader
  "69566ab7-960f-475b-8e7c-b3118f30c6bd": { svc: "storage", write: true },   // Storage File Data Privileged Contributor
  "b8eda974-7b85-4f76-af95-65846b26df6d": { svc: "storage", write: false },  // Storage File Data Privileged Reader
  "0c867c2a-1d8c-454a-a3db-ab2ea1bdc8bb": { svc: "storage", write: true },   // Storage File Data SMB Share Contributor
  "a7264617-510b-434b-a828-9731dc254ea7": { svc: "storage", write: true },   // Storage File Data SMB Share Elevated Contributor
  "aba4ae5f-2193-4029-9191-0cb91df5e314": { svc: "storage", write: false },  // Storage File Data SMB Share Reader
};
export const usageKey = (principalId: string, roleDefGuid: string, scope: string) => `${principalId}|${roleDefGuid}|${scope}`.toLowerCase();

/** One row per caller id (this identity's client or object id, "" = anyone else) at the queried scope over the window */
export function roleUsageQuery(svc: "keyVault" | "storage", ids: string[]): string {
  const list = `dynamic([${[...new Set(ids.map((x) => x.trim().toLowerCase()).filter(isGuid))].map((x) => `"${x}"`).join(",")}])`;
  const who = `| extend who = iff(appid in (ids), appid, iff(oid in (ids), oid, ""))
| summarize n = count(), lastSeen = max(TimeGenerated) by who`;
  if (svc === "keyVault") {
    return `let ids = ${list};
union isfuzzy=true
 (AzureDiagnostics | where ResourceProvider == "MICROSOFT.KEYVAULT" and Category == "AuditEvent"
   | project TimeGenerated, appid = tolower(tostring(column_ifexists("identity_claim_appid_g", ""))),
             oid = tolower(tostring(column_ifexists("identity_claim_http_schemas_microsoft_com_identity_claims_objectidentifier_g", "")))),
 (AZKVAuditLogs | project TimeGenerated, appid = tolower(tostring(Identity.claim.appid)), oid = tolower(tostring(Identity.claim.oid)))
${who}`;
  }
  return `let ids = ${list};
union isfuzzy=true StorageBlobLogs, StorageFileLogs, StorageQueueLogs, StorageTableLogs
| extend appid = tolower(tostring(column_ifexists("RequesterAppId", ""))), oid = tolower(tostring(column_ifexists("RequesterObjectId", "")))
${who}`;
}

/**
 * Pure verdict for one identity at one scope: its requests, or none while the log has someone's requests (unused),
 * or no request by anyone (the log isn't there — unknown, never "unused").
 */
export function usageVerdict(rows: Array<{ who?: unknown; n?: unknown; lastSeen?: unknown }>, ids: string[], svc: "keyVault" | "storage", days = USAGE_DAYS): WiRoleUsage {
  const want = new Set(ids.map((x) => x.toLowerCase()));
  let total = 0, mine = 0, last: string | undefined;
  for (const r of rows) {
    const n = Number(r.n) || 0;
    total += n;
    if (want.has(String(r.who ?? "").toLowerCase())) {
      mine += n;
      const l = r.lastSeen ? new Date(String(r.lastSeen)).toISOString() : undefined;
      if (l && (!last || l > last)) last = l;
    }
  }
  if (!total) return { state: "unknown", source: svc, days, logsInScope: 0, reason: "noLogs" };
  return mine ? { state: "used", source: svc, days, requests: mine, ...(last ? { last } : {}), logsInScope: total } : { state: "unused", source: svc, days, requests: 0, logsInScope: total };
}

// ── Inputs (collector → builder) ──

export type InvServiceAccount = { namespace: string; name: string; annotations: Record<string, string>; labels: Record<string, string> };
export type InvIdentity = {
  armId: string; name: string; resourceGroup: string; subscriptionId: string; location: string;
  clientId: string; principalId: string; tenantId: string; scanned: "annotated" | "subscriptionScan" | "nodePool";
};
export type InvFicList = { status: "ok" | "forbidden" | "throttled" | "error"; items: Array<{ name: string; issuer: string; subject: string; audiences: string[] }> };
/** A node pool's scale set (Resource Graph): the pool name (tag aks-managed-poolName) and its user-assigned identity ARM IDs */
export type InvNodePool = { pool: string; identityArmIds: string[] };
export type InvRoleAssignment = {
  principalId: string; roleDefGuid: string; roleName: string | null; roleType: string | null; scope: string; hasCondition: boolean; actions: string[];
};
export type WiInput = {
  clusterId: string;
  inventory: PolicyInventory;
  /** null = the ServiceAccount list was not readable */
  serviceAccounts: InvServiceAccount[] | null;
  saStatus: "ok" | "forbidden" | "error";
  cluster: { issuerUrl: string | null; oidcEnabled: boolean | null; wiEnabled: boolean | null };
  identities: InvIdentity[];
  identityLookup: "ok" | "failed";
  /** keyed by lower-case ARM ID */
  fics: Map<string, InvFicList>;
  /** null = not read */
  roleAssignments: InvRoleAssignment[] | null;
  subNames: Map<string, string>;
  scan: { requested: boolean; scanned: number; total: number | null; cap: number };
  gaps: string[];
  /** Node pool scale sets with their identities; null/absent = not read (status in imds.pools) */
  nodePools?: InvNodePool[] | null;
  imds?: { podAccess: WiImds["podAccess"]; restrictionBlockedBy: string[]; pools: WiImds["pools"]; nodeResourceGroup: string | null };
  /** Granted vs used per role assignment (usageKey); absent/null = not checked */
  roleUsage?: Map<string, WiRoleUsage> | null;
  now?: Date;
};

// ── Small pure helpers ──

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isGuid = (v: string | undefined): v is string => !!v && GUID.test(v.trim());
export const tail = (guid: string) => `…${guid.trim().slice(-4).toLowerCase()}`;
export const ficSubject = (ns: string, sa: string) => `system:serviceaccount:${ns}:${sa}`;

/** "system:serviceaccount:<ns>:<sa>" — case-sensitive prefix, exactly two non-empty segments */
export function parseFicSubject(s: string): { namespace: string; name: string } | null {
  const p = "system:serviceaccount:";
  if (!s.startsWith(p)) return null;
  const rest = s.slice(p.length).split(":");
  return rest.length === 2 && rest[0] && rest[1] ? { namespace: rest[0], name: rest[1] } : null;
}

/** Byte-exact, or which harmless-looking difference breaks it (whitespace → trailing slash → case) */
export function compareExact(expected: string, actual: string): WiMatch {
  if (expected === actual) return "exact";
  if (expected.trim() === actual.trim()) return "whitespace";
  const slash = (v: string) => v.trim().replace(/\/+$/, "");
  if (slash(expected) === slash(actual)) return "trailingSlash";
  if (slash(expected).toLowerCase() === slash(actual).toLowerCase()) return "case";
  return "other";
}
const near = (m: WiMatch | null) => m === "case" || m === "trailingSlash" || m === "whitespace";

export const maskIssuer = (url: string) => maskGuids(url);
export const opaqueId = (prefix: string, key: string) => `${prefix}:${createHash("sha256").update(key.toLowerCase()).digest("hex").slice(0, 10)}`;

/** Role assignment scope → display level and label (subscription by display name, GUID names masked) */
export function classifyScope(scope: string, subNames: Map<string, string>): WiScope {
  const s = scope.replace(/\/+$/, "");
  if (s === "" || s === "/") return { level: "root", label: "/" };
  const mg = /^\/providers\/microsoft\.management\/managementgroups\/([^/]+)$/i.exec(s);
  if (mg) return { level: "managementGroup", label: maskGuids(mg[1]!) };
  const sub = /^\/subscriptions\/([^/]+)(?:\/resourcegroups\/([^/]+)(\/providers\/(.+))?)?$/i.exec(s);
  if (!sub) return { level: "resource", label: maskGuids(s.split("/").pop() ?? s) };
  const subLabel = subNames.get(sub[1]!.toLowerCase()) ?? L("구독(이름 미확인)", "Subscription (name unknown)");
  if (!sub[2]) return { level: "subscription", label: subLabel };
  if (!sub[3]) return { level: "resourceGroup", label: `${subLabel} / ${sub[2]}` };
  const parts = sub[4]!.split("/");
  const type = parts.length >= 2 ? `${parts[0]}/${parts[1]}` : parts[0]!;
  return { level: "resource", label: `${sub[2]} / ${maskGuids(parts[parts.length - 1]!)}`, resourceType: type };
}
const BREADTH: Record<WiScopeLevel, number> = { root: 4, managementGroup: 3, subscription: 2, resourceGroup: 1, resource: 0 };
export const scopeBreadth = (l: WiScopeLevel) => BREADTH[l];

/** Does a v4 CIDR (prefix ≥ 16 — explicit link-local, not "the whole internet") contain the IMDS address? */
export function cidrHasImds(cidr: unknown): boolean {
  if (typeof cidr !== "string") return false;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?:\/(\d{1,2}))?$/.exec(cidr.trim());
  if (!m) return false;
  const bits = m[5] === undefined ? 32 : Number(m[5]);
  if (bits < 16 || bits > 32) return false;
  const ip = (a: number[]) => a.reduce((x, o) => ((x << 8) | o) >>> 0, 0);
  const mask = bits === 32 ? 0xffffffff : (~((1 << (32 - bits)) - 1)) >>> 0;
  return ((ip([1, 2, 3, 4].map((i) => Number(m[i]))) & mask) >>> 0) === ((ip([169, 254, 169, 254]) & mask) >>> 0);
}

const isEmptySelector = (sel: unknown) => {
  if (!sel || typeof sel !== "object") return true;
  const o = sel as { matchLabels?: Record<string, unknown>; matchExpressions?: unknown[] };
  return !Object.keys(o.matchLabels ?? {}).length && !(o.matchExpressions ?? []).length;
};
const rec = (r: unknown): Record<string, unknown> => (r && typeof r === "object" ? r as Record<string, unknown> : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const allowsImds = (cidr: unknown, except: unknown) => cidrHasImds(cidr) && !arr(except).some(cidrHasImds);

/** Network policies whose egress explicitly allows the IMDS address (an "except" that removes it doesn't count) */
export function imdsAllowPolicies(inv: PolicyInventory): WiImds["allowPolicies"] {
  const out: WiImds["allowPolicies"] = [];
  for (const cp of inv.ciliumPolicies) {
    const hit = cp.specs.find((spec) => spec.endpointSelector && arr(spec.egress).some((r) =>
      arr(rec(r).toCIDR).some(cidrHasImds) || arr(rec(r).toCIDRSet).some((c) => allowsImds(rec(c).cidr, rec(c).except))));
    if (hit) {
      out.push({
        kind: cp.namespace === undefined ? "CiliumClusterwideNetworkPolicy" : "CiliumNetworkPolicy",
        ...(cp.namespace !== undefined ? { namespace: cp.namespace } : {}), name: cp.name, selectsAll: isEmptySelector(hit.endpointSelector),
      });
    }
  }
  for (const np of inv.networkPolicies) {
    if (arr(np.egress).some((r) => arr(rec(r).to).some((t) => allowsImds(rec(rec(t).ipBlock).cidr, rec(rec(t).ipBlock).except)))) {
      out.push({ kind: "NetworkPolicy", namespace: np.namespace, name: np.name, selectsAll: isEmptySelector(np.podSelector) });
    }
  }
  return out.sort((a, b) => (`${a.namespace ?? ""}/${a.name}` < `${b.namespace ?? ""}/${b.name}` ? -1 : 1));
}

/**
 * Key Vault audit logs (diagnostic setting → workspace): who used this identity, by client library and caller IP.
 * Only the client ID's last 4 characters go in — the query never carries a full GUID.
 */
export function imdsKvQuery(clientId: string): string {
  const t = clientId.trim().toLowerCase().slice(-4);
  return `union isfuzzy=true
  (AzureDiagnostics | where ResourceProvider == "MICROSOFT.KEYVAULT" | project TimeGenerated, appid = tostring(column_ifexists("identity_claim_appid_g", "")), client = tostring(column_ifexists("clientInfo_s", "")), ip = CallerIPAddress, op = OperationName),
  (AZKVAuditLogs | project TimeGenerated, appid = tostring(Identity.claim.appid), client = tostring(column_ifexists("ClientInfo", "")), ip = CallerIpAddress, op = OperationName)
| where TimeGenerated > ago(1d) and appid endswith "${t}"
| summarize calls = count(), ops = make_set(op, 5) by library = tostring(split(client, " ")[0]), ip
| order by calls desc`;
}

const SYSTEM_BINDING = (b: { name: string; labels?: Record<string, string> }) => b.name.startsWith("system:") || isAksManaged(b.labels);

/** The SA's Kubernetes RBAC — direct subject, or its groups (system:serviceaccounts[:<ns>], system:authenticated) */
export function saRbac(inv: PolicyInventory, ns: string, sa: string): WiK8sBinding[] {
  const groups = new Set(["system:serviceaccounts", `system:serviceaccounts:${ns}`, "system:authenticated"]);
  const out: WiK8sBinding[] = [];
  for (const b of inv.bindings) {
    if (b.kind === "RoleBinding" && b.namespace !== ns) continue;
    const direct = b.subjects.some((s) => s.kind === "ServiceAccount" && s.name === sa && (s.namespace ?? b.namespace) === ns);
    const group = b.subjects.find((s) => s.kind === "Group" && groups.has(s.name));
    if (!direct && !group) continue;
    const risk = rbacRiskKeys(roleRules(inv, b.roleRef, b.namespace), b.roleRef.name);
    out.push({
      kind: b.kind, name: b.name, ...(b.namespace ? { namespace: b.namespace } : {}), role: b.roleRef.name,
      via: direct ? "serviceAccount" : "group", ...(direct ? {} : { group: group!.name }), keys: risk.keys, conditional: risk.conditional,
    });
  }
  return out;
}

/** Other subjects that can run code as a ServiceAccount of `ns` (pods/exec create, serviceaccounts/token create, cluster-admin) */
export function whoCanUseSa(inv: PolicyInventory, ns: string, sa: string): Array<{ subject: string; binding: string; keys: RbacRiskKey[] }> {
  const out: Array<{ subject: string; binding: string; keys: RbacRiskKey[] }> = [];
  for (const b of inv.bindings) {
    if (SYSTEM_BINDING(b)) continue;
    if (b.kind === "RoleBinding" && b.namespace !== ns) continue;
    const risk = rbacRiskKeys(roleRules(inv, b.roleRef, b.namespace), b.roleRef.name);
    const keys = risk.keys.filter((k) => (k === "exec" && !risk.conditional.includes("exec")) || k === "token" || k === "clusterAdmin");
    if (!keys.length) continue;
    for (const s of b.subjects) {
      if (s.kind === "ServiceAccount" && s.name === sa && (s.namespace ?? b.namespace) === ns) continue;
      const subject = s.kind === "ServiceAccount" ? `ServiceAccount ${(s.namespace ?? b.namespace) ?? "?"}/${s.name}` : `${s.kind} ${maskGuids(s.name)}`;
      out.push({ subject, binding: `${b.kind} ${b.name}`, keys });
    }
  }
  return out.slice(0, 12);
}

// ── Builder ──

const SEV_RANK: Record<WiSeverity, number> = { crit: 0, warn: 1, low: 2, info: 3 };

export function buildWorkloadIdentityMap(input: WiInput): WorkloadIdentityResponse {
  const inv = input.inventory;
  const issuer = input.cluster.issuerUrl;
  const findings: WiFinding[] = [];
  const add = (rule: WiRuleId, sev: WiSeverity, ev: EvidenceKind, subject: string, refs: string[], title: string, detail: string, remediation: string, code?: string) => {
    const d = WI_RULE_DOCS[rule];
    findings.push({ id: `${rule}:${subject}`, rule, sev, ev, title, detail, remediation, ...(code ? { code } : {}), docUrl: d.url, docQuote: d.quote, refs });
  };

  // ServiceAccounts as listed (only azure.workload.identity/* annotations were kept by the collector)
  const saList = new Map((input.serviceAccounts ?? []).map((s) => [`${s.namespace}/${s.name}`, s]));
  const saKnown = input.serviceAccounts !== null;

  // Pods by SA: webhook traces (token file name, client/tenant GUIDs)
  const podsBySa = new Map<string, PolicyInventory["pods"]>();
  for (const p of inv.pods) {
    if (p.phase === "Succeeded" || p.phase === "Failed") continue;
    const k = `${p.namespace}/${p.serviceAccountName ?? "default"}`;
    podsBySa.set(k, [...(podsBySa.get(k) ?? []), p]);
  }

  // Client ID per SA: annotation first, else what running pods carry
  const clientOf = (key: string): { id: string; source: "annotation" | "podEnv" } | null => {
    const a = saList.get(key)?.annotations[WI_ANN.clientId];
    if (isGuid(a)) return { id: a.trim().toLowerCase(), source: "annotation" };
    const env = (podsBySa.get(key) ?? []).map((p) => p.wi?.clientId).find(isGuid);
    return env ? { id: env.toLowerCase(), source: "podEnv" } : null;
  };

  // Relevant workloads: annotated SA, use label, or webhook traces in running pods
  const workloads: WiWorkload[] = [];
  const saKeys = new Set<string>();
  // Pod → node pool (nodes[].pool); pools get ids "pool:<name>"
  const poolOfNode = new Map((inv.nodes ?? []).filter((n) => n.pool).map((n) => [n.name, n.pool!]));
  const poolsOf = (pods: PolicyInventory["pods"]) =>
    [...new Set(pods.map((p) => (p.nodeName ? poolOfNode.get(p.nodeName) : undefined)).filter((x): x is string => !!x))].sort().map((x) => `pool:${x}`);
  const others: WiOtherWorkload[] = [];
  const wiPools = new Map<string, string[]>();
  for (const w of inv.workloads) {
    const sa = w.serviceAccountName ?? "default";
    const key = `${w.namespace}/${sa}`;
    const useLabel = w.podLabels?.[WI_USE_LABEL] === "true";
    const pods = (podsBySa.get(key) ?? []).filter((p) => p.name.startsWith(`${w.name}-`));
    const traced = pods.filter((p) => p.wi?.tokenFile);
    if (!useLabel && !traced.length && !clientOf(key)) {
      // Not a workload identity user — listed so a namespace's absence from the map is explained, not guessed at
      others.push({
        id: `w:${w.namespace}/${w.kind}/${w.name}`, namespace: w.namespace, name: w.name, kind: w.kind, pods: pods.length,
        managed: isAksManaged(w.labels) || w.namespace === "kube-system", serviceAccount: sa, pools: poolsOf(pods),
        hostNetwork: w.security?.hostNetwork === true, usesSecrets: w.security?.usesSecrets === true,
      });
      continue;
    }
    wiPools.set(`w:${w.namespace}/${w.kind}/${w.name}`, poolsOf(pods));
    saKeys.add(key);
    const injClient = traced.map((p) => p.wi?.clientId).find(isGuid);
    workloads.push({
      id: `w:${w.namespace}/${w.kind}/${w.name}`, namespace: w.namespace, name: w.name, kind: w.kind, pods: pods.length,
      managed: isAksManaged(w.labels), saId: `sa:${key}`, useLabel,
      injected: !pods.length ? "noRunningPods" : traced.length === pods.length ? "yes" : traced.length ? "mixed" : "no",
      ...(injClient ? { injectedClientIdTail: tail(injClient) } : {}),
    });
  }
  for (const [key, s] of saList) if (isGuid(s.annotations[WI_ANN.clientId])) saKeys.add(key);

  // Identities by client ID; unresolved client IDs become their own (grey) node
  const idByClient = new Map(input.identities.map((i) => [i.clientId.toLowerCase(), i]));
  const identityNodes = new Map<string, WiIdentity>();
  const identityIdOf = (i: InvIdentity) => opaqueId("mi", i.armId);
  const ficsOut: WiFic[] = [];
  const ficLinks: Array<{ fic: WiFic; saKey: string | null }> = [];
  const poolsByIdentity = new Map<string, string[]>();
  for (const np of input.nodePools ?? []) {
    for (const a of np.identityArmIds) {
      const k = a.toLowerCase();
      poolsByIdentity.set(k, [...new Set([...(poolsByIdentity.get(k) ?? []), `pool:${np.pool}`])].sort());
    }
  }

  for (const i of input.identities) {
    const id = identityIdOf(i);
    const list = input.fics.get(i.armId.toLowerCase());
    const status = list?.status ?? "notListed";
    const items = list?.status === "ok" ? list.items : [];
    let otherIssuers = 0;
    const ids: string[] = [];
    // The SAs that point at this identity — a credential whose subject only nearly names one of them is a near miss
    const ownSubjects = [...new Set([...saList.keys(), ...podsBySa.keys()])].filter((k) => clientOf(k)?.id === i.clientId.toLowerCase())
      .map((k) => { const [ns, name] = k.split("/") as [string, string]; return ficSubject(ns, name); });
    for (const f of items) {
      const issuerMatch = issuer ? compareExact(issuer, f.issuer) : "other";
      const parsed = parseFicSubject(f.subject);
      const exactKey = parsed ? `${parsed.namespace}/${parsed.name}` : null;
      // Best match against this identity's own SAs; an exact parse of a listed (or, unlisted, pod-used) SA is exact
      const own = ownSubjects.map((x) => compareExact(x, f.subject));
      const subjectMatch: WiMatch | null = own.includes("exact") || (exactKey && (saList.has(exactKey) || (!saKnown && podsBySa.has(exactKey)))) ? "exact"
        : own.find(near) ?? (parsed ? "other" : null);
      const saKey = issuerMatch === "exact" && subjectMatch === "exact" && exactKey ? exactKey : null;
      if (issuerMatch === "other") otherIssuers++;
      const dangling = issuerMatch === "exact" && parsed && !near(subjectMatch) && subjectMatch !== "exact" ? (saKnown ? !saList.has(exactKey!) : null) : false;
      const fic: WiFic = {
        id: opaqueId("fic", `${i.armId}/${f.name}`), identityId: id, name: maskGuids(f.name), issuerMasked: maskIssuer(f.issuer), issuerMatch,
        subject: maskGuids(f.subject), subjectMatch,
        audiences: f.audiences, audienceOk: f.audiences.length === 1 && f.audiences[0] === WI_AUDIENCE,
        identityBindingAudience: f.audiences.includes(WI_IB_AUDIENCE), saId: saKey ? `sa:${saKey}` : null, dangling,
      };
      // Only credentials that concern this cluster are drawn; others are counted
      if (issuerMatch === "other") continue;
      ids.push(fic.id);
      ficsOut.push(fic);
      ficLinks.push({ fic, saKey: dangling ? null : saKey });
      if (saKey && !dangling) saKeys.add(saKey);
    }
    identityNodes.set(id, {
      id, kind: "userAssigned", name: maskGuids(i.name), resourceGroup: i.resourceGroup,
      ...(input.subNames.get(i.subscriptionId.toLowerCase()) ? { subscription: input.subNames.get(i.subscriptionId.toLowerCase())! } : {}),
      location: i.location, clientIdTail: tail(i.clientId), ...(isGuid(i.tenantId) ? { tenantIdTail: tail(i.tenantId) } : {}),
      fic: { status, count: status === "ok" ? items.length : null, limit: FIC_LIMIT, ids, otherIssuers, regionUnsupported: FIC_UNSUPPORTED_REGIONS.includes(i.location.toLowerCase()) },
      roles: [], rolesStatus: input.roleAssignments ? "ok" : "notListed", scanned: i.scanned,
      ...(poolsByIdentity.get(i.armId.toLowerCase())?.length ? { pools: poolsByIdentity.get(i.armId.toLowerCase())! } : {}),
    });
  }

  // ServiceAccount nodes
  const sas: WiServiceAccount[] = [];
  for (const key of [...saKeys].sort()) {
    const [ns, name] = key.split("/") as [string, string];
    const listed = saList.get(key);
    const client = clientOf(key);
    const ident = client ? idByClient.get(client.id) : undefined;
    let identityId: string | null = ident ? identityIdOf(ident) : null;
    if (client && !ident) {
      // Not a managed identity we can see: an app registration, or one in an unconnected subscription — not told apart
      identityId = opaqueId("mu", client.id);
      if (!identityNodes.has(identityId)) {
        identityNodes.set(identityId, {
          id: identityId, kind: "unresolved", clientIdTail: tail(client.id),
          unresolvedReason: input.identityLookup === "failed" ? "lookupFailed" : "notFoundInConnectedSubscriptions",
          fic: { status: "notListed", count: null, limit: FIC_LIMIT, ids: [], otherIssuers: 0, regionUnsupported: false },
          roles: [], rolesStatus: "notListed", scanned: "annotated",
        });
      }
    }
    const ficIds = ficLinks.filter((l) => l.saKey === key).map((l) => l.fic.id);
    // A FIC that federates this SA links the SA to its identity even without the annotation
    if (!identityId && ficIds.length) identityId = ficsOut.find((f) => f.id === ficIds[0])!.identityId;
    const tenantAnn = listed?.annotations[WI_ANN.tenantId];
    const identTenant = ident?.tenantId;
    sas.push({
      id: `sa:${key}`, namespace: ns, name, exists: saKnown ? !!listed : null,
      managed: ns === "kube-system" || isAksManaged(listed?.labels),
      ...(client ? { clientIdTail: tail(client.id), clientIdSource: client.source } : {}),
      ...(isGuid(tenantAnn) ? { tenantIdTail: tail(tenantAnn) } : {}),
      tenantMatch: isGuid(tenantAnn) && isGuid(identTenant) ? tenantAnn.trim().toLowerCase() === identTenant.toLowerCase() : null,
      identityId, ficIds, k8sRbac: saRbac(inv, ns, name), canUseIdentity: identityId ? whoCanUseSa(inv, ns, name) : [],
    });
  }

  // Role assignments per identity
  const byPrincipal = new Map<string, InvRoleAssignment[]>();
  for (const r of input.roleAssignments ?? []) byPrincipal.set(r.principalId.toLowerCase(), [...(byPrincipal.get(r.principalId.toLowerCase()) ?? []), r]);
  for (const i of input.identities) {
    const node = identityNodes.get(identityIdOf(i))!;
    node.roles = (byPrincipal.get(i.principalId.toLowerCase()) ?? []).map((r): WiRoleAssignment => ({
      id: opaqueId("ra", `${i.principalId}/${r.roleDefGuid}/${r.scope}`),
      roleName: r.roleName ?? L("역할 이름 미확인", "Role name unknown"),
      builtIn: r.roleType === null ? null : r.roleType === "BuiltInRole",
      privileged: PRIVILEGED_ROLES[r.roleDefGuid.toLowerCase()] ?? null,
      wildcardActions: r.roleType === "CustomRole" && r.actions.includes("*"),
      conditional: r.hasCondition,
      scope: classifyScope(r.scope, input.subNames),
      ...(input.roleUsage ? { usage: input.roleUsage.get(usageKey(i.principalId, r.roleDefGuid, r.scope)) ?? { state: "unknown" as const, source: null, days: USAGE_DAYS, reason: "notCovered" as const } } : {}),
    })).sort((a, b) => (a.privileged ? 0 : 1) - (b.privileged ? 0 : 1) || scopeBreadth(b.scope.level) - scopeBreadth(a.scope.level) || (a.roleName < b.roleName ? -1 : 1));
  }

  // ── Findings ──
  const identities = [...identityNodes.values()];
  const roleSev = (r: WiRoleAssignment): WiSeverity | null => {
    if (!r.privileged) return null;
    const broad = scopeBreadth(r.scope.level) >= 2;
    if (r.privileged !== "contributor" && broad) return "crit";
    if (r.privileged === "contributor" && broad) return "warn";
    if (r.scope.level === "resourceGroup") return "warn";
    return "low";
  };
  const worstRole = new Map<string, WiSeverity>();
  for (const idn of identities) {
    for (const r of idn.roles) {
      const sev = roleSev(r);
      if (sev) {
        add("WI-11", sev, "perm", r.id, [idn.id, r.id],
          L(`관리 ID ${idn.name}에 특권 역할 ${r.roleName} (${r.scope.label})`, `Managed identity ${idn.name} has privileged role ${r.roleName} (${r.scope.label})`),
          L("이 ID로 토큰을 얻는 파드는 이 범위에서 그 역할로 동작합니다.", "Pods that get this identity's token act with this role on this scope."),
          L("업무에 필요한 역할로 낮추고 범위를 리소스 그룹·리소스로 좁히세요 (역할 변경은 최대 10분 뒤 반영).", "Use a task-specific role on a resource group or resource (role changes take up to 10 minutes)."));
        const prev = worstRole.get(idn.id);
        if (!prev || SEV_RANK[sev] < SEV_RANK[prev]) worstRole.set(idn.id, sev);
      }
      if (r.wildcardActions) {
        add("WI-12", "warn", "perm", `${r.id}:wild`, [idn.id, r.id],
          L(`사용자 지정 역할 ${r.roleName}의 Actions에 와일드카드(*)`, `Custom role ${r.roleName} has a wildcard (*) action`),
          L("새로 추가되는 모든 동작까지 허용됩니다.", "It also grants every action added later."),
          L("필요한 Actions·DataActions를 명시하세요.", "List the Actions and DataActions explicitly."));
      }
    }
    if (idn.kind !== "userAssigned") continue;
    const n = idn.fic.count;
    if (n !== null && n >= FIC_LIMIT) {
      add("WI-01", "warn", "cfg", idn.id, [idn.id], L(`관리 ID ${idn.name}의 페더레이션 자격 증명 ${n}/${FIC_LIMIT} — 한도`, `Managed identity ${idn.name} has ${n}/${FIC_LIMIT} federated credentials — at the limit`),
        L("더 이상 클러스터·서비스 계정을 추가할 수 없습니다.", "No more clusters or service accounts can be added."),
        L("쓰지 않는 자격 증명(SA 없음)을 지우거나 워크로드별로 관리 ID를 나누세요 (또는 AKS identity binding).", "Delete unused credentials (no SA) or split identities per workload (or AKS identity bindings)."));
    } else if (n !== null && n >= FIC_NEAR) {
      add("WI-02", "info", "cfg", idn.id, [idn.id], L(`관리 ID ${idn.name}의 페더레이션 자격 증명 ${n}/${FIC_LIMIT} — 한도에 가까움 (대시보드 기준 ${FIC_NEAR})`, `Managed identity ${idn.name} has ${n}/${FIC_LIMIT} federated credentials — near the limit (dashboard threshold ${FIC_NEAR})`),
        L("한도 20개는 관리 ID마다 적용됩니다.", "The limit of 20 applies per managed identity."),
        L("새 클러스터를 붙이기 전에 정리 계획을 세우세요.", "Plan a clean-up before adding more clusters."));
    }
    if (idn.fic.regionUnsupported && (n ?? 0) === 0) {
      add("WI-15", "info", "cfg", `${idn.id}:region`, [idn.id], L(`관리 ID ${idn.name}의 지역(${idn.location})은 페더레이션 자격 증명을 지원하지 않음`, `Region ${idn.location} of ${idn.name} doesn't support federated credentials`),
        L("이 지역의 사용자 할당 관리 ID에는 자격 증명을 만들 수 없습니다.", "Credentials can't be created on user-assigned identities in this region."),
        L("지원 지역에 관리 ID를 만드세요.", "Create the identity in a supported region."));
    }
    const fedSas = sas.filter((s) => s.identityId === idn.id && s.ficIds.length);
    const nsCount = new Set(fedSas.map((s) => s.namespace)).size;
    if (fedSas.length > 1 || idn.fic.otherIssuers > 0) {
      const priv = worstRole.get(idn.id);
      add("WI-10", priv === "crit" || priv === "warn" ? "warn" : "info", "cfg", `${idn.id}:shared`, [idn.id, ...fedSas.map((s) => s.id)],
        L(`관리 ID ${idn.name}를 서비스 계정 ${fedSas.length}개(네임스페이스 ${nsCount}개)${idn.fic.otherIssuers ? `·다른 발급자 ${idn.fic.otherIssuers}개` : ""}가 함께 씀`, `Managed identity ${idn.name} is shared by ${fedSas.length} service accounts (${nsCount} namespaces)${idn.fic.otherIssuers ? ` and ${idn.fic.otherIssuers} other issuers` : ""}`),
        L("지원되는 구성(다대일)이지만, 이 ID에 주는 권한은 모두에게 함께 주어집니다.", "Supported (many-to-one), but any role given to this identity is given to all of them."),
        L("필요한 권한이 다르면 워크로드별 관리 ID로 나누세요.", "Split identities per workload when they need different permissions."));
    }
  }

  for (const f of ficsOut) {
    const idn = identityNodes.get(f.identityId)!;
    if (f.dangling) {
      add("WI-05", "warn", "cfg", f.id, [f.id, idn.id], L(`${f.subject} — 이 클러스터를 신뢰하지만 서비스 계정이 없음`, `${f.subject} trusts this cluster but the service account doesn't exist`),
        L("그 이름의 SA를 만들 수 있는 주체는 이 Azure ID를 얻습니다 (누가 만들 수 있는지는 미확인).", "Whoever can create a service account with that name gets this Azure identity (who can is not checked)."),
        L("쓰지 않는 자격 증명이면 지우세요.", "Delete it if it is unused."),
        `az identity federated-credential delete --identity-name ${idn.name ?? "<identity>"} --resource-group ${idn.resourceGroup ?? "<rg>"} --name ${f.name}`);
    }
    if (near(f.issuerMatch) || (f.issuerMatch === "exact" && near(f.subjectMatch))) {
      const what = near(f.issuerMatch) ? f.issuerMatch : f.subjectMatch!;
      add("WI-04", "warn", "cfg", `${f.id}:near`, [f.id, idn.id], L(`페더레이션 자격 증명 ${f.name} — 거의 일치 (${what === "case" ? "대소문자" : what === "trailingSlash" ? "끝 슬래시" : "앞뒤 공백"}만 다름)`, `Federated credential ${f.name} nearly matches (${what === "case" ? "case" : what === "trailingSlash" ? "trailing slash" : "whitespace"} only)`),
        L("토큰 교환은 대소문자까지 정확히 같아야 해서 이 자격 증명은 쓰이지 않습니다 (AADSTS70021).", "The token exchange matches case-sensitively, so this credential is never used (AADSTS70021)."),
        L("정확한 값으로 다시 만드세요. 같은 ID에 여러 개를 만들 때는 순차적으로 (동시 생성은 409).", "Recreate it with the exact value; create several on one identity sequentially (concurrent writes return 409)."));
    }
    if (!f.audienceOk) {
      add("WI-06", f.identityBindingAudience ? "info" : "low", "cfg", `${f.id}:aud`, [f.id], L(`페더레이션 자격 증명 ${f.name}의 audience가 권장값이 아님`, `Federated credential ${f.name} doesn't use the recommended audience`),
        f.identityBindingAudience ? L("api://AKSIdentityBinding — identity binding으로 보입니다.", "api://AKSIdentityBinding — looks like an identity binding.") : L(`현재: ${f.audiences.join(", ") || "-"}`, `Now: ${f.audiences.join(", ") || "-"}`),
        L(`audience는 ${WI_AUDIENCE} 하나로 두세요.`, `Use the single audience ${WI_AUDIENCE}.`));
    }
  }

  const clusterOff = input.cluster.oidcEnabled === false || input.cluster.wiEnabled === false;
  for (const s of sas) {
    const idn = s.identityId ? identityNodes.get(s.identityId) : undefined;
    const annotated = s.clientIdSource === "annotation";
    if (annotated && idn?.kind === "userAssigned" && idn.fic.status === "ok" && !s.ficIds.length) {
      const nearOne = ficsOut.some((f) => f.identityId === idn.id && (near(f.issuerMatch) || near(f.subjectMatch)));
      if (!nearOne && issuer) {
        add("WI-03", "warn", "cfg", s.id, [s.id, idn.id], L(`${s.namespace}/${s.name} — 관리 ID ${idn.name}에 이 클러스터·이 SA의 페더레이션 자격 증명이 없음`, `${s.namespace}/${s.name} — ${idn.name} has no federated credential for this cluster and service account`),
          L("파드가 토큰을 교환할 때 실패합니다 (AADSTS70021). identity binding을 쓰면 해당 없음(미수집).", "Token exchange fails for these pods (AADSTS70021). Not applicable with identity bindings (not collected)."),
          L("아래 명령으로 만드세요 (생성 후 몇 초~몇 분은 실패할 수 있음).", "Create it with the command below (it can fail for a few seconds to minutes after creation)."),
          `az identity federated-credential create --name ${s.namespace}-${s.name} --identity-name ${idn.name} --resource-group ${idn.resourceGroup} --issuer "<cluster OIDC issuer>" --subject ${ficSubject(s.namespace, s.name)} --audience ${WI_AUDIENCE}`);
      }
    }
    if (annotated && clusterOff) {
      add("WI-08", "warn", "cfg", `${s.id}:cluster`, [s.id], L("클러스터의 OIDC 발급자 또는 워크로드 ID가 꺼져 있음", "The cluster's OIDC issuer or workload identity is off"),
        L(`${s.namespace}/${s.name}에 client-id 주석이 있지만 파드에 토큰이 주입되지 않습니다.`, `${s.namespace}/${s.name} is annotated, but pods won't get tokens.`),
        L("두 기능을 켜세요.", "Enable both."), "az aks update -g <rg> -n <cluster> --enable-oidc-issuer --enable-workload-identity");
    }
    if (s.tenantMatch === false) {
      add("WI-09", "warn", "cfg", `${s.id}:tenant`, [s.id, ...(idn ? [idn.id] : [])], L(`${s.namespace}/${s.name}의 tenant-id 주석이 관리 ID의 테넌트와 다름`, `${s.namespace}/${s.name}'s tenant-id annotation differs from the identity's tenant`),
        L(`주석 ${s.tenantIdTail} · 관리 ID ${idn?.tenantIdTail ?? "?"}`, `Annotation ${s.tenantIdTail} · identity ${idn?.tenantIdTail ?? "?"}`),
        L("주석을 고치고 파드를 다시 시작하세요.", "Fix the annotation and restart the pods."));
    }
    if (idn) {
      const crit = s.k8sRbac.flatMap((b) => b.keys).filter((k) => GRADE[k] === "crit");
      const warn = s.k8sRbac.flatMap((b) => b.keys).filter((k) => GRADE[k] === "warn");
      if (crit.length || warn.length) {
        add("WI-13", crit.length ? "crit" : "warn", "perm", `${s.id}:rbac`, [s.id, idn.id],
          L(`${s.namespace}/${s.name} — 클러스터 고권한(${[...new Set([...crit, ...warn])].join(", ")})과 Azure ID를 함께 가짐`, `${s.namespace}/${s.name} holds high cluster privileges (${[...new Set([...crit, ...warn])].join(", ")}) and an Azure identity`),
          L("클러스터 안 권한으로 다른 워크로드를 장악하면 Azure 권한까지 이어집니다.", "Taking over workloads in the cluster leads on to the Azure permissions."),
          L("SA 권한을 줄이세요.", "Reduce the service account's permissions."), `kubectl auth can-i --list --as=system:serviceaccount:${s.namespace}:${s.name}`);
      }
      // WI-14 is reported once per (identity, namespace) below — the same subjects reach every SA of a namespace
    }
  }
  // WI-14 — one finding per (identity, namespace): who else can run code as those service accounts. Subjects that
  // only get there through cluster-admin can do anything anyway → informational; exec/token grants below that → low
  // (warn when the identity holds a privileged Azure role)
  const useGroups = new Map<string, { idn: WiIdentity; ns: string; sas: WiServiceAccount[]; subjects: Map<string, WiServiceAccount["canUseIdentity"][number]> }>();
  for (const s of sas) {
    if (!s.identityId || !s.canUseIdentity.length) continue;
    const k = `${s.identityId}|${s.namespace}`;
    const g = useGroups.get(k) ?? { idn: identityNodes.get(s.identityId)!, ns: s.namespace, sas: [] as WiServiceAccount[], subjects: new Map<string, WiServiceAccount["canUseIdentity"][number]>() };
    g.sas.push(s);
    for (const c of s.canUseIdentity) g.subjects.set(`${c.subject}|${c.binding}`, c);
    useGroups.set(k, g);
  }
  for (const g of useGroups.values()) {
    const subjects = [...g.subjects.values()];
    const adminOnly = subjects.every((c) => c.keys.includes("clusterAdmin"));
    const priv = worstRole.get(g.idn.id);
    const sevOf: WiSeverity = adminOnly ? "info" : priv === "crit" || priv === "warn" ? "warn" : "low";
    const names = g.sas.map((s) => s.name);
    add("WI-14", sevOf, "perm", `${g.idn.id}:${g.ns}:use`, [g.idn.id, ...g.sas.map((s) => s.id)],
      L(`${g.ns}에서 다른 주체 ${subjects.length}개가 SA ${names.length}개(${names.slice(0, 3).join(", ")}${names.length > 3 ? " …" : ""})로 코드를 실행할 수 있음${adminOnly ? " — 클러스터 관리자뿐" : ""}`,
        `${subjects.length} other subjects can run code as ${names.length} SAs in ${g.ns} (${names.slice(0, 3).join(", ")}${names.length > 3 ? " …" : ""})${adminOnly ? " — cluster admins only" : ""}`),
      subjects.slice(0, 5).map((c) => `${c.subject} (${c.binding} — ${c.keys.join(", ")})`).join(" · "),
      adminOnly
        ? L("cluster-admin 주체는 원래 모든 권한을 가집니다 — 관리자 그룹 구성원을 최소로 유지하세요.", "cluster-admin subjects can do anything anyway — keep the admin group membership minimal.")
        : L("pods/exec·serviceaccounts/token 권한을 줄이세요 — 그 주체는 이 Azure ID를 쓸 수 있습니다.", "Reduce pods/exec and serviceaccounts/token grants — those subjects can use this Azure identity."));
  }
  for (const w of workloads) {
    const sa = sas.find((s) => s.id === w.saId);
    if (sa?.clientIdSource === "annotation" && !w.useLabel) {
      add("WI-07", "warn", "cfg", w.id, [w.id, w.saId], L(`${w.namespace}/${w.name} — 파드 템플릿에 ${WI_USE_LABEL} 라벨 없음`, `${w.namespace}/${w.name} — pod template lacks the ${WI_USE_LABEL} label`),
        L("웹후크가 이 파드를 바꾸지 않아 토큰이 주입되지 않습니다 (재시작 후 실패).", "The webhook won't mutate these pods, so no token is injected (fails after restart)."),
        L("파드 템플릿에 라벨을 넣으세요.", "Add the label to the pod template."), `spec.template.metadata.labels: { ${WI_USE_LABEL}: "true" }`);
    }
    const mismatch = sa?.clientIdSource === "annotation" && ((w.useLabel && w.injected === "no") || (w.injectedClientIdTail && w.injectedClientIdTail !== sa.clientIdTail));
    if (mismatch) {
      add("WI-16", "low", "cfg", `${w.id}:inject`, [w.id], L(`${w.namespace}/${w.name} — 실행 중인 파드의 주입 상태가 SA 설정과 다름`, `${w.namespace}/${w.name} — running pods don't match the SA settings`),
        w.injected === "no" ? L("파드에 토큰 파일이 주입되지 않았습니다.", "No token file was injected.") : L(`파드 client-id ${w.injectedClientIdTail} · SA ${sa?.clientIdTail}`, `Pod client-id ${w.injectedClientIdTail} · SA ${sa?.clientIdTail}`),
        L("롤아웃 재시작으로 맞추세요.", "Restart the rollout."), `kubectl -n ${w.namespace} rollout restart ${w.kind.toLowerCase()}/${w.name}`);
    }
  }

  // ── Node pools and the IMDS path (WI-17): configuration — what pods *can* reach, never who did ──
  const imdsIn = input.imds ?? { podAccess: null, restrictionBlockedBy: [], pools: "notRead" as const, nodeResourceGroup: null };
  const allowPolicies = imdsAllowPolicies(inv);
  const poolNames = [...new Set([...(input.nodePools ?? []).map((p) => p.pool), ...(inv.nodes ?? []).map((n) => n.pool).filter((x): x is string => !!x)])].sort();
  const nodePools: WiNodePool[] = poolNames.map((name) => {
    const id = `pool:${name}`;
    const wi = workloads.filter((w) => wiPools.get(w.id)?.includes(id)).map((w) => ({ namespace: w.namespace, other: false }));
    const ot = others.filter((o) => o.pools.includes(id)).map((o) => ({ namespace: o.namespace, other: true }));
    const nsMap = new Map<string, { namespace: string; workloads: number; withoutWi: number }>();
    for (const w of [...wi, ...ot]) {
      const e = nsMap.get(w.namespace) ?? { namespace: w.namespace, workloads: 0, withoutWi: 0 };
      e.workloads++;
      if (w.other) e.withoutWi++;
      nsMap.set(w.namespace, e);
    }
    return {
      id, name,
      identityIds: input.identities.filter((i) => poolsByIdentity.get(i.armId.toLowerCase())?.includes(id)).map(identityIdOf),
      nodes: (inv.nodes ?? []).filter((n) => n.pool === name).length,
      workloads: wi.length + ot.length, withoutWi: ot.length,
      namespaces: [...nsMap.values()].sort((a, b) => b.withoutWi - a.withoutWi || (a.namespace < b.namespace ? -1 : 1)),
    };
  });
  if (imdsIn.podAccess !== "restricted") {
    const accessText = imdsIn.podAccess === "allowed" ? L("허용 (클러스터 기본값 — 제한 안 함)", "allowed (cluster default — not restricted)")
      : L("확인 불가 (클러스터 설정을 읽지 못함)", "unknown (cluster setting not readable)");
    const allow = allowPolicies.filter((p) => p.selectsAll).map((p) => `${p.namespace ? `${p.namespace}/` : ""}${p.name}`);
    for (const idn of identities) {
      if (!idn.pools?.length) continue;
      const raw = input.identities.find((i) => identityIdOf(i) === idn.id)!;
      const rawRoles = byPrincipal.get(raw.principalId.toLowerCase()) ?? [];
      const pools = nodePools.filter((p) => idn.pools!.includes(p.id));
      const fedSas = sas.filter((s) => s.identityId === idn.id && s.ficIds.length);
      const onlyAcrPull = rawRoles.length > 0 && rawRoles.every((r) => r.roleDefGuid.toLowerCase() === ACR_PULL_ROLE);
      const sev: WiSeverity | null = idn.rolesStatus !== "ok" ? "low"
        : !idn.roles.length ? null
          : idn.roles.some((r) => r.privileged) ? "crit"
            : onlyAcrPull && !fedSas.length ? "info" : "warn";
      if (!sev) continue;
      const aksMade = !!imdsIn.nodeResourceGroup && raw.resourceGroup.toLowerCase() === imdsIn.nodeResourceGroup.toLowerCase();
      const wl = pools.reduce((n, p) => n + p.workloads, 0);
      const without = pools.reduce((n, p) => n + p.withoutWi, 0);
      const nss = new Set(pools.flatMap((p) => p.namespaces.map((x) => x.namespace))).size;
      const poolList = pools.map((p) => p.name).join(", ");
      const roleList = idn.roles.slice(0, 4).map((r) => `${r.roleName} (${r.scope.label})`).join(", ") + (idn.roles.length > 4 ? ` +${idn.roles.length - 4}` : "");
      const kv = idn.roles.some((r) => r.scope.resourceType?.toLowerCase() === "microsoft.keyvault/vaults");
      add("WI-17", sev, idn.rolesStatus !== "ok" ? "unk" : "cfg", `${idn.id}:imds`, [idn.id, ...pools.map((p) => `${p.id}@${idn.id}`)],
        L(`관리 ID ${idn.name}가 노드 풀 ${poolList}에 붙어 있음 — 워크로드 ID 없이 그 노드의 파드가 IMDS로 이 ID의 토큰을 받을 수 있음`,
          `Managed identity ${idn.name} is attached to node pool ${poolList} — pods on those nodes can get its token through IMDS, without workload identity`),
        [
          L(`이 풀의 워크로드 ${wl}개(워크로드 ID 없음 ${without}개 · 네임스페이스 ${nss}개). 파드의 IMDS 접근: ${accessText}.`,
            `Workloads on this pool: ${wl} (${without} without workload identity · ${nss} namespaces). Pod access to IMDS: ${accessText}.`),
          idn.rolesStatus === "ok" ? L(`이 ID의 역할: ${roleList}.`, `This identity's roles: ${roleList}.`) : L("역할 할당을 읽지 못했습니다.", "Role assignments were not readable."),
          fedSas.length ? L(`같은 ID를 서비스 계정 ${fedSas.length}개가 워크로드 ID(FIC)로도 씁니다 — FIC로 좁힌 범위가 노드 풀 전체로 넓어집니다.`,
            `${fedSas.length} service accounts also use it through workload identity (FIC) — the credential's narrow scope is widened to the whole node pool.`) : "",
          allow.length ? L(`IMDS 송신을 네임스페이스 전체에 명시적으로 허용하는 정책: ${allow.join(", ")}.`, `Policies explicitly allowing IMDS egress for a whole namespace: ${allow.join(", ")}.`) : "",
          L("구성으로 본 '쓸 수 있음'입니다 — 실제 사용은 Azure 리소스의 로그로만 확인됩니다 (호출 IP가 노드 주소라 워크로드는 특정하지 못함).",
            "This is configuration (\"can\") — actual use shows only in the Azure resource's logs (the caller IP is the node's, so the workload can't be told)."),
        ].filter(Boolean).join(" "),
        (aksMade
          ? L("AKS가 노드에 붙인 ID입니다(노드 리소스 그룹) — 떼지 말고 필요 없는 역할 할당을 줄이세요 (예: Key Vault CSI를 워크로드 ID 모드(SecretProviderClass clientID)로 쓰면 추가 기능 ID에는 Key Vault 역할이 필요 없음).",
            "AKS attached this identity (node resource group) — don't detach it; remove role assignments it doesn't need (e.g. with the Key Vault CSI driver in workload identity mode (SecretProviderClass clientID) the add-on identity needs no Key Vault role).")
          : L("① 이 ID가 필요한 워크로드를 워크로드 ID로 옮기세요 (SA client-id 주석 + 파드 템플릿 use 라벨 + FIC) ② 그다음 노드 풀 VMSS에 이 ID를 붙인 출처(IaC·스크립트)에서 떼세요 — 노드 리소스 그룹의 리소스를 직접 바꾸는 것은 AKS 지원 범위 밖 ③ IMDS가 필요 없는 네임스페이스는 169.254.169.254 송신을 막으세요 (쓰는 앱이 있으면 ① 전에 막지 마세요).",
            "① Move the workloads that need this identity to workload identity (SA client-id annotation + pod template use label + FIC) ② then detach it from the node pool scale set where it was attached (IaC, script) — changing node resource group resources directly is outside AKS support ③ block egress to 169.254.169.254 in namespaces that don't need IMDS (not before ① while apps still use it)."))
          + (imdsIn.podAccess === "allowed" && imdsIn.restrictionBlockedBy.length
            ? L(` 클러스터 단위 IMDS 제한(미리 보기)은 켜진 추가 기능(${imdsIn.restrictionBlockedBy.join(", ")}) 때문에 지금은 켤 수 없습니다.`,
              ` The cluster-wide IMDS restriction (preview) can't be enabled while these add-ons are on: ${imdsIn.restrictionBlockedBy.join(", ")}.`)
            : ""),
        kv ? imdsKvQuery(raw.clientId) : undefined);
    }
  }

  // ── Granted but not used (WI-18): a data-plane role the resource's access log shows no call for, while it logs others ──
  if (input.roleUsage) {
    for (const i of input.identities) {
      const idn = identityNodes.get(identityIdOf(i));
      if (!idn) continue;
      for (const r of byPrincipal.get(i.principalId.toLowerCase()) ?? []) {
        const u = input.roleUsage.get(usageKey(i.principalId, r.roleDefGuid, r.scope));
        const def = DATA_ROLES[r.roleDefGuid.toLowerCase()];
        if (!u || u.state !== "unused" || !def) continue;
        const sc = classifyScope(r.scope, input.subNames);
        const role = r.roleName ?? r.roleDefGuid;
        const log = def.svc === "keyVault" ? L("Key Vault 감사 로그", "Key Vault audit log") : L("Storage 로그", "Storage logs");
        add("WI-18", def.write ? "warn" : "low", "obs", `${idn.id}:${r.roleDefGuid.toLowerCase()}:${sc.label}`, [idn.id],
          L(`${idn.name ?? i.name} — ${role}(${sc.label})를 ${u.days}일간 쓰지 않음`, `${idn.name ?? i.name} — ${role} (${sc.label}) not used in ${u.days} days`),
          L(`같은 범위의 ${log}에 ${u.days}일간 요청 ${u.logsInScope}건이 있는데 이 ID(client …${i.clientId.slice(-4)})의 요청은 0건입니다. 로그는 그 범위로 보낸 것만 셉니다 — 월말 배치처럼 드물게 쓰는 작업, 로그 보존 기간이 ${u.days}일보다 짧은 경우는 놓칠 수 있습니다.`,
            `The ${log} at the same scope has ${u.logsInScope} requests in ${u.days} days and none from this identity (client …${i.clientId.slice(-4)}). Only logs sent from that scope count — a rare job (month-end batch) or a retention shorter than ${u.days} days can be missed.`),
          def.write
            ? L("쓰기 권한입니다 — 쓰는 곳이 없다면 할당을 지우고, 필요하면 읽기 역할로 줄이세요. 지우기 전에 이 ID를 쓰는 워크로드·배치의 주기를 확인하세요.", "A write role — remove the assignment if nothing uses it, or narrow it to a read role. Check the schedule of workloads and jobs that use this identity first.")
            : L("쓰는 곳이 없다면 할당을 지우세요. 지우기 전에 이 ID를 쓰는 워크로드·배치의 주기를 확인하세요.", "Remove the assignment if nothing uses it. Check the schedule of workloads and jobs that use this identity first."),
          `az role assignment delete --assignee <principal-id> --role ${r.roleDefGuid.toLowerCase()} --scope <scope>   # ${role} · ${sc.label}`);
      }
    }
  }

  findings.sort((a, b) => SEV_RANK[a.sev] - SEV_RANK[b.sev] || (a.rule < b.rule ? -1 : a.rule > b.rule ? 1 : a.id < b.id ? -1 : 1));
  const resolved = identities.filter((i) => i.kind === "userAssigned");
  return {
    clusterId: input.clusterId,
    generatedAt: (input.now ?? new Date()).toISOString(),
    cluster: { oidcIssuerEnabled: input.cluster.oidcEnabled, workloadIdentityEnabled: input.cluster.wiEnabled, issuerMasked: issuer ? maskIssuer(issuer) : null },
    workloads: workloads.sort((a, b) => (a.id < b.id ? -1 : 1)),
    serviceAccounts: sas,
    fics: ficsOut,
    identities,
    findings,
    nodePools,
    imds: { podAccess: imdsIn.podAccess, restrictionBlockedBy: imdsIn.restrictionBlockedBy, allowPolicies, pools: imdsIn.pools },
    otherWorkloads: others.sort((a, b) => Number(a.managed) - Number(b.managed) || (a.namespace < b.namespace ? -1 : a.namespace > b.namespace ? 1 : a.name < b.name ? -1 : 1)),
    coverage: {
      serviceAccounts: input.saStatus,
      identitiesResolved: resolved.length,
      identitiesUnresolved: identities.length - resolved.length,
      ficListed: resolved.filter((i) => i.fic.status === "ok").length,
      ficFailed: resolved.filter((i) => i.fic.status !== "ok" && i.fic.status !== "notListed").length,
      roleAssignments: input.roleAssignments ? "ok" : resolved.length ? "error" : "notListed",
      pimEligibleIncluded: false,
      identityBindings: "notCollected",
      subscriptionScan: input.scan,
    },
    gaps: input.gaps,
  };
}
