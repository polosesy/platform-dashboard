"use client";

// AKS 모니터링 › 클러스터 · 워크로드 › K8s 이벤트 — `kubectl get events -A --field-selector type=Warning` as a section
// under the heatmap / table: the workloads' state and why Kubernetes complains about them on one screen. Every Warning
// event of the cluster (Kubernetes API, read with the connection's identity — API services/kubeEvents.ts), newest first.
//   head     — Warning n · still happening (last occurrence ≤ 5 min) · namespaces · objects; sort; copy as kubectl lines
//   filters  — namespace · text · system namespaces · still happening · reason chips (the event's own REASON, counted
//              within the other filters) — a known reason explains itself in one line (lib/kubeEventsView KNOWN_REASONS)
//   table    — last occurrence · namespace · object · reason · ×count (cumulative since the first occurrence) · message
//              (operators only, masked); a scroll box of its own so the page stays one screen of workloads + events
// Kubernetes keeps an event about an hour after its last occurrence: a past time range says these are today's.

import { useMemo, useState } from "react";
import type { KubeEventsResponse } from "@aud/types";
import { apiUrl, fetchJsonWithBearer } from "@/lib/api";
import { useApiQuery } from "@/lib/useApiQuery";
import { dateLocale, useI18n } from "@/lib/i18n";
import {
  Chip, CopyButton, EmptyState, ErrorNotice, FilterChip, LinkButton, LoadingState, Panel, SearchInput, Segmented, Select, Toggle,
} from "@/components/ui";
import type { TimeRange } from "@/lib/timeRange";
import { useRangeRefresh } from "@/lib/useTimeRange";
import {
  NO_FILTER, agoParts, eventLine, eventNamespaces, filterEvents, isRecent, knownReason, sortEvents, summarizeEvents, type EventFilter, type EventSort,
} from "@/lib/kubeEventsView";
import styles from "../styles.module.css";

/** Rows drawn before "show all" (a busy cluster can have a thousand) */
const FIRST_ROWS = 100;
/** Events asked for — the API reads up to 2,000 and says how many matched */
const LIMIT = 2000;
/** Reason chips before "+n" */
const REASON_CHIPS = 12;

