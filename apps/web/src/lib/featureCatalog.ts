"use client";

// Feature × permission catalog on the web — the data comes from the API (GET /api/azure/feature-catalog, static);
// these are the lookups both settings pages share (/settings/features, /settings/connections).
import type { FeatureCatalogResponse, FeatureDef, FeatureReadiness, FeatureRollup, PermissionCell, PermissionDef, PermissionKey, PlanTierId } from "@aud/types";
import { apiUrl, fetchJsonWithBearer } from "./api";
import { useApiQuery } from "./useApiQuery";

export function useFeatureCatalog() {
  return useApiQuery("feature-catalog", (token) => fetchJsonWithBearer<FeatureCatalogResponse>(apiUrl("/api/azure/feature-catalog"), token), { tokenOptional: true });
}

/** Tiers in package order (each includes the one before) */
export function tierOrder(cat: FeatureCatalogResponse): PlanTierId[] {
  const out: PlanTierId[] = [];
  let cur = cat.tiers.find((t) => t.includes === null);
  while (cur && !out.includes(cur.id)) {
    out.push(cur.id);
    const id = cur.id;
    cur = cat.tiers.find((t) => t.includes === id);
  }
  return out;
}

export const featuresOf = (cat: FeatureCatalogResponse, tier: PlanTierId): FeatureDef[] => cat.features.filter((f) => f.tier === tier);
export const permOf = (cat: FeatureCatalogResponse, key: PermissionKey): PermissionDef | undefined => cat.permissions.find((p) => p.key === key);

/** The i18n key and vars of a permission's scope ("구독", "리소스 (클러스터)", "클러스터 안 (Kubernetes RBAC)") */
export function scopeText(p: PermissionDef): { key: string; vars?: Record<string, string> } {
  if (p.scope.kind === "subscription") return { key: "feat.scope.subscription" };
  if (p.scope.kind === "resource") return { key: "feat.scope.resource", vars: { type: p.scope.armType.split("/").pop() ?? p.scope.armType } };
  return { key: p.scope.namespace ? "feat.scope.kubernetesNs" : "feat.scope.kubernetes", vars: { ns: p.scope.namespace ?? "" } };
}

/** A permission cell as one short phrase: "가능", "일부 2/3", "구독에서 상속", "해당 리소스 없음", "꺼짐 (선택)" … */
export function cellText(c: PermissionCell | undefined): { key: string; vars?: Record<string, number> } {
  if (!c) return { key: "conn.ps.unknown" };
  if (c.status === "partial" && c.sampled) return { key: "conn.ps.partial", vars: { ok: c.sampled.ok, n: c.sampled.checked } };
  if (c.status === "ok" && c.reason === "inherited") return { key: "conn.ps.inherited" };
  if (c.status === "unknown" && c.reason === "clusterNotChecked") return { key: "conn.ps.clusterNotChecked" };
  return { key: `conn.ps.${c.status}` };
}

export const CELL_TONE: Record<PermissionCell["status"], "success" | "high" | "medium" | "neutral" | "low"> = {
  ok: "success", missing: "high", partial: "medium", unknown: "neutral", notApplicable: "low", optInOff: "low",
};

/**
 * Feature readiness from its permission cells — the same rule as the API's rollupFeature (services/featureCatalog.ts,
 * equality tested in apps/api/test/featureCatalog.test.ts). The page re-rolls after a cluster check fills in the
 * Kubernetes cells.
 */
export function rollupFeature(def: FeatureDef, cells: Partial<Record<PermissionKey, PermissionCell>>): FeatureRollup {
  const st = (k: PermissionKey) => cells[k]?.status ?? "unknown";
  const missingRequired = def.requires.filter((k) => st(k) === "missing" || st(k) === "optInOff");
  const partialRequired = def.requires.filter((k) => st(k) === "partial");
  const unknown = def.requires.filter((k) => st(k) === "unknown");
  const missingOptional = def.optional.filter((k) => st(k) === "missing" || st(k) === "partial");
  let readiness: FeatureReadiness = "ready";
  if (missingRequired.length) readiness = "blocked";
  else if (partialRequired.length) readiness = "partial";
  else if (unknown.length) readiness = "unknown";
  else if (missingOptional.length) readiness = "partial";
  return { id: def.id, tier: def.tier, readiness, missingRequired: [...missingRequired, ...partialRequired], missingOptional, unknown };
}

export const READY_TONE: Record<FeatureReadiness, "success" | "medium" | "high" | "neutral"> = { ready: "success", partial: "medium", blocked: "high", unknown: "neutral" };
