import type { Env } from "../env";
import type { SecureScoreSummary, SecureScoreControl, SecurityAlertsResponse, SecurityAlert } from "@aud/types";
import { CacheManager, bearerKeyPrefix } from "../infra/cacheManager";
import { getArmFetcher } from "../infra/azureClientFactory";

// ────────────────────────────────────────────
// Azure Defender for Cloud — Secure Score & Alerts
// ────────────────────────────────────────────

const scoreCache = new CacheManager<SecureScoreSummary>(50);
const alertsCache = new CacheManager<SecurityAlertsResponse>(50);

function parseSubscriptionIds(raw: string): string[] {
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

// ── Secure Score ──

type ArmSecureScore = {
  properties?: {
    score?: { current?: number; max?: number; percentage?: number };
  };
};

type ArmScoreControl = {
  name?: string;
  properties?: {
    displayName?: string;
    currentScore?: number;
    maxScore?: number;
    weight?: number;
    healthyResourceCount?: number;
    unhealthyResourceCount?: number;
  };
};

export async function tryGetSecureScore(
  env: Env,
  bearerToken: string | undefined,
  opts?: { subscriptionId?: string },
): Promise<SecureScoreSummary | null> {
  if (!bearerToken || !env.AZURE_SUBSCRIPTION_IDS) return null;
  const subId = opts?.subscriptionId ?? parseSubscriptionIds(env.AZURE_SUBSCRIPTION_IDS)[0];
  if (!subId) return null;

  const prefix = bearerKeyPrefix(bearerToken);
  const key = `${prefix}:security:score:${subId}`;
  const cached = scoreCache.get(key);
  if (cached) return cached;

  const fetcher = await getArmFetcher(env, bearerToken);

  // Fetch overall score + controls in parallel
  const [scoreResp, controlsResp] = await Promise.all([
    fetcher.fetchJson<ArmSecureScore>(
      `https://management.azure.com/subscriptions/${subId}/providers/Microsoft.Security/secureScores/ascScore?api-version=2020-01-01`,
    ),
    fetcher.fetchJson<{ value?: ArmScoreControl[] }>(
      `https://management.azure.com/subscriptions/${subId}/providers/Microsoft.Security/secureScoreControls?api-version=2020-01-01&$expand=definition`,
    ),
  ]);

  const scoreProps = scoreResp.properties?.score;
  const currentScore = scoreProps?.current ?? 0;
  const maxScore = scoreProps?.max ?? 100;
  const percentage = scoreProps?.percentage ?? (maxScore > 0 ? (currentScore / maxScore) * 100 : 0);

  const controlScores: SecureScoreControl[] = (controlsResp.value ?? []).map((c) => ({
    controlName: c.properties?.displayName ?? c.name ?? "Unknown",
    currentScore: c.properties?.currentScore ?? 0,
    maxScore: c.properties?.maxScore ?? 0,
    weight: c.properties?.weight ?? 0,
    healthyResourceCount: c.properties?.healthyResourceCount ?? 0,
    unhealthyResourceCount: c.properties?.unhealthyResourceCount ?? 0,
  }));

  const summary: SecureScoreSummary = {
    generatedAt: new Date().toISOString(),
    currentScore,
    maxScore,
    percentage: Math.round(percentage * 10) / 10,
    controlScores,
  };

  scoreCache.set(key, summary, env.AZURE_SECURITY_CACHE_TTL_MS);
  return summary;
}

// ── Security Alerts ──

type ArmSecurityAlert = {
  name?: string;
  properties?: {
    alertDisplayName?: string;
    severity?: string;
    status?: string;
    compromisedEntity?: string;
    description?: string;
    timeGeneratedUtc?: string;
    intent?: string;
  };
};

export async function tryGetSecurityAlerts(
  env: Env,
  bearerToken: string | undefined,
  opts?: { subscriptionId?: string },
): Promise<SecurityAlertsResponse | null> {
  if (!bearerToken || !env.AZURE_SUBSCRIPTION_IDS) return null;
  const subId = opts?.subscriptionId ?? parseSubscriptionIds(env.AZURE_SUBSCRIPTION_IDS)[0];
  if (!subId) return null;

  const prefix = bearerKeyPrefix(bearerToken);
  const key = `${prefix}:security:alerts:${subId}`;
  const cached = alertsCache.get(key);
  if (cached) return cached;

  const fetcher = await getArmFetcher(env, bearerToken);
  const resp = await fetcher.fetchJson<{ value?: ArmSecurityAlert[] }>(
    `https://management.azure.com/subscriptions/${subId}/providers/Microsoft.Security/alerts?api-version=2022-01-01`,
  );

  const alerts: SecurityAlert[] = (resp.value ?? []).map((a) => {
    const p = a.properties ?? {};
    const severity = mapSeverity(p.severity ?? "Low");
    return {
      id: a.name ?? crypto.randomUUID(),
      alertName: p.alertDisplayName ?? "Unknown alert",
      severity,
      status: mapStatus(p.status ?? "Active"),
      compromisedEntity: p.compromisedEntity ?? "",
      description: p.description ?? "",
      detectedAt: p.timeGeneratedUtc ?? new Date().toISOString(),
      tactics: p.intent ? [p.intent] : [],
    };
  });

  const activeAlerts = alerts.filter((a) => a.status === "Active");
  const bySeverity = {
    high: activeAlerts.filter((a) => a.severity === "High").length,
    medium: activeAlerts.filter((a) => a.severity === "Medium").length,
    low: activeAlerts.filter((a) => a.severity === "Low").length,
    informational: activeAlerts.filter((a) => a.severity === "Informational").length,
  };

  const result: SecurityAlertsResponse = {
    generatedAt: new Date().toISOString(),
    totalActive: activeAlerts.length,
    bySeverity,
    alerts,
  };

  alertsCache.set(key, result, env.AZURE_SECURITY_CACHE_TTL_MS);
  return result;
}

function mapSeverity(s: string): SecurityAlert["severity"] {
  if (s === "High") return "High";
  if (s === "Medium") return "Medium";
  if (s === "Informational") return "Informational";
  return "Low";
}

function mapStatus(s: string): SecurityAlert["status"] {
  if (s === "Dismissed") return "Dismissed";
  if (s === "Resolved") return "Resolved";
  return "Active";
}