export function EventsSection({ clusterId, range, nonce, report }: { clusterId: string; range: TimeRange; nonce: number; report?: (id: string, loading: boolean) => void }) {
  const { t, locale } = useI18n();
  const q = useApiQuery(clusterId ? `obs-events:${clusterId}` : null, (token) =>
    fetchJsonWithBearer<KubeEventsResponse>(apiUrl("/api/observability/events", { clusterId, limit: String(LIMIT) }), token),
  );
  useRangeRefresh("events", nonce, q.loading, q.reload, report);
  const [f, setF] = useState<EventFilter>(NO_FILTER);
  const [sort, setSort] = useState<EventSort>("recent");
  const [all, setAll] = useState(false);
  const [moreReasons, setMoreReasons] = useState(false);
  const d = q.data?.clusterId === clusterId ? q.data : null;

  const now = d ? Date.parse(d.generatedAt) : 0;
  const summary = useMemo(() => (d ? summarizeEvents(d.events, f, now) : null), [d, f, now]);
  const rows = useMemo(() => (d ? sortEvents(filterEvents(d.events, f, now), sort) : []), [d, f, now, sort]);
  const namespaces = useMemo(() => (d ? eventNamespaces(d.events) : []), [d]);

  const title = t("ob.ev.panel");
  if (q.error) return <Panel title={title}><ErrorNotice error={q.error} /></Panel>;
  if (!d || !summary) return <Panel title={title}><LoadingState label={t("ob.ev.loading")} /></Panel>;

  const rtf = new Intl.RelativeTimeFormat(dateLocale(locale), { numeric: "auto", style: "short" });
  const ago = (iso: string | undefined) => {
    const p = agoParts(iso, now);
    return p ? rtf.format(p.value, p.unit) : "—";
  };
  const when = (iso: string) => new Date(iso).toLocaleString(dateLocale(locale));
  const set = (patch: Partial<EventFilter>) => { setF((x) => ({ ...x, ...patch })); setAll(false); };
  const filtered = f.namespace || f.reason || f.query.trim() || !f.system || f.recentOnly;
  const shown = all ? rows : rows.slice(0, FIRST_ROWS);
  const reasonChips = moreReasons ? summary.reasons : summary.reasons.slice(0, REASON_CHIPS);
  const recentAll = d.events.filter((e) => isRecent(e, now)).length;
  const why = f.reason && knownReason(f.reason) ? t(`ob.ev.why.${f.reason}`) : null;
  const total = d.total ?? d.events.length;

  return (
    <Panel className={styles.ev} title={title}
      sub={t("ob.ev.sub", { rows: summary.rows, recent: summary.recent, ns: summary.namespaces, objects: summary.objects })}
      actions={<>
        <Segmented label={t("ob.ev.sort")} value={sort} onChange={setSort}
          items={[{ id: "recent", label: t("ob.ev.sort.recent") }, { id: "count", label: t("ob.ev.sort.count") }]} />
        {rows.length ? <CopyButton text={shown.map(eventLine).join("\n")} label={t("ob.ev.copy")} copiedLabel={t("ob.ev.copied")} /> : null}
      </>}
      footer={
        <span className={styles.evFoot}>
          {range.to !== null ? `${t("ob.ev.pastRange")} · ` : ""}
          {t("ob.ev.asOf", { at: new Date(d.generatedAt).toLocaleTimeString(dateLocale(locale)) })}
          {" · "}<span title={t("ob.ev.ttlHint")}>{t("ob.ev.ttl")}</span>
          {" · "}{t(d.messages ? "ob.hm.eventsHint" : "ob.hm.eventsHintViewer")}
          {d.truncated ? ` · ${t("ob.ev.truncated")}` : total > d.events.length ? ` · ${t("ob.ev.limited", { n: d.events.length, total })}` : ""}
        </span>
      }>
      <div className={styles.evFilters}>
        <Select label={t("ob.ev.namespace")} hideLabel value={f.namespace} onChange={(v) => set({ namespace: v })}
          options={[
            { value: "", label: t("ob.ev.allNs", { n: namespaces.length }) },
            ...namespaces.map((n) => ({
              value: n.namespace, label: t("ob.ev.nsOption", { ns: n.namespace || t("ob.ev.clusterScope"), n: n.rows }),
              group: n.system ? t("ob.ev.group.system") : t("ob.ev.group.apps"),
            })),
          ]} />
        <SearchInput label={t("ob.ev.search")} value={f.query} onChange={(v) => set({ query: v })} placeholder={t("ob.ev.searchPh")} />
        <Toggle checked={f.system} onChange={(v) => set({ system: v })}>{t("ob.ev.system")}</Toggle>
        <FilterChip pressed={f.recentOnly} onClick={() => set({ recentOnly: !f.recentOnly })} title={t("ob.ev.recentHint")}>
          {t("ob.ev.recentOnly", { n: recentAll })}
        </FilterChip>
        {filtered ? <LinkButton onClick={() => { setF(NO_FILTER); setAll(false); }}>{t("ob.ev.clear")}</LinkButton> : null}
      </div>

      {summary.reasons.length > 0 && (
        <div className={styles.evReasons} role="group" aria-label={t("ob.ev.col.reason")}>
          {reasonChips.map((r) => (
            <FilterChip key={r.reason} pressed={f.reason === r.reason} onClick={() => set({ reason: f.reason === r.reason ? "" : r.reason })}
              title={knownReason(r.reason) ? t(`ob.ev.why.${r.reason}`) : t("ob.ev.reasonUnknown")}>
              {r.reason} <span className={styles.evN}>{r.rows}</span>
            </FilterChip>
          ))}
          {summary.reasons.length > REASON_CHIPS ? (
            <LinkButton tone="muted" ariaExpanded={moreReasons} onClick={() => setMoreReasons(!moreReasons)}>
              {moreReasons ? t("ob.ev.fewer") : `+${summary.reasons.length - REASON_CHIPS}`}
            </LinkButton>
          ) : null}
        </div>
      )}
      {f.reason ? (
        <p className={styles.evWhy}><strong>{f.reason}</strong> — {why ?? t("ob.ev.reasonUnknown")}</p>
      ) : null}

      {d.events.length === 0 ? (
        <EmptyState title={t("ob.ev.none")}>{t("ob.ev.noneHint")}</EmptyState>
      ) : rows.length === 0 ? (
        <EmptyState title={t("ob.ev.noMatch")}>{t("ob.ev.noMatchHint")}</EmptyState>
      ) : (
        <div className={styles.evScroll}>
          <table className={styles.evTable}>
            <thead>
              <tr>
                <th scope="col">{t("ob.ev.col.last")}</th>
                <th scope="col">{t("ob.ev.col.ns")}</th>
                <th scope="col">{t("ob.ev.col.object")}</th>
                <th scope="col">{t("ob.ev.col.reason")}</th>
                <th scope="col">{t("ob.ev.col.count")}</th>
                <th scope="col">{t("ob.ev.col.message")}</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((e, i) => {
                const recent = isRecent(e, now);
                return (
                  <tr key={`${e.namespace}|${e.kind}|${e.name}|${e.reason}|${e.time}|${i}`} data-recent={recent || undefined}>
                    <td className={styles.evTime} title={when(e.time)}>
                      {recent ? <Chip level="warn">{t("ob.ev.now")}</Chip> : null}
                      <span>{ago(e.time)}</span>
                    </td>
                    <td className={styles.evNs}>{e.namespace || t("ob.ev.clusterScope")}</td>
                    <td className={styles.evObj}>
                      <span className={styles.evKind}>{e.kind}/</span>{e.name}
                      {e.component ? <span className={styles.evSub}>{t("ob.ev.by", { c: e.component })}</span> : null}
                    </td>
                    <td>
                      <LinkButton onClick={() => set({ reason: f.reason === e.reason ? "" : e.reason })}
                        title={knownReason(e.reason) ? t(`ob.ev.why.${e.reason}`) : t("ob.ev.reasonTitle")}>
                        {e.reason}
                      </LinkButton>
                    </td>
                    <td className={styles.evCount}
                      title={e.firstTime && e.firstTime !== e.time ? t("ob.ev.countTitle", { n: e.count, first: when(e.firstTime) }) : undefined}>
                      ×{e.count}
                      {e.firstTime && e.firstTime !== e.time ? <span className={styles.evSub}>{t("ob.ev.since", { ago: ago(e.firstTime) })}</span> : null}
                    </td>
                    <td className={styles.evMsg}>{e.message ?? <span className={styles.evSub}>{d.messages ? "—" : t("ob.ev.msgHidden")}</span>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {rows.length > shown.length ? (
            <div className={styles.evMore}><LinkButton onClick={() => setAll(true)}>{t("ob.ev.more", { n: rows.length })}</LinkButton></div>
          ) : null}
        </div>
      )}
    </Panel>
  );
}
