"use client";

import { useId, useMemo, useState } from "react";
import Link from "next/link";
import type { IssueState, IssueStatus } from "@aud/types";
import { Badge, Button, EmptyState, Notice, Panel, SearchInput, Segmented, Select, Stat } from "@/components/ui";
import { dateLocale, useI18n } from "@/lib/i18n";
import type { IssueQueue as Queue, IssueSource, QueueItem } from "@/lib/issueQueue";
import { EvidenceChip } from "../../policies/insights/Inspector";
import s from "./risk.module.css";

export type SourceState = "ok" | "loading" | "failed" | "off";
type Filter = "active" | "accepted" | "resolved" | "all";
const SOURCES: IssueSource[] = ["combo", "wi", "vuln", "alert"];
const SEV_TONE = { critical: "high", high: "high", medium: "medium", low: "low" } as const;
const STATUS_TONE = { open: "high", inProgress: "info", accepted: "neutral", resolved: "success" } as const;

export type SaveResult = "ok" | "conflict" | string;

/**
 * 통합 위험 › 이슈 목록 — every source's issues in one queue, the team's status beside each. Issues come from the
 * sources (recomputed per load); only the status is stored. Operators change a status; everyone sees it.
 */
export function IssueQueue({ queue, sources, durable, canWrite, signedIn, onSave }: {
  queue: Queue;
  sources: Record<IssueSource, SourceState>;
  durable: boolean;
  canWrite: boolean;
  signedIn: boolean;
  onSave: (item: QueueItem, change: { status: IssueStatus; note?: string; assignee?: string; until?: string }) => Promise<SaveResult>;
}) {
  const { t } = useI18n();
  const [filter, setFilter] = useState<Filter>("active");
  const [source, setSource] = useState<IssueSource | "all">("all");
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const base = useId();
  const c = queue.counts;
  const shown = useMemo(() => queue.items.filter((i) =>
    (filter === "all" || (filter === "active" ? i.status === "open" || i.status === "inProgress" : i.status === filter)) &&
    (source === "all" || i.source === source) &&
    (!q || `${i.title} ${i.target}`.toLowerCase().includes(q.toLowerCase()))), [queue.items, filter, source, q]);

  return (
    <Panel title={t("iq.title")} sub={t("iq.sub")}>
      <div className={s.iqSources} aria-label={t("iq.sources")}>
        {SOURCES.map((k) => (
          <span key={k} className={s.iqSource} data-state={sources[k]} title={t(`iq.sourceHint.${k}`)}>
            {t(`iq.source.${k}`)} · {t(`iq.state.${sources[k]}`)}
          </span>
        ))}
      </div>
      {!durable && signedIn ? <Notice tone="warning" title={t("iq.notDurable")}>{t("iq.notDurableHint")}</Notice> : null}
      <div className={s.stats}>
        <Stat label={t("iq.stat.open")} value={c.open} hint={c.openCritical ? t("iq.stat.openCritical", { n: c.openCritical }) : undefined} tone={c.openCritical ? "high" : c.open ? "medium" : undefined} />
        <Stat label={t("iq.stat.inProgress")} value={c.inProgress} />
        <Stat label={t("iq.stat.accepted")} value={c.accepted} hint={t("iq.stat.acceptedHint")} />
        <Stat label={t("iq.stat.resolved")} value={c.resolved} hint={queue.notDetected ? t("iq.stat.notDetected", { n: queue.notDetected }) : t("iq.stat.resolvedHint")} tone={c.resolved ? "success" : undefined} />
      </div>
      <div className={s.iqBar}>
        <Segmented label={t("iq.filter")} value={filter} onChange={setFilter} items={(["active", "accepted", "resolved", "all"] as Filter[]).map((f) => ({ id: f, label: t(`iq.filter.${f}`) }))} />
        <Select label={t("iq.sourceFilter")} value={source} onChange={(v) => setSource(v as IssueSource | "all")}
          options={[{ value: "all", label: t("iq.allSources") }, ...SOURCES.map((k) => ({ value: k, label: t(`iq.source.${k}`) }))]} />
        <SearchInput label={t("iq.search")} value={q} onChange={setQ} placeholder={t("iq.searchHint")} />
      </div>
      {shown.length === 0 ? <EmptyState title={queue.items.length ? t("iq.noMatch") : t("iq.none")} /> : (
        <ul className={s.iqRows}>
          {shown.map((i) => {
            const expanded = open === i.key;
            const panelId = `${base}-${i.key.replace(/[^a-z0-9]/gi, "").slice(-40)}`;
            return (
              <li key={i.key} className={s.iqRow} data-open={expanded || undefined} data-status={i.status}>
                <button type="button" className={s.iqHead} aria-expanded={expanded} aria-controls={panelId} onClick={() => setOpen(expanded ? null : i.key)}>
                  <Badge tone={SEV_TONE[i.sev]}>{t(`iq.sev.${i.sev}`)}</Badge>
                  <span className={s.iqMain}>
                    <span className={s.iqTitle} title={i.title}>{i.title}</span>
                    <span className={s.iqMeta}>{t(`iq.source.${i.source}`)}{i.target ? ` · ${i.target}` : ""}{i.stored?.assignee ? ` · ${t("iq.assignee")}: ${i.stored.assignee}` : ""}</span>
                  </span>
                  <span className={s.iqStatus}>
                    <Badge tone={STATUS_TONE[i.status]}>{t(`iq.status.${i.status}`)}</Badge>
                    {i.flag ? <span className={s.iqFlag} data-flag={i.flag}>{t(`iq.flag.${i.flag}`)}</span> : null}
                  </span>
                </button>
                {expanded ? (
                  <div id={panelId} className={s.iqBody}>
                    <div className={s.iqLinks}>
                      <EvidenceChip ev={i.evidence} />
                      <Link href={i.href} className={s.link}>{t("iq.openSource", { source: t(`iq.source.${i.source}`) })} →</Link>
                    </div>
                    <StateEditor item={i} canWrite={canWrite} signedIn={signedIn} onSave={onSave} />
                    {i.stored?.history.length ? <History items={i.stored.history} /> : null}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}

const today = () => new Date().toISOString().slice(0, 10);
const plusDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

function StateEditor({ item, canWrite, signedIn, onSave }: { item: QueueItem; canWrite: boolean; signedIn: boolean; onSave: (item: QueueItem, change: { status: IssueStatus; note?: string; assignee?: string; until?: string }) => Promise<SaveResult> }) {
  const { t } = useI18n();
  const cur: IssueState | null = item.stored;
  const [status, setStatus] = useState<IssueStatus>(cur?.status ?? "open");
  const [assignee, setAssignee] = useState(cur?.assignee ?? "");
  const [note, setNote] = useState(cur?.note ?? "");
  const [until, setUntil] = useState(cur?.until ?? plusDays(30));
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: "success" | "danger" | "warning"; text: string } | null>(null);
  if (!signedIn) return <p className={s.dim}>{t("iq.signin")}</p>;
  if (!canWrite) {
    return (
      <p className={s.dim}>
        {cur ? t("iq.readOnlyState", { status: t(`iq.status.${cur.status}`), by: cur.updatedBy ?? "—" }) : t("iq.readOnly")}
        {cur?.note ? <> — {cur.note}</> : null}
      </p>
    );
  }
  const exception = status === "accepted";
  const save = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const r = await onSave(item, { status, ...(note.trim() ? { note: note.trim() } : {}), ...(assignee.trim() ? { assignee: assignee.trim() } : {}), ...(exception ? { until } : {}) });
      setMsg(r === "ok" ? { tone: "success", text: t("iq.saved") } : r === "conflict" ? { tone: "warning", text: t("iq.conflict") } : { tone: "danger", text: t(`iq.err.${r}`) === `iq.err.${r}` ? r : t(`iq.err.${r}`) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className={s.iqEditor}>
      <Segmented label={t("iq.setStatus")} value={status} onChange={setStatus} items={(["open", "inProgress", "accepted", "resolved"] as IssueStatus[]).map((x) => ({ id: x, label: t(`iq.status.${x}`) }))} />
      <div className={s.iqFields}>
        <label className={s.iqField}>
          <span>{t("iq.assignee")}</span>
          <input value={assignee} maxLength={100} onChange={(e) => setAssignee(e.target.value)} placeholder={t("iq.assigneeHint")} />
        </label>
        {exception ? (
          <label className={s.iqField}>
            <span>{t("iq.until")}</span>
            <input type="date" value={until} min={today()} max={plusDays(366)} onChange={(e) => setUntil(e.target.value)} />
          </label>
        ) : null}
        <label className={`${s.iqField} ${s.iqWide}`}>
          <span>{exception ? t("iq.reason") : t("iq.note")}</span>
          <textarea value={note} maxLength={500} rows={2} onChange={(e) => setNote(e.target.value)} placeholder={exception ? t("iq.reasonHint") : t("iq.noteHint")} />
        </label>
      </div>
      <div className={s.iqActions}>
        <Button variant="primary" size="sm" onClick={save} disabled={busy || (exception && note.trim().length < 3)}>{t("iq.save")}</Button>
        {exception ? <span className={s.dim}>{t("iq.exceptionRule")}</span> : status === "resolved" ? <span className={s.dim}>{t("iq.resolvedRule")}</span> : null}
        {msg ? <span className={s.iqMsg} data-tone={msg.tone} role="status">{msg.text}</span> : null}
      </div>
    </div>
  );
}

function History({ items }: { items: IssueState["history"] }) {
  const { t, locale } = useI18n();
  return (
    <details className={s.iqHistory}>
      <summary>{t("iq.history", { n: items.length })}</summary>
      <ol>
        {items.map((h, i) => (
          <li key={i}>
            <span className={s.dim}>{new Date(h.at).toLocaleString(dateLocale(locale))}</span>{" "}
            <strong>{t(`iq.status.${h.status}`)}</strong>
            {h.until ? ` (~${h.until})` : ""}{h.by ? ` · ${h.by}` : ""}{h.note ? ` — ${h.note}` : ""}
          </li>
        ))}
      </ol>
    </details>
  );
}
