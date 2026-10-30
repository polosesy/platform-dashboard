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
export type AlertRow = { id: string; dn?: string; sev?: string; st?: string; intent?: string; t?: string; dsc?: string; rids?: unknown;
  rem?: unknown; ce?: string; ent?: unknown; t0?: string; uri?: string };

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

/**
 * Resource Graph returns an alert's Description, CompromisedEntity, Entities and ExtendedProperties as
 * asterisks ("****…") — the same identity reads them in full from the Defender Alerts API (measured
 * 2026-10-29: 10 of 10 alerts). A masked value is not text: never shown, searched or counted.
 */
export const isMaskedText = (v: unknown): boolean => typeof v === "string" && /^\s*\*{3,}\s*$/.test(v);
const unmasked = (v: unknown): string | undefined => (isMaskedText(v) ? undefined : str(v));

/** Remediation, compromised entity, Kubernetes entities, first activity, portal link (all optional, GUIDs masked) */
export function alertExtras(r: AlertRow): Pick<PostureAlert, "remediation" | "entity" | "k8s" | "firstAt" | "portalUrl"> {
  const rem = (Array.isArray(r.rem) ? r.rem : typeof r.rem === "string" ? [r.rem] : [])
    .filter((x) => !isMaskedText(x)).map((x) => plainText(x, 400)).filter((x): x is string => !!x).slice(0, 8);
  const k8s: NonNullable<PostureAlert["k8s"]> = {};
  for (const e of Array.isArray(r.ent) ? r.ent : []) {
    const o = (e ?? {}) as Record<string, unknown>;
    const type = String(o.Type ?? o.type ?? "").toLowerCase();
    const name = unmasked(o.Name ?? o.name);
    if (!name) continue;
    if (type === "k8s-namespace" && !k8s.namespace) k8s.namespace = name;
    if (type === "k8s-pod" && !k8s.pod) k8s.pod = name;
    if (type === "container" && !k8s.container) k8s.container = name;
  }
  const uri = str(r.uri);
  return {
    ...(rem.length ? { remediation: rem } : {}),
    ...(unmasked(r.ce) ? { entity: maskGuids(unmasked(r.ce)!) } : {}),
    ...(Object.keys(k8s).length ? { k8s } : {}),
    ...(str(r.t0) ? { firstAt: str(r.t0)! } : {}),
    ...(uri && /^https:\/\/portal\.azure\.com\//.test(uri) ? { portalUrl: uri } : {}),
  };
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
        description: isMaskedText(r.dsc) ? "" : maskGuids(plainText(r.dsc, 600) ?? ""),
        ...(isMaskedText(r.dsc) ? { descriptionHidden: true } : {}),
        resources,
        ...alertExtras(r),
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
  // One resource once per severity — the recommendations' unhealthy counts repeat it per recommendation
  affected:
    `${A} | extend st=tostring(properties.status.code), rid=tolower(tostring(properties.resourceDetails.Id)), sev=tostring(properties.metadata.severity)` +
    " | where st == 'Unhealthy' and isnotempty(rid) | summarize n=dcount(rid) by sev",
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
    " intent=tostring(properties.Intent), t=tostring(properties.TimeGeneratedUtc), dsc=tostring(properties.Description), rids=properties.ResourceIdentifiers," +
    " rem=properties.RemediationSteps, ce=tostring(properties.CompromisedEntity), ent=properties.Entities, t0=tostring(properties.StartTimeUtc), uri=tostring(properties.AlertUri)" +
    " | order by t desc | take 200",
};


type DefenderAlert = { name?: string; properties?: { description?: string; compromisedEntity?: string; entities?: unknown } };
const ALERTS_API = "2022-01-01";

/**
 * Fill the fields Resource Graph masks from the Defender Alerts API (same identity, `Microsoft.Security/locations/alerts/read`):
 * description, compromised entity and entities only — ExtendedProperties (command lines, process trees) are not read.
 * Best effort: a failed or missing alert keeps `descriptionHidden` and the UI points to the Defender portal.
 */
export async function unmaskAlertRows(arm: Pick<ArmFetcher, "fetchJson">, subs: string[], rows: AlertRow[]): Promise<AlertRow[]> {
  const want = new Set(rows.filter((r) => isMaskedText(r.dsc) || isMaskedText(r.ce)).map((r) => (r.id.split("/").pop() ?? "").toLowerCase()));
  if (!want.size) return rows;
  const found = new Map<string, NonNullable<DefenderAlert["properties"]>>();
  await Promise.all(subs.map(async (sub) => {
    let url: string | undefined = `https://management.azure.com/subscriptions/${encodeURIComponent(sub)}/providers/Microsoft.Security/alerts?api-version=${ALERTS_API}`;
    for (let page = 0; url && page < 5; page++) {
      try {
        const res: { value?: DefenderAlert[]; nextLink?: string } = await arm.fetchJson(url, { timeoutMs: 15_000 });
        for (const a of res.value ?? []) {
          const k = (a.name ?? "").toLowerCase();
          if (want.has(k) && a.properties) found.set(k, a.properties);
        }
        url = res.nextLink && /^https:\/\/management\.azure\.com\//.test(res.nextLink) && found.size < want.size ? res.nextLink : undefined;
      } catch (e: unknown) {
        debug(`[posture] alert details: ${safeMessage(e)}`);
        url = undefined;
      }
    }
  }));
  if (!found.size) return rows;
  return rows.map((r) => {
    const p = found.get((r.id.split("/").pop() ?? "").toLowerCase());
    if (!p) return r;
    return {
      ...r,
      ...(isMaskedText(r.dsc) && str(p.description) ? { dsc: p.description } : {}),
      ...(isMaskedText(r.ce) && str(p.compromisedEntity) ? { ce: p.compromisedEntity } : {}),
      ...(Array.isArray(p.entities) ? { ent: p.entities } : {}),
    };
  });
}

/** Run the six Resource Graph queries; a failing section becomes a gap. Throws only when every section fails. */
export async function collectPosture(arm: Pick<ArmFetcher, "postJson"> & Partial<Pick<ArmFetcher, "fetchJson">>, subs: string[]): Promise<SecurityPostureResponse> {
  const gaps: PostureGap[] = [];
  const run = async <T>(section: PostureSection, q: string): Promise<T[]> => {
    try {
      return await query<T>(arm, subs, q);
    } catch (e: unknown) {
      gaps.push({ section, message: safeMessage(e) });
      return [];
    }
  };
  const [rec, affected, score, controls, compliance, plans, alerts] = await Promise.all([
    run<RecommendationRow>("recommendations", Q.recommendations),
    run<{ sev?: string; n?: number }>("affected", Q.affected),
    run<{ s?: { current?: number; max?: number; percentage?: number } }>("score", Q.score),
    run<ControlRow>("controls", Q.controls),
    run<ComplianceRow>("compliance", Q.compliance),
    run<PlanRow>("plans", Q.plans),
    run<AlertRow>("alerts", Q.alerts),
  ]);
  // Every section failed → let the route fall back to mock data with the (masked) reason
  if (gaps.length === Object.keys(Q).length) throw new Error(gaps[0]!.message);

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
    affected: gaps.some((g) => g.section === "affected") ? null : {
      High: num(affected.find((r) => r.sev === "High")?.n),
      Medium: num(affected.find((r) => r.sev === "Medium")?.n),
      Low: num(affected.find((r) => r.sev === "Low")?.n),
    },
    compliance: mapCompliance(compliance),
    plans: mapPlans(plans),
    alerts: mapAlerts(arm.fetchJson ? await unmaskAlertRows({ fetchJson: arm.fetchJson }, subs, alerts) : alerts),
    gaps,
  };
}

export type PostureDeps = {
  obo: (env: Env, token: string) => Promise<Pick<ArmFetcher, "postJson"> & Partial<Pick<ArmFetcher, "fetchJson">>>;
  sp: (env: Env) => Promise<Pick<ArmFetcher, "postJson"> & Partial<Pick<ArmFetcher, "fetchJson">>>;
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
