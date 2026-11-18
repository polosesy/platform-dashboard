"use client";

// 사례·런북 — pieces the tabs share: the write call, error sentences, status / severity / signal labels
import type { ReactNode } from "react";
import type { OpsCaseStatus, OpsMatch, OpsRunbook, OpsSeverity, OpsSignal } from "@aud/types";
import { ApiError, apiUrl, fetchJsonWithBearer } from "@/lib/api";
import { useApiToken } from "@/lib/useApiToken";
import { Badge, Chip, CodeBlock } from "@/components/ui";
import type { ChipLevel } from "@/components/ui";
import s from "./runbooks.module.css";

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

export const signalText = (t: T, x: OpsSignal) => `${t(`ops.kb.signal.${x.kind}`)} · ${x.value}`;
export const SignalChips = ({ t, signals }: { t: T; signals: OpsSignal[] }) => (
  <>{signals.map((x) => <Chip key={`${x.kind}:${x.value}`} level="plain" glyph={false}>{signalText(t, x)}</Chip>)}</>
);

/**
 * A block of a case / runbook detail: a heading (+ a quiet count or note) over its content. Inside `.detail` a rule and
 * space set it apart from the next block; `lead` = the sunken box at the top (the runbook's "when to use").
 */
export function DetailSection({ title, meta, lead, children }: { title: ReactNode; meta?: ReactNode; lead?: boolean; children: ReactNode }) {
  return (
    <section className={lead ? s.lead : s.section}>
      <div className={s.sectionHead}><h3>{title}</h3>{meta !== undefined && meta !== null ? <span className={s.sectionMeta}>{meta}</span> : null}</div>
      {children}
    </section>
  );
}

/** Signals in a detail: one row per kind (the kind once, in the label column), its values as code that wraps */
export function SignalRows({ t, signals }: { t: T; signals: OpsSignal[] }) {
  const byKind = new Map<OpsSignal["kind"], string[]>();
  for (const x of signals) byKind.set(x.kind, [...(byKind.get(x.kind) ?? []), x.value]);
  return (
    <dl className={s.signalRows}>
      {[...byKind].map(([kind, values]) => (
        <div key={kind}>
          <dt>{t(`ops.kb.signal.${kind}`)}</dt>
          <dd>{values.map((v) => <code key={v} className={s.sigValue}>{v}</code>)}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * Runbook steps: a numbered marker, then what to do → details → the command (labelled, copied only, scrolls inside
 * its box) → how to check. `brief` = title and command only (the find tab's helper).
 */
export function StepList({ t, steps, brief, maxHeight }: { t: T; steps: OpsRunbook["steps"]; brief?: boolean; maxHeight: number }) {
  return (
    <ol className={s.steps} role="list">
      {steps.map((st, i) => (
        <li key={i}>
          <span className={s.stepNo} aria-hidden="true">{i + 1}</span>
          <div className={s.stepBody}>
            <span className={s.stepTitle}>{st.title}</span>
            {!brief && st.detail ? <p className={s.prose}>{st.detail}</p> : null}
            {st.command ? <CodeBlock code={st.command} label={t("ops.kb.f.stepCommand")} copyLabel={t("ops.kb.copy")} copiedLabel={t("ops.kb.copied")} maxHeight={maxHeight} /> : null}
            {!brief && st.check ? <p className={s.check}><span>{t("ops.kb.f.stepCheck")}</span><span>{st.check}</span></p> : null}
          </div>
        </li>
      ))}
    </ol>
  );
}

const STRENGTH_LEVEL = { strong: "ok", medium: "info", weak: "neutral" } as const;
/** Why it matched: the strength, the shared signals, the scope, the weightiest words */
export function MatchWhy({ t, m }: { t: T; m: OpsMatch }) {
  return (
    <>
      <Chip level={STRENGTH_LEVEL[m.strength]} title={t("ops.kb.strengthHint")}>{t(`ops.kb.strength.${m.strength}`)}</Chip>
      {m.why.signals.map((x) => <Chip key={`${x.kind}:${x.value}`} level="plain" glyph={false}>{signalText(t, x)}</Chip>)}
      {m.why.scope.map((x) => <Chip key={x} level="plain" glyph={false}>{t(`ops.kb.scope.${x}`)}</Chip>)}
      {m.why.terms.length ? <span title={t("ops.kb.termsHint")}>{t("ops.kb.terms", { w: m.why.terms.join(", ") })}</span> : null}
    </>
  );
}
