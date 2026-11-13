"use client";

// 사례·런북 — pieces the tabs share: the write call, error sentences, status / severity / signal labels
import type { OpsCaseStatus, OpsMatch, OpsSeverity, OpsSignal } from "@aud/types";
import { ApiError, apiUrl, fetchJsonWithBearer } from "@/lib/api";
import { useApiToken } from "@/lib/useApiToken";
import { Badge, Chip } from "@/components/ui";
import type { ChipLevel } from "@/components/ui";

type T = (k: string, v?: Record<string, string | number>) => string;

/** PUT / DELETE / POST an /api/ops path with the signed-in user's token */
export function useOpsCall() {
  const getToken = useApiToken();
  return async <R,>(method: "PUT" | "DELETE" | "POST", path: string, params: Record<string, string>, body?: unknown): Promise<R> => {
    const token = await getToken().catch(() => null);
    return fetchJsonWithBearer<R>(apiUrl(path, params), token, { method, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  };
}

const KNOWN_ERRORS = new Set([
  "ops_case_conflict", "ops_runbook_conflict", "ops_case_invalid", "ops_runbook_invalid", "ops_case_store_full", "ops_runbook_store_full",
  "ops_cluster_unknown", "connection_forbidden", "role_required", "signin_required", "ops_case_not_found", "ops_runbook_not_found",
]);
export function errText(t: T, e: unknown): string {
  const code = e instanceof ApiError && e.code ? e.code : "";
  return KNOWN_ERRORS.has(code) ? t(`ops.kb.err.${code}`) : t("ops.kb.err.other", { code: code || String(e).slice(0, 120) });
}

const STATUS_LEVEL: Record<OpsCaseStatus, ChipLevel> = { open: "danger", mitigated: "warn", resolved: "ok" };
export const StatusChip = ({ t, status }: { t: T; status: OpsCaseStatus }) => <Chip level={STATUS_LEVEL[status]}>{t(`ops.kb.status.${status}`)}</Chip>;
const SEV_TONE = { sev1: "high", sev2: "medium", sev3: "low", sev4: "info" } as const;
export const SevBadge = ({ t, sev }: { t: T; sev: OpsSeverity }) => <Badge tone={SEV_TONE[sev]}>{t(`ops.kb.sev.${sev}`)}</Badge>;

export const signalText = (t: T, s: OpsSignal) => `${t(`ops.kb.signal.${s.kind}`)} · ${s.value}`;
export const SignalChips = ({ t, signals }: { t: T; signals: OpsSignal[] }) => (
  <>{signals.map((s) => <Chip key={`${s.kind}:${s.value}`} level="plain" glyph={false}>{signalText(t, s)}</Chip>)}</>
);

const STRENGTH_LEVEL = { strong: "ok", medium: "info", weak: "neutral" } as const;
/** Why it matched: the strength, the shared signals, the scope, the weightiest words */
export function MatchWhy({ t, m }: { t: T; m: OpsMatch }) {
  return (
    <>
      <Chip level={STRENGTH_LEVEL[m.strength]} title={t("ops.kb.strengthHint")}>{t(`ops.kb.strength.${m.strength}`)}</Chip>
      {m.why.signals.map((s) => <Chip key={`${s.kind}:${s.value}`} level="plain" glyph={false}>{signalText(t, s)}</Chip>)}
      {m.why.scope.map((x) => <Chip key={x} level="plain" glyph={false}>{t(`ops.kb.scope.${x}`)}</Chip>)}
      {m.why.terms.length ? <span title={t("ops.kb.termsHint")}>{t("ops.kb.terms", { w: m.why.terms.join(", ") })}</span> : null}
    </>
  );
}
