"use client";

// 사례·런북 › 재발 — the same alert rule on the same target firing again (API /api/ops/recurrence, docs/architecture/
// ops-knowledge.md §10): PagerDuty "past incidents" from facts — how often, still firing since when, how long it took to
// resolve, and what the team wrote for it. A recurring group with no case or runbook is a lesson not yet written down:
// one click starts the case with the group's firings as its timeline.

import { useState } from "react";
import type { OpsKnowledgeResponse, OpsRecurrenceGroup, OpsRecurrenceResponse } from "@aud/types";
import { apiUrl, fetchJsonWithBearer } from "@/lib/api";
import { useApiQuery } from "@/lib/useApiQuery";
import { dateLocale, useI18n } from "@/lib/i18n";
import { Button, Chip, EmptyState, ErrorNotice, LinkButton, LoadingState, Notice, Panel, SearchInput, Segmented } from "@/components/ui";
import { caseFromGroup, filterGroups, type CaseForm } from "@/lib/opsKnowledge";
import { SevBadge } from "./shared";
import s from "./runbooks.module.css";

const DAYS = [1, 7, 30] as const;
type Days = (typeof DAYS)[number];

export function RecurrenceView({ data, canWrite, onOpenCase, onOpenRunbook, onNewCase, onNewRunbook, onFind }: {
  data: OpsKnowledgeResponse; canWrite: boolean;
  onOpenCase: (id: string) => void; onOpenRunbook: (id: string) => void;
  onNewCase: (form: CaseForm) => void; onNewRunbook: (rule: string, title: string) => void; onFind: (text: string) => void;
}) {
  const { t, locale } = useI18n();
  const lc = dateLocale(locale);
  const [days, setDays] = useState<Days>(30);
  const [recurringOnly, setRecurringOnly] = useState(true);
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const r = useApiQuery(`ops-recurrence:${days}:${data.cases.length}:${data.runbooks.length}`, (token) =>
    fetchJsonWithBearer<OpsRecurrenceResponse>(apiUrl("/api/ops/recurrence", { days: String(days) }), token));
  const d = r.data?.days === days ? r.data : null;
  const when = (iso: string) => new Date(iso).toLocaleString(lc, { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
  const mins = (m: number) => (m < 60 ? t("ops.rec.min", { n: Math.round(m) }) : m < 1440 ? t("ops.rec.hour", { n: (m / 60).toFixed(1) }) : t("ops.rec.day", { n: (m / 1440).toFixed(1) }));
  const title = (id: string, kind: "case" | "runbook") => (kind === "case" ? data.cases : data.runbooks).find((x) => x.id === id)?.title ?? id;

  if (r.error) return <div className={s.stack}><ErrorNotice error={r.error} /></div>;
  if (!d) return <div className={s.stack}><LoadingState label={t("ops.rec.loading")} /></div>;
  const list = filterGroups(d.groups, recurringOnly, q);
  const startCase = (g: OpsRecurrenceGroup) => onNewCase(caseFromGroup(g, new Date(), {
    title: `${g.rule} — ${g.target.name}`,
    symptoms: t("ops.rec.symptoms", {
      rule: g.rule, target: [g.target.namespace, g.target.name].filter(Boolean).join("/"), n: g.occurrences, days,
      now: g.firingNow, p50: g.resolveMinutes ? mins(g.resolveMinutes.p50) : "—",
    }),
    fired: t("ops.rec.fired"), resolved: t("ops.rec.resolved"),
  }));

  return (
    <div className={s.stack}>
      {d.state !== "ok" ? (
        <Notice tone={d.state === "failed" ? "danger" : "warning"} title={t(`ops.rec.state.${d.state}`)}>
          {d.gaps.map((g) => `${t(`ops.rec.src.${g.source}`)} ${g.scope}: ${g.reason}`).join(" · ")}
        </Notice>
      ) : null}
      <Panel title={t("ops.rec.title")} sub={t("ops.rec.sub", { days })} flush actions={
        <div className={s.toolbar}>
          <Segmented label={t("ops.rec.window")} value={days} onChange={setDays} items={DAYS.map((x) => ({ id: x, label: t("ops.rec.days", { n: x }) }))} />
          <Segmented label={t("ops.rec.show")} value={recurringOnly ? "rec" : "all"} onChange={(v) => setRecurringOnly(v === "rec")}
            items={[{ id: "rec", label: t("ops.rec.onlyRecurring", { n: d.totals.recurring }) }, { id: "all", label: t("ops.rec.all", { n: d.totals.groups }) }]} />
          <SearchInput label={t("ops.kb.search")} value={q} onChange={setQ} />
        </div>
      } footer={<span className={s.sub}>{t("ops.rec.foot")}</span>}>
        <p className={s.recSummary}>
          {t("ops.rec.summary", { a: d.totals.alerts, g: d.totals.groups, r: d.totals.recurring, f: d.totals.firingNow })}
          {d.totals.recurring ? <> · <strong>{t("ops.rec.gap", { c: d.totals.recurringNoCase, b: d.totals.recurringNoRunbook, r: d.totals.recurring })}</strong></> : null}
        </p>
        {!list.length ? <EmptyState title={recurringOnly ? t("ops.rec.noneRecurring", { days }) : t("ops.rec.none", { days })} /> : (
          <ul className={s.list}>
            {list.map((g) => {
              const cases = [...g.cases.linked, ...g.cases.rule];
              const expanded = open === g.key;
              return (
                <li key={g.key} className={s.item} data-selected={expanded || undefined}>
                  <div className={s.itemHead}>
                    <LinkButton ariaExpanded={expanded} onClick={() => setOpen(expanded ? null : g.key)}>{expanded ? "▾ " : "▸ "}{g.rule}</LinkButton>
                    <SevBadge t={t} sev={g.severity} />
                    <Chip level="plain" glyph={false}>{t(`ops.rec.src.${g.source}`)}</Chip>
                    <Chip level={g.occurrences >= 2 ? "warn" : "neutral"}>{t("ops.rec.times", { n: g.occurrences })}</Chip>
                    {g.firingNow ? <Chip level="danger" title={t("ops.rec.firingHint")}>{t("ops.rec.firingNow", { n: g.firingNow, since: g.firingSince ? when(g.firingSince) : "—" })}</Chip> : null}
                  </div>
                  <span className={s.sub}>
                    {[g.target.namespace, g.target.name].filter(Boolean).join(" / ")}{g.target.type ? ` · ${g.target.type}` : ""}{g.target.resourceGroup ? ` · ${g.target.resourceGroup}` : ""}
                    {` · ${t("ops.rec.last", { at: when(g.lastAt) })}`}
                    {g.resolveMinutes ? ` · ${t("ops.rec.resolve", { p50: mins(g.resolveMinutes.p50), max: mins(g.resolveMinutes.max), n: g.resolveMinutes.n })}` : ` · ${t("ops.rec.neverResolved")}`}
                  </span>
                  <div className={s.tags}>
                    {cases.length ? cases.map((id) => <LinkButton key={id} onClick={() => onOpenCase(id)}>{g.cases.linked.includes(id) ? "● " : "○ "}{title(id, "case")}</LinkButton>)
                      : <span className={s.muted}>{t("ops.rec.noCase")}</span>}
                    {g.runbooks.length ? g.runbooks.map((id) => <LinkButton key={id} onClick={() => onOpenRunbook(id)}>▸ {title(id, "runbook")}</LinkButton>)
                      : <span className={s.muted}>{t("ops.rec.noRunbook")}</span>}
                  </div>
                  {expanded ? (
                    <div className={s.section}>
                      <h3>{t("ops.rec.recent", { n: g.recent.length, total: g.occurrences })}</h3>
                      <ol className={`${s.timeline} ${s.timelineShort}`}>
                        {g.recent.map((x) => (
                          <li key={x.at}>
                            <span className={s.tlWhen}>{when(x.at)}</span>
                            <span className={s.tlText}>{x.resolvedAt ? t("ops.rec.firedTo", { at: when(x.resolvedAt), d: mins((Date.parse(x.resolvedAt) - Date.parse(x.at)) / 60_000) }) : t("ops.rec.stillFiring")}</span>
                          </li>
                        ))}
                      </ol>
                      <div className={s.actions}>
                        {canWrite ? <Button size="sm" variant="primary" onClick={() => startCase(g)}>{t("ops.rec.startCase")}</Button> : null}
                        {canWrite && !g.runbooks.length ? <Button size="sm" onClick={() => onNewRunbook(g.rule, g.rule)}>{t("ops.rec.writeRunbook")}</Button> : null}
                        <Button size="sm" variant="ghost" onClick={() => onFind(`${g.rule} ${g.target.name}`)}>{t("ops.rec.find")}</Button>
                      </div>
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </Panel>
    </div>
  );
}
