import type {
  PostureAlert,
  PostureComplianceStandard,
  PostureDefenderPlan,
  PostureDomain,
  PostureGap,
  PostureSection,
  PostureRecommendation,
  PostureResourceRef,
  PostureSeverity,
  SecureScoreControl,
  SecurityPostureResponse,
} from "@aud/types";
import type { Env } from "../env.js";
import { CacheManager, cachePrefix } from "../infra/cacheManager.js";
import { anonymousSpAllowed, getAnonymousArmFetcher, getArmFetcher, type ArmFetcher } from "../infra/azureClientFactory.js";
import { parseSubscriptionIds } from "../infra/requestParams.js";
import { debug } from "../infra/logger.js";

// ──────────────────────────────────────────────────────────────
// Defender for Cloud posture via Resource Graph `securityresources`
// (works with the user's OBO token or the shared service principal).
// Pure row → response mappers are exported for tests; subscription IDs
// never leave this module — resources are reported by name / type / RG.
// ──────────────────────────────────────────────────────────────

const cache = new CacheManager<SecurityPostureResponse>(20);
const RG_URL = "https://management.azure.com/providers/Microsoft.ResourceGraph/resources?api-version=2022-10-01";

export type RecommendationRow = {
  key: string;
  title: string;
  sev: string;
  unhealthy: number;
  healthy: number;
  md?: Record<string, unknown> | null;
  /** Unhealthy resources: { id, n: ResourceName, t: ResourceType } (identity findings carry a user/app name, not an ARM resource). */
  samples?: Array<{ id?: string; n?: string; t?: string }> | null;
};
export type ControlRow = { dn: string; s?: { current?: number; max?: number } | null; u?: number; h?: number; w?: number };
export type ComplianceRow = { name: string; st?: string; p?: number; f?: number; k?: number };
export type PlanRow = { name: string; tier?: string; sub?: string };
export type AlertRow = { id: string; dn?: string; sev?: string; st?: string; intent?: string; t?: string; dsc?: string; rids?: unknown };

const DOMAIN_BY_CATEGORY: Record<string, PostureDomain> = {
  identityandaccess: "identity",
  networking: "network",
  data: "data",
  compute: "compute",
  container: "container",
  appservices: "appServices",
};

// Masking lives with the other response helpers (re-exported for existing imports)
import { maskGuids, safeMessage } from "../infra/requestParams.js";
export { maskGuids, safeMessage };
const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** Defender text fields carry light HTML (<br>, <a>); keep plain text with line breaks. */
export function plainText(v: unknown, max = 1200): string | undefined {
  const s = str(v);
  if (!s) return undefined;
  const t = s
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|li|div)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t || undefined;
}

export function severityOf(v: unknown): PostureSeverity {
  const s = String(v ?? "").toLowerCase();
  return s === "high" ? "High" : s === "medium" ? "Medium" : "Low";
}

/** First known Defender category wins; "Unknown" / missing → other. */
export function domainOf(categories: unknown): PostureDomain {
  if (!Array.isArray(categories)) return "other";
  for (const c of categories) {
    const d = DOMAIN_BY_CATEGORY[String(c).toLowerCase()];
    if (d) return d;
  }
  return "other";
}

/** "/subscriptions/x/resourcegroups/rg/providers/microsoft.compute/virtualmachines/vm1" → { vm1, virtualmachines, rg } */
export function resourceRef(id: string): PostureResourceRef | null {
  const parts = id.trim().split("/");
  const lower = parts.map((p) => p.toLowerCase());
  const rgIdx = lower.indexOf("resourcegroups");
  const provIdx = lower.lastIndexOf("providers");
  const name = parts[parts.length - 1];
  if (!name) return null;
  const type = provIdx > 0 && parts.length - provIdx >= 4 ? parts[parts.length - 2]! : lower[1] === "subscriptions" && parts.length <= 3 ? "subscription" : "resource";
  const ref: PostureResourceRef = { name: type === "subscription" ? "subscription" : maskGuids(name), type, resourceGroup: rgIdx > 0 ? maskGuids(parts[rgIdx + 1] ?? "") : "" };
  // provider/type[/childType…] — the last segment alone collides (KeyVault vs RecoveryServices "vaults")
  if (provIdx > 0 && parts.length - provIdx >= 4) ref.armType = [lower[provIdx + 1], ...lower.slice(provIdx + 2).filter((_, i) => i % 2 === 0)].join("/");
  return ref;
}

