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
  high: AzureRiskFactor & { count?: number };
  identity: AzureRiskFactor & { roles?: Array<{ role: "owner" | "contributor" | "uaa" | "rbacAdmin"; scope: "managementGroup" | "subscription" | "resourceGroup" | "resource" }> };
  portalUrl: string;
};

export type AzureRiskResponse = {
  subscriptionId: string;
  generatedAt: string;
  combos: AzureRiskCombo[];
  /** Per factor: resources "yes" — and the resources that could become a combination but a factor is unknown */
  counts: { exposed: number; high: number; privileged: number; combos: number; undetermined: number };
  /** Sections that failed (their factor is "unknown" everywhere) */
  gaps: Array<{ section: "exposureVm" | "exposurePaas" | "findings" | "identities" | "roles"; message: string }>;
};
