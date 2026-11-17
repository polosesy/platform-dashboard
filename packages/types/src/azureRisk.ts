// ─────────────────────────────────────────────────────────────
// 보안 › 이슈·통합 위험 › Azure 위험 조합 (docs/architecture/security-roadmap.md 5.3 ②) — Wiz "toxic combinations"
// on Azure resources: an Internet-exposed resource, a High Defender recommendation on it, a managed identity with a
// privileged role. Facts per factor with their evidence; a resource becomes an issue only where two or more are "yes".
// ─────────────────────────────────────────────────────────────

/** yes · no · unknown (could not tell — never counted as no) · n/a (the factor does not apply to this resource type) */
export type AzureFactorState = "yes" | "no" | "unknown" | "na";

export type AzureRiskFactor = {
  state: AzureFactorState;
  /** exposure only: reachable from listed source ranges / tags only (NSG "scoped"), not from any Internet address */
  limited?: boolean;
  /** Why — the exposure verdict and ports, the recommendation names, the roles and scopes */
  detail?: string;
  /** Why it is unknown (nsgUnreadable · publicAccessUnset · childRules · rolesUnread …) */
  reason?: string;
};

export type AzureRiskCombo = {
  /** issue key: `azure:<rg>/<provider/type>/<name>` lower-cased ASCII — the same resource keeps its issue state */
  key: string;
  name: string;
  /** ARM type, lower-case (`microsoft.compute/virtualmachines`) */
  type: string;
  resourceGroup: string;
  /** exposure + high + identity (2 or 3 of them "yes"); sev one step lower when the exposure is limited to listed sources */
  kind: "exposedHighIdentity" | "exposedIdentity" | "exposedHigh" | "highIdentity";
  sev: "critical" | "high" | "medium";
  exposure: AzureRiskFactor;
  /** count = High assessments on the resource and its child entities (images / containers); children = how many entities */
  high: AzureRiskFactor & { count?: number; children?: number };
  identity: AzureRiskFactor & { roles?: Array<{ role: "owner" | "contributor" | "uaa" | "rbacAdmin"; scope: "managementGroup" | "subscription" | "resourceGroup" | "resource" }> };
  portalUrl: string;
  /** lower-case ARM id — opens the resource security card */
  resourceId: string;
};

/** A data store a role can reach (a crown jewel) */
export type AzureJewelKind = "keyVault" | "storage" | "database";

/**
 * One role of the entry's managed identity on a path: privileged (control of its scope — Owner, Contributor, User
 * Access Administrator, RBAC Administrator) or a data role (Key Vault / Storage data plane, by definition ID), and the
 * data stores of this subscription inside its scope.
 */
export type AzurePathRole = {
  kind: "privileged" | "data";
  /** privileged: owner · contributor · uaa · rbacAdmin; data: keyVault · storage */
  role: string;
  /** data roles: write (Contributor / Officer / Owner) or read only */
  write?: boolean;
  /** reaches the data through the service's keys or access policies (listKeys · accessPolicies/write), not a data-plane role */
  viaKeys?: boolean;
  scope: "managementGroup" | "subscription" | "resourceGroup" | "resource";
  /** the resource group or resource name the scope names (none for subscription / management group) */
  scopeName?: string;
  /** data stores of this subscription inside the scope the role reaches (data roles: their service only) */
  reaches: Array<{ kind: AzureJewelKind; count: number; names: string[] }>;
};

/**
 * Internet → entry (exposure evidence) → its High findings → its managed identity's roles → the data inside their scope.
 * Only links with evidence; where the chain stops is said (`ends`).
 */
export type AzureAttackPath = {
  key: string;
  entry: { name: string; type: string; resourceGroup: string; detail?: string; limited?: boolean; resourceId: string };
  vuln: { count: number; names: string[] } | null;
  roles: AzurePathRole[];
  /** data = reaches a data store · control = a privileged role with no data store found in scope · entry = stops at the entry (vulnerable, no identity reach) */
  ends: "data" | "control" | "entry";
  sev: "critical" | "high" | "medium";
  /** the identity could not be judged (identities / roles unread) — the path may go further than shown */
  identityUnknown?: boolean;
  /** why it stops where it does: the entry's managed identities, and its roles that are neither privileged nor data roles */
  identity: { principals: number; otherRoles: number };
};

export type AzureRiskResponse = {
  subscriptionId: string;
  generatedAt: string;
  combos: AzureRiskCombo[];
  /** The resources counted as undetermined: one factor yes, another unknown — and why (≤ 50) */
  undetermined: Array<{ name: string; type: string; resourceGroup: string; yes: Array<"exposure" | "high" | "identity">; unknown: Array<{ factor: "exposure" | "high" | "identity"; reason?: string }> }>;
  /** attack paths from the Internet through exposed entries (security-roadmap 5.3 ③) */
  paths: AzureAttackPath[];
  /** Per factor: resources "yes" — and the resources that could become a combination but a factor is unknown */
  counts: { exposed: number; high: number; privileged: number; combos: number; undetermined: number; paths: number };
  /** Sections that failed (their factor is "unknown" everywhere) */
  gaps: Array<{ section: "exposureVm" | "exposurePaas" | "findings" | "identities" | "roles" | "jewels"; message: string }>;
};

// ── 리소스 보안 카드 (security-roadmap 5.3 ④) — every security fact about one Azure resource, in one answer ──

/** ok · failed (that section could not be read — never shown as "none") · na (does not apply to this resource) */
export type CardSectionState = "ok" | "failed" | "na";

export type ResourceSecurityCard = {
  resourceId: string;
  generatedAt: string;
  /** found = the caller's identity can read the resource */
  resource: { found: boolean; name: string; type: string; resourceGroup: string; location?: string; portalUrl: string };
  recommendations: {
    state: CardSectionState;
    /** unhealthy / healthy / not applicable assessments on the resource and its child entities (images, containers) */
    counts: { unhealthy: number; healthy: number; notApplicable: number; high: number; medium: number; low: number };
    /** unhealthy, one row per recommendation, High first (≤ 100) */
    items: Array<{ name: string; severity: "High" | "Medium" | "Low"; entities: number; onSelf: boolean }>;
  };
  alerts: { state: CardSectionState; items: Array<{ title: string; severity: string; status: string; at: string }> };
  /** section = whether it could be read; factor = the exposure verdict (the combinations' judge) */
  exposure: { section: CardSectionState; factor: AzureRiskFactor | null };
  /** what this resource can do: its managed identities' role assignments */
  identity: {
    state: CardSectionState;
    principals: number;
    roles: Array<{ roleName: string; class: "privileged" | "data" | "keys" | "other"; scope: "managementGroup" | "subscription" | "resourceGroup" | "resource"; scopeName?: string }>;
  };
  /** who can act on this resource: role assignments whose scope covers it, privileged / data / key roles only */
  access: {
    state: CardSectionState;
    /** per role class: assignments and distinct principals */
    byClass: Array<{ class: "privileged" | "data" | "keys"; assignments: number; principals: number }>;
    items: Array<{ roleName: string; class: "privileged" | "data" | "keys"; principalType: string; principalTail: string; scope: "managementGroup" | "subscription" | "resourceGroup" | "resource" }>;
  };
  /** the combination and attack path it belongs to (same keys as the issue list) */
  combo: AzureRiskCombo | null;
  path: AzureAttackPath | null;
};