/** Prefer Defender's own ResourceName/ResourceType (e.g. an Entra user for identity findings) over the ID tail. */
export function sampleRef(s: { id?: string; n?: string; t?: string }): PostureResourceRef | null {
  const ref = s.id ? resourceRef(s.id) : null;
  const name = str(s.n) ?? ref?.name;
  if (!name) return null;
  const type = str(s.t)?.split("/").pop() ?? ref?.type ?? "resource";
  const armType = ref?.armType ?? (str(s.t)?.includes("/") ? str(s.t)!.toLowerCase() : undefined);
  return { name: type === "subscription" ? "subscription" : maskGuids(name), type, resourceGroup: ref?.resourceGroup ?? "", ...(armType && ref?.resourceGroup ? { armType } : {}) };
}

const SEV_RANK: Record<PostureSeverity, number> = { High: 0, Medium: 1, Low: 2 };

export function mapRecommendations(rows: RecommendationRow[]): PostureRecommendation[] {
  const out: PostureRecommendation[] = [];
  for (const r of rows) {
    if (!r.key || !r.title || r.unhealthy <= 0) continue;
    const md = r.md ?? {};
    out.push({
      key: r.key,
      title: r.title,
      severity: severityOf(r.sev || md.severity),
      domain: domainOf(md.categories),
      threats: Array.isArray(md.threats) ? md.threats.map(String).filter(Boolean) : [],
      unhealthy: num(r.unhealthy),
      healthy: num(r.healthy),
      samples: (r.samples ?? []).map(sampleRef).filter((x): x is PostureResourceRef => !!x).slice(0, 5),
      description: plainText(md.description, 600),
      remediation: plainText(md.remediationDescription),
      userImpact: str(md.userImpact),
      implementationEffort: str(md.implementationEffort),
      portalUrl: `https://portal.azure.com/#blade/Microsoft_Azure_Security/RecommendationsBlade/assessmentKey/${encodeURIComponent(r.key)}`,
    });
  }
  return out.sort((a, b) => SEV_RANK[a.severity] - SEV_RANK[b.severity] || b.unhealthy - a.unhealthy || a.title.localeCompare(b.title));
}

export function mapControls(rows: ControlRow[]): SecureScoreControl[] {
  return rows
    .filter((r) => r.dn)
    .map((r) => ({
      controlName: r.dn,
      currentScore: Math.round(num(r.s?.current) * 100) / 100,
      maxScore: num(r.s?.max),
      weight: num(r.w),
      healthyResourceCount: num(r.h),
      unhealthyResourceCount: num(r.u),
    }))
    .sort((a, b) => b.maxScore - b.currentScore - (a.maxScore - a.currentScore) || b.unhealthyResourceCount - a.unhealthyResourceCount);
}

