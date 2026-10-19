"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { HealthCoverage, HealthSummary, ResourceHealthStatus } from "@aud/types";
import { Panel } from "@/components/ui";
import { dateLocale, useI18n } from "@/lib/i18n";
import { rgba } from "@/lib/palette";
import { groupKey, isUnlistedUnknown, isUserInitiated, type HeatmapGroupBy } from "@/lib/healthHeatmap";
import { armType, typeName } from "@/lib/azureTypes";
import { HealthHeatmap, type HeatmapGroupFilter } from "./HealthHeatmap";
import styles from "./styles.module.css";

type HealthState = ResourceHealthStatus["availabilityState"];
type FilterState = "all" | HealthState;

const STATE_COLORS: Record<HealthState, string> = {
  Available: rgba("ok", 0.8),
  Degraded: rgba("warning", 0.8),
  Unavailable: rgba("danger", 0.8),
  Unknown: rgba("ink", 0.3),
};

const STATE_STYLE: Record<HealthState, string> = {
  Available: styles.stateAvailable ?? "",
  Degraded: styles.stateDegraded ?? "",
  Unavailable: styles.stateUnavailable ?? "",
  Unknown: styles.stateUnknown ?? "",
};

const REASON_TYPE_STYLE: Record<string, string> = {
  Unplanned: rgba("danger", 0.82),
  Planned: rgba("accent", 0.82),
  UserInitiated: rgba("ink", 0.5),
  "Customer Initiated": rgba("ink", 0.5),
};

const STATES: HealthState[] = ["Available", "Degraded", "Unavailable", "Unknown"];

/**
 * Instance tab: one overview row (donut + the four counts Azure returned), the heatmap, the list, and what Resource
 * Health does not cover. Counts are Azure's — a user-initiated Unavailable (stopped VM) is still counted Unavailable,
 * shown apart only by Azure's reasonType. Nothing is guessed: Unknown shows Azure's own text, uncovered types are
 * counted against Microsoft's supported list.
 */
export function InstanceHealthPanel({
  data, loading, error, coverage,
}: {
  data: HealthSummary | null;
  loading: boolean;
  error: string | null;
  coverage: HealthCoverage | null;
}) {
  const { t, locale } = useI18n();
  const [filter, setFilter] = useState<FilterState>("all");
  const [excludeUser, setExcludeUser] = useState(false);
  const [by, setBy] = useState<HeatmapGroupBy>("type");
  // One group filter: the heatmap's "표시 범위", a group header, and the list chip all read and write it
  const [groupFilter, setGroupFilter] = useState<HeatmapGroupFilter | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [coverageOpen, setCoverageOpen] = useState(false);
  // Bumped on every tile click: the selected row replays its flash even when the same tile is clicked again
  const [flashSeq, setFlashSeq] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);

  // Types not on Microsoft's supported list — only when coverage was read whole (else every Unknown stays "?")
  const unlisted = useMemo<ReadonlySet<string>>(
    () => new Set(coverage && !coverage.gaps.length ? coverage.types.filter((x) => x.bucket === "statusUnlisted").map((x) => x.type) : []),
    [coverage],
  );
  const unlistedCount = useMemo(() => (data?.resources ?? []).filter((r) => isUnlistedUnknown(r, unlisted)).length, [data, unlisted]);
  const selected = selectedId ? data?.resources.find((x) => x.resourceId === selectedId) ?? null : null;

  const userCount = useMemo(() => (data?.resources ?? []).filter(isUserInitiated).length, [data]);
  const filtered = useMemo(() => {
    if (!data) return [];
    return data.resources.filter((r) =>
      (filter === "all" || r.availabilityState === filter)
      && (!excludeUser || !isUserInitiated(r))
      && (!groupFilter || groupKey(r, groupFilter.by) === groupFilter.key));
  }, [data, filter, excludeUser, groupFilter]);

  const selectTile = (resourceId: string) => {
    const r = data?.resources.find((x) => x.resourceId === resourceId);
    if (!r) return;
    // A filter that hides the resource is cleared, so its row can be shown
    if (filter !== "all" && r.availabilityState !== filter) setFilter("all");
    if (excludeUser && isUserInitiated(r)) setExcludeUser(false);
    if (groupFilter && groupKey(r, groupFilter.by) !== groupFilter.key) setGroupFilter(null);
    setSelectedId(resourceId);
    setFlashSeq((n) => n + 1);
  };
  // The row is centred inside the list's own scroll box (the page does not jump); the pinned card only comes into view
  useEffect(() => {
    if (!selectedId) return;
    const box = listRef.current;
    const row = box?.querySelector<HTMLElement>(`[data-rid="${CSS.escape(selectedId)}"]`);
    const reduced = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (box && row) box.scrollTo({ top: row.offsetTop - (box.clientHeight - row.offsetHeight) / 2, behavior: reduced ? "auto" : "smooth" });
    cardRef.current?.scrollIntoView({ block: "nearest", behavior: reduced ? "auto" : "smooth" });
  }, [selectedId, flashSeq]);
  // Esc clears the selection
  useEffect(() => {
    if (!selectedId) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setSelectedId(null); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectedId]);

  const total = data ? data.available + data.degraded + data.unavailable + data.unknown : 0;
  const counts: Record<HealthState, number> = { Available: data?.available ?? 0, Degraded: data?.degraded ?? 0, Unavailable: data?.unavailable ?? 0, Unknown: data?.unknown ?? 0 };

  const segments = useMemo(() => {
    if (!data || total === 0) return [];
    const n: Record<HealthState, number> = { Available: data.available, Degraded: data.degraded, Unavailable: data.unavailable, Unknown: data.unknown };
    const R = 58;
    const C = 2 * Math.PI * R;
    let accumulated = 0;
    return STATES.filter((s) => n[s] > 0).map((state) => {
      const frac = n[state] / total;
      const seg = { state, color: STATE_COLORS[state], dashLen: frac * C, dashOffset: -accumulated * C, circumference: C, R };
      accumulated += frac;
      return seg;
    });
  }, [data, total]);

  if (loading) return (
    <div className={styles.loadingSkeleton}>
      <div className={styles.spinnerRow}>
        <div className={styles.spinner} />
        <span className={styles.spinnerLabel}>{t("health.loading")}</span>
      </div>
      <div className={styles.shimmerStrip}>
        {[0, 1, 2, 3].map((i) => <div key={i} className={`${styles.shimmerBar} ${styles.shimmerStat}`} />)}
      </div>
      <div className={`${styles.shimmerBar} ${styles.shimmerTable}`} />
    </div>
  );
  if (error) return <div className={styles.error}>{t("health.error")}: {error}</div>;

  const signin = data?.note === "signin_required";
  const hasFallbackNote = data?.note && (signin || data.note.includes("mock") || data.note.includes("timed out") || data.note.includes("error"));
  const uncovered = coverage ? coverage.types.filter((x) => x.bucket !== "statusUnlisted") : [];

  const coverageFooter = coverage ? (
    <div className={styles.coverageNote}>
      {coverage.gaps.length ? (
        <span>{t("health.coverage.gap")}</span>
      ) : (
        <>
          <span>{t("health.coverage.notice", { n: coverage.noStatusResources, k: uncovered.length, total: coverage.inventoryResources })}</span>
          <button type="button" className={styles.linkBtn} aria-expanded={coverageOpen} onClick={() => setCoverageOpen((v) => !v)}>
            {coverageOpen ? t("health.coverage.hide") : t("health.coverage.show")}
          </button>
        </>
      )}
      <a className={styles.linkBtn} href={coverage.doc.url} target="_blank" rel="noreferrer">{t("health.coverage.docLink", { date: coverage.doc.date })}</a>
    </div>
  ) : null;

  return (
    <div className={styles.grid}>
      {hasFallbackNote && (
        <div className={styles.fallbackNotice}>
          <div className={styles.fallbackNoticeIcon}>!</div>
          <div>
            <div className={styles.fallbackNoticeText}>
              {signin ? t("common.sampleData")
                : data.note!.includes("timed out") ? t("health.timeoutFallback")
                : data.note!.includes("mock") ? t("health.mockFallback")
                : t("health.errorFallback")}
            </div>
            <div className={styles.fallbackNoticeHint}>{signin ? t("auth.signinForReal") : data.note}</div>
          </div>
        </div>
      )}

      {data?.note?.includes("mock") && (
        <div className={styles.permissionsBox}>
          <div className={styles.permissionsTitle}>{t("health.permissionsRequired")}</div>
          <div className={styles.permissionsBody}>
            <p>{t("health.permissionsNote")}</p>
            <ul>
              <li><code>AZURE_AD_TENANT_ID</code>, <code>AZURE_AD_CLIENT_ID</code>, <code>AZURE_AD_CLIENT_SECRET</code></li>
              <li><code>AZURE_SUBSCRIPTION_IDS</code> — {t("health.perm.subs")}</li>
              <li>RBAC: <strong>Reader</strong> {t("health.perm.reader")} (<code>Microsoft.ResourceHealth/availabilityStatuses/read</code>)</li>
            </ul>
          </div>
        </div>
      )}

      {/* Overview: the donut and the four counts in one row — the same numbers, one place */}
      <section className={styles.overview} aria-label={t("health.healthDistribution")}>
        <div className={styles.overviewDonut}>
          <div className={styles.donutWrap}>
            <svg className={styles.donutSvg} width="128" height="128" viewBox="0 0 140 140" aria-hidden="true">
              <circle fill="none" stroke={rgba("ink", 0.06)} strokeWidth="12" cx="70" cy="70" r="58" />
              {segments.map((seg) => (
                <circle key={seg.state} fill="none" stroke={seg.color} strokeWidth="12" cx="70" cy="70" r={seg.R}
                  strokeDasharray={`${seg.dashLen} ${seg.circumference - seg.dashLen}`} strokeDashoffset={seg.dashOffset} strokeLinecap="butt" />
              ))}
            </svg>
            <div className={styles.donutCenter}>
              <div className={styles.donutTotal}>{total}</div>
              <div className={styles.donutLabel}>{t("health.resources")}</div>
            </div>
          </div>
        </div>
        <div className={styles.overviewStats}>
          {(["Available", "Degraded", "Unavailable", "Unknown"] as const).map((s) => (
            <div key={s} className={styles.statCard}>
              <div className={styles.statDot} style={{ background: STATE_COLORS[s] }} />
              <div className={styles.statCount} style={{ color: STATE_COLORS[s] }}>{counts[s]}</div>
              <div className={styles.statLabel}>{t(`health.state.${s}`)}</div>
              {s === "Unavailable" && userCount > 0 ? (
                <div className={styles.statSub} title={t("health.userInitiated.hint")}>{t("health.userInitiated.sub", { n: userCount })}</div>
              ) : null}
              {s === "Unknown" && unlistedCount > 0 ? (
                <div className={styles.statSub} title={t("health.unlisted.hint", { date: coverage?.doc.date ?? "" })}>{t("health.unlisted.sub", { n: unlistedCount })}</div>
              ) : s === "Unknown" && counts.Unknown > 0 ? (
                <div className={styles.statSub} title={t("health.unknown.hint")}>{t("health.unknown.sub")}</div>
              ) : null}
            </div>
          ))}
        </div>
      </section>

      {data && data.resources.length > 0 ? (
        <HealthHeatmap
          resources={data.resources}
          by={by}
          onBy={setBy}
          scope={groupFilter}
          onScope={(g) => { setGroupFilter(g); if (g) setFilter("all"); }}
          selectedId={selectedId}
          onSelect={selectTile}
          checks={coverage?.checks ?? {}}
          unlisted={unlisted}
          unlistedDate={coverage?.doc.date}
          footer={coverageFooter}
        />
      ) : null}

      <div className={styles.tableCard}>
        <div className={styles.cardTitle}>
          <span className={styles.cardTitleMain}>
            {t("health.resources")}
            {groupFilter ? (
              <button type="button" className={styles.groupChip} onClick={() => setGroupFilter(null)} aria-label={t("health.heatmap.clearGroup")}>
                {groupFilter.label} ✕
              </button>
            ) : null}
          </span>
          <div className={styles.filterGroup}>
            {(["all", ...STATES] as FilterState[]).map((f) => (
              <button key={f} type="button" className={`${styles.filterBtn} ${filter === f ? styles.filterActive : ""}`} onClick={() => setFilter(f)}>
                {f === "all" ? `${t("health.filterAll")} (${total})` : t(`health.state.${f}`)}
              </button>
            ))}
            {userCount > 0 ? (
              <button type="button" className={`${styles.filterBtn} ${excludeUser ? styles.filterActive : ""}`} aria-pressed={excludeUser} onClick={() => setExcludeUser((v) => !v)}>
                {t("health.filter.excludeUser", { n: userCount })}
              </button>
            ) : null}
          </div>
        </div>
        {/* Selected from the heatmap: pinned above the list (outside its scroll box), Azure's fields only */}
        <div className={styles.srOnly} aria-live="polite">
          {selected ? t("health.selected.live", { name: selected.resourceName, state: t(`health.state.${selected.availabilityState}`) }) : ""}
        </div>
        {selected ? (
          <div ref={cardRef} className={styles.selectedCard}>
            <div className={styles.selectedCardHead}>
              <span className={styles.selectedPill}>{t("health.selected.title")}</span>
              <strong className={styles.selectedName}>{selected.resourceName}</strong>
              <span className={`${styles.resState} ${STATE_STYLE[selected.availabilityState]}`}>{t(`health.state.${selected.availabilityState}`)}</span>
              {isUserInitiated(selected) ? <span className={styles.reasonBadge}>{t("health.userInitiated")}</span> : null}
              {isUnlistedUnknown(selected, unlisted) ? <span className={styles.reasonBadge}>{t("health.unlisted")}</span> : null}
              <button type="button" className={styles.linkBtn} onClick={() => setSelectedId(null)}>{t("health.selected.clear")}</button>
            </div>
            <div className={styles.selectedMeta}>
              <span title={armType(selected.resourceType)}>{typeName(selected.resourceType, t)}</span>
              <span>{selected.resourceGroup}</span>
              {selected.location ? <span>{selected.location}</span> : null}
              {selected.occurredTime && selected.availabilityState !== "Available" ? <span>{t("health.occurred")}: {new Date(selected.occurredTime).toLocaleString(dateLocale(locale))}</span> : null}
            </div>
            {selected.summary ? <div className={styles.selectedSummary}><span className={styles.resSummaryLabel}>{t("health.azureSummary")}</span> {selected.summary}</div> : null}
            {!filtered.some((r) => r.resourceId === selected.resourceId) ? <div className={styles.statSub}>{t("health.selected.hidden")}</div> : null}
          </div>
        ) : null}
        <div ref={listRef} className={styles.tableBody}>
          {filtered.length > 0 ? (
            filtered.map((r) => {
              const user = isUserInitiated(r);
              const off = isUnlistedUnknown(r, unlisted);
              const isSel = selectedId === r.resourceId;
              return (
                <div
                  key={isSel ? `${r.resourceId}#${flashSeq}` : r.resourceId}
                  data-rid={r.resourceId}
                  aria-current={isSel ? "true" : undefined}
                  className={`${styles.resourceRow} ${isSel ? styles.resourceRowSelected : ""}`}
                >
                  <div className={styles.resDot} style={{ background: user ? rgba("danger", 0.4) : off ? rgba("ink", 0.12) : STATE_COLORS[r.availabilityState] }} />
                  <div className={styles.resInfo}>
                    <div className={styles.resName}>
                      {r.resourceName}
                      {isSel ? <span className={styles.selectedPill}>{t("health.selected.pill")}</span> : null}
                    </div>
                    <div className={styles.resType} title={armType(r.resourceType)}>{typeName(r.resourceType, t)}</div>
                    {r.location && <div className={styles.resLocation}>{r.location}</div>}
                  </div>
                  <div className={styles.resGroup}>{r.resourceGroup}</div>
                  <div className={styles.resRight}>
                    <div className={`${styles.resState} ${STATE_STYLE[r.availabilityState]}`}>{t(`health.state.${r.availabilityState}`)}</div>
                    {off ? <div className={styles.reasonBadge}>{t("health.unlisted")}</div> : null}
                  {r.reasonType && r.availabilityState !== "Available" && !off && (
                      <div className={styles.reasonBadge} style={{ color: REASON_TYPE_STYLE[r.reasonType] ?? "var(--muted)" }}>
                        {user ? t("health.userInitiated") : r.reasonType}
                        {r.reasonChronicity ? ` · ${r.reasonChronicity}` : ""}
                      </div>
                    )}
                  </div>
                  {r.summary && (
                    <div className={styles.resSummary}>
                      <span className={styles.resSummaryLabel}>{t("health.azureSummary")}</span> {r.summary}
                    </div>
                  )}
                  {r.occurredTime && r.availabilityState !== "Available" && (
                    <div className={styles.resOccurred}>
                      {t("health.occurred")}: {new Date(r.occurredTime).toLocaleString(dateLocale(locale))}
                    </div>
                  )}
                </div>
              );
            })
          ) : (
            <div className={styles.empty}>{loading ? t("health.loading") : t("health.noMatch")}</div>
          )}
        </div>
      </div>

      {/* What Resource Health does not answer for — counts by type against Microsoft's supported list */}
      {coverage && coverageOpen && !coverage.gaps.length ? (
        <Panel className={styles.coveragePanel} title={t("health.coverage.title")} sub={t("health.coverage.docDate", { date: coverage.doc.date })}>
          <p className={styles.coverageIntro}>{t("health.coverage.intro")}</p>
          <table className={styles.coverageTable}>
            <thead>
              <tr><th>{t("health.coverage.col.type")}</th><th>{t("health.coverage.col.count")}</th><th>{t("health.coverage.col.bucket")}</th></tr>
            </thead>
            <tbody>
              {coverage.types.map((x) => (
                <tr key={x.type}>
                  <td title={armType(x.type)}>{typeName(x.type, t)}</td>
                  <td className={styles.coverageNum}>{x.count}</td>
                  <td><span className={`${styles.coverageBucket} ${x.bucket === "noStatusListed" ? styles.coverageBucketListed : ""}`}>{t(`health.coverage.bucket.${x.bucket}`)}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      ) : null}
    </div>
  );
}