export function mapCompliance(rows: ComplianceRow[]): PostureComplianceStandard[] {
  return rows
    .filter((r) => r.name)
    .map((r) => ({ name: r.name, state: r.st ?? "Unknown", passed: num(r.p), failed: num(r.f), skipped: num(r.k) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function mapPlans(rows: PlanRow[]): PostureDefenderPlan[] {
  return rows
    .filter((r) => r.name)
    .map((r) => ({ name: r.name, tier: r.tier ?? "Free", ...(r.sub ? { subPlan: r.sub } : {}) }))
    .sort((a, b) => Number(b.tier === "Standard") - Number(a.tier === "Standard") || a.name.localeCompare(b.name));
}

export function mapAlerts(rows: AlertRow[]): PostureAlert[] {
  const sev = (v: unknown): PostureAlert["severity"] => {
    const s = String(v ?? "").toLowerCase();
    return s === "high" ? "High" : s === "medium" ? "Medium" : s === "informational" ? "Informational" : "Low";
  };
  return rows
    .map((r) => {
      const ids = Array.isArray(r.rids)
        ? r.rids.map((x) => str((x as Record<string, unknown>)?.AzureResourceId)).filter((x): x is string => !!x)
        : [];
      const resources = [...new Set(ids)].map(resourceRef).filter((x): x is PostureResourceRef => !!x);
      return {
        id: r.id.split("/").pop() ?? r.id,
        title: r.dn ?? "Unknown alert",
        severity: sev(r.sev),
        status: r.st ?? "Active",
        ...(r.intent ? { intent: r.intent } : {}),
        detectedAt: r.t ?? "",
        description: plainText(r.dsc, 600) ?? "",
        resources,
      };
    })
    .sort((a, b) => b.detectedAt.localeCompare(a.detectedAt));
}

// ── Resource Graph ──

async function query<T>(arm: Pick<ArmFetcher, "postJson">, subscriptions: string[], q: string): Promise<T[]> {
  const all: T[] = [];
  let skipToken: string | undefined;
  for (let page = 0; page < 10; page++) {
    const res = await arm.postJson<{ data?: T[]; $skipToken?: string }>(
      RG_URL,
      { subscriptions, query: q, options: { resultFormat: "objectArray", $top: 1000, ...(skipToken ? { $skipToken: skipToken } : {}) } },
      { timeoutMs: 25_000 },
    );
    all.push(...(res.data ?? []));
    skipToken = res.$skipToken;
    if (!skipToken) break;
  }
  return all;
}

const A = "securityresources | where type == 'microsoft.security/assessments'";
const Q = {
  recommendations:
    `${A} | extend st=tostring(properties.status.code), rid=tostring(properties.resourceDetails.Id)` +
    " | where st in ('Unhealthy','Healthy')" +
    " | summarize unhealthy=countif(st=='Unhealthy'), healthy=countif(st=='Healthy'), md=take_any(properties.metadata)," +
    " samples=make_list_if(pack('id', rid, 'n', tostring(properties.resourceDetails.ResourceName), 't', tostring(properties.resourceDetails.ResourceType))," +
    " st=='Unhealthy' and isnotempty(rid), 5)" +
    " by key=name, title=tostring(properties.displayName), sev=tostring(properties.metadata.severity)",
  score: "securityresources | where type == 'microsoft.security/securescores' and name == 'ascScore' | project s=properties.score",
  controls:
    "securityresources | where type == 'microsoft.security/securescores/securescorecontrols'" +
    " | project dn=tostring(properties.displayName), s=properties.score, u=toint(properties.unhealthyResourceCount)," +
    " h=toint(properties.healthyResourceCount), w=toint(properties.weight)",
  compliance:
    "securityresources | where type == 'microsoft.security/regulatorycompliancestandards'" +
    " | project name, st=tostring(properties.state), p=toint(properties.passedControls), f=toint(properties.failedControls), k=toint(properties.skippedControls)",
  plans: "securityresources | where type == 'microsoft.security/pricings' | project name, tier=tostring(properties.pricingTier), sub=tostring(properties.subPlan)",
  alerts:
    "securityresources | where type == 'microsoft.security/locations/alerts' | where tostring(properties.Status) in ('Active','InProgress')" +
    " | project id, dn=tostring(properties.AlertDisplayName), sev=tostring(properties.Severity), st=tostring(properties.Status)," +
    " intent=tostring(properties.Intent), t=tostring(properties.TimeGeneratedUtc), dsc=tostring(properties.Description), rids=properties.ResourceIdentifiers" +
    " | order by t desc | take 200",
};


/** Run the six Resource Graph queries; a failing section becomes a gap. Throws only when every section fails. */
export async function collectPosture(arm: Pick<ArmFetcher, "postJson">, subs: string[]): Promise<SecurityPostureResponse> {
  const gaps: PostureGap[] = [];
  const run = async <T>(section: PostureSection, q: string): Promise<T[]> => {
    try {
      return await query<T>(arm, subs, q);
    } catch (e: unknown) {
      gaps.push({ section, message: safeMessage(e) });
      return [];
    }
  };
  const [rec, score, controls, compliance, plans, alerts] = await Promise.all([
    run<RecommendationRow>("recommendations", Q.recommendations),
    run<{ s?: { current?: number; max?: number; percentage?: number } }>("score", Q.score),
    run<ControlRow>("controls", Q.controls),
    run<ComplianceRow>("compliance", Q.compliance),
    run<PlanRow>("plans", Q.plans),
    run<AlertRow>("alerts", Q.alerts),
  ]);
  // Every section failed → let the route fall back to mock data with the (masked) reason
  if (gaps.length === 6) throw new Error(gaps[0]!.message);

  // With several subscriptions, sum the per-subscription scores
  const scoreRows = score.map((r) => r.s ?? {});
  const max = scoreRows.reduce((s, r) => s + num(r.max), 0);
  const current = scoreRows.reduce((s, r) => s + num(r.current), 0);
  return {
    generatedAt: new Date().toISOString(),
    source: "azure",
    score: scoreRows.length ? { current: Math.round(current * 100) / 100, max, percentage: max > 0 ? Math.round((current / max) * 1000) / 10 : 0 } : null,
    controls: mapControls(controls),
    recommendations: mapRecommendations(rec),
    compliance: mapCompliance(compliance),
    plans: mapPlans(plans),
    alerts: mapAlerts(alerts),
    gaps,
  };
}

export type PostureDeps = {
  obo: (env: Env, token: string) => Promise<Pick<ArmFetcher, "postJson">>;
  sp: (env: Env) => Promise<Pick<ArmFetcher, "postJson">>;
};
const defaultDeps: PostureDeps = { obo: getArmFetcher, sp: (env) => getAnonymousArmFetcher(env, env.AZURE_SECURITY_SP_FALLBACK) };
const inflight = new Map<string, Promise<SecurityPostureResponse>>();

/**
 * Live posture for the allowed subscriptions (or one of them).
 * Security findings follow the signed-in user's own Azure permissions (OBO); the service principal
 * is used for anonymous requests only when AZURE_SECURITY_SP_FALLBACK is on (local verification).
 * An OBO failure never falls back to the service principal.
 */
export async function tryGetSecurityPosture(
  env: Env,
  bearerToken: string | undefined,
  opts?: { subscriptionId?: string },
  deps: PostureDeps = defaultDeps,
): Promise<SecurityPostureResponse | null> {
  if (!env.AZURE_SECURITY_ENABLED) return null;
  const subs = opts?.subscriptionId ? [opts.subscriptionId] : parseSubscriptionIds(env);
  if (!subs.length) return null;
  // Anonymous: only in dev mode (AUD_ANONYMOUS_SP) and with this feature's own opt-in
  const useSp = !bearerToken && anonymousSpAllowed(env, env.AZURE_SECURITY_SP_FALLBACK) && !!(env.AZURE_AD_TENANT_ID && env.AZURE_AD_CLIENT_ID && env.AZURE_AD_CLIENT_SECRET);
  if (!bearerToken && !useSp) return null;

  const key = `${bearerToken ? cachePrefix(bearerToken) : "sp"}:posture:${subs.join(",")}`;
  const cached = cache.get(key);
  if (cached) return cached;
  // Concurrent identical requests (e.g. React StrictMode double effects) share one set of queries
  const running = inflight.get(key);
  if (running) return running;

  const job = (async () => {
    const arm = bearerToken ? await deps.obo(env, bearerToken) : await deps.sp(env);
    const out = await collectPosture(arm, subs);
    debug(`[posture] ${out.recommendations.length} recommendations, ${out.alerts.length} alerts, gaps=${out.gaps.length}`);
    cache.set(key, out, env.AZURE_SECURITY_CACHE_TTL_MS);
    return out;
  })().catch((e: unknown) => {
    throw new Error(safeMessage(e));
  });
  inflight.set(key, job);
  try {
    return await job;
  } finally {
    inflight.delete(key);
  }
}
