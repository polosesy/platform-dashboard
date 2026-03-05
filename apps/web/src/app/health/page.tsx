"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import styles from "./styles.module.css";
import type {
  HealthSummary,
  ResourceHealthStatus,
  GlobalStatusResponse,
  GlobalStatusIncident,
  GlobalStatusIncidentStatus,
  ServiceHealthEventsResponse,
  ServiceHealthEvent,
  ServiceHealthEventType,
} from "@aud/types";
import { apiBaseUrl, fetchJsonWithBearer } from "@/lib/api";
import { useApiToken } from "@/lib/useApiToken";
import { useI18n } from "@/lib/i18n";

// ── Constants ──

type HealthTab = "global" | "instance" | "service";

const STATE_COLORS: Record<ResourceHealthStatus["availabilityState"], string> = {
  Available: "rgba(16, 137, 62, 0.80)",
  Degraded: "rgba(209, 132, 0, 0.80)",
  Unavailable: "rgba(216, 59, 1, 0.80)",
  Unknown: "rgba(20, 21, 23, 0.30)",
};

const STATE_STYLE: Record<ResourceHealthStatus["availabilityState"], string> = {
  Available: styles.stateAvailable ?? "",
  Degraded: styles.stateDegraded ?? "",
  Unavailable: styles.stateUnavailable ?? "",
  Unknown: styles.stateUnknown ?? "",
};

const INCIDENT_STATUS_STYLE: Record<GlobalStatusIncidentStatus, string> = {
  Active: styles.statusActive ?? "",
  Investigating: styles.statusInvestigating ?? "",
  Mitigated: styles.statusMitigated ?? "",
  Resolved: styles.statusResolved ?? "",
};

const EVENT_TYPE_STYLE: Record<ServiceHealthEventType, string> = {
  ServiceIssue: styles.eventServiceIssue ?? "",
  PlannedMaintenance: styles.eventMaintenance ?? "",
  HealthAdvisory: styles.eventAdvisory ?? "",
  SecurityAdvisory: styles.eventSecurity ?? "",
};

const EVENT_TYPE_COLORS: Record<ServiceHealthEventType, string> = {
  ServiceIssue: "rgba(216, 59, 1, 0.82)",
  PlannedMaintenance: "rgba(0, 120, 212, 0.82)",
  HealthAdvisory: "rgba(209, 132, 0, 0.82)",
  SecurityAdvisory: "rgba(112, 48, 160, 0.82)",
};

type FilterState = "all" | ResourceHealthStatus["availabilityState"];

// ── Helpers ──

function fmtRelative(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const abs = Math.abs(diff);
  const mins = Math.floor(abs / 60_000);
  const hrs = Math.floor(abs / 3_600_000);
  const days = Math.floor(abs / 86_400_000);
  const future = diff < 0;
  if (days > 0) return future ? `in ${days}d` : `${days}d ago`;
  if (hrs > 0) return future ? `in ${hrs}h` : `${hrs}h ago`;
  if (mins > 0) return future ? `in ${mins}m` : `${mins}m ago`;
  return future ? "soon" : "just now";
}

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: "short", day: "numeric",
    hour: "2-digit", minute: "2-digit",
  });
}

// ── Sub-components ──

function GlobalStatusPanel({
  data,
  loading,
  error,
}: {
  data: GlobalStatusResponse | null;
  loading: boolean;
  error: string | null;
}) {
  const { t } = useI18n();

  if (loading) return <div className={styles.empty}>{t("health.loading")}</div>;
  if (error) return <div className={styles.error}>{t("health.error")}: {error}</div>;
  if (!data) return null;

  if (data.activeIncidents === 0) {
    return (
      <div className={styles.allGoodCard}>
        <div className={styles.allGoodIcon}>✓</div>
        <div className={styles.allGoodTitle}>{t("health.allOperational")}</div>
        <div className={styles.allGoodSub}>{t("health.allOperationalSub")}</div>
        <a
          href="https://azure.status.microsoft/en-us/status"
          target="_blank"
          rel="noopener noreferrer"
          className={styles.allGoodLink}
        >
          {t("health.azureStatusLink")} →
        </a>
      </div>
    );
  }

  return (
    <div className={styles.incidentList}>
      {data.incidents.map((inc: GlobalStatusIncident) => (
        <div key={inc.id} className={styles.incidentCard}>
          <div className={styles.incidentHeader}>
            <span className={`${styles.incidentStatus} ${INCIDENT_STATUS_STYLE[inc.status]}`}>
              {t(`health.incident.${inc.status}`)}
            </span>
            <span className={styles.incidentDate}>{inc.pubDate ? fmtDate(inc.pubDate) : ""}</span>
          </div>
          <div className={styles.incidentTitle}>{inc.title}</div>
          {inc.description && (
            <div className={styles.incidentDesc}>{inc.description}</div>
          )}
          {inc.affectedRegions.length > 0 && (
            <div className={styles.badgeRow}>
              <span className={styles.badgeLabel}>{t("health.affectedRegions")}:</span>
              {inc.affectedRegions.map((r) => (
                <span key={r} className={styles.regionBadge}>{r}</span>
              ))}
            </div>
          )}
          {inc.affectedServices.length > 0 && (
            <div className={styles.badgeRow}>
              <span className={styles.badgeLabel}>{t("health.affectedServices")}:</span>
              {inc.affectedServices.map((s) => (
                <span key={s} className={styles.serviceBadge}>{s}</span>
              ))}
            </div>
          )}
          {inc.link && (
            <a
              href={inc.link}
              target="_blank"
              rel="noopener noreferrer"
              className={styles.incidentLink}
            >
              {t("health.viewDetails")} →
            </a>
          )}
        </div>
      ))}
    </div>
  );
}

function InstanceHealthPanel({
  data,
  loading,
  error,
}: {
  data: HealthSummary | null;
  loading: boolean;
  error: string | null;
}) {
  const { t } = useI18n();
  const [filter, setFilter] = useState<FilterState>("all");

  const filtered = useMemo(() => {
    if (!data) return [];
    if (filter === "all") return data.resources;
    return data.resources.filter((r) => r.availabilityState === filter);
  }, [data, filter]);

  const total = data ? data.available + data.degraded + data.unavailable + data.unknown : 0;

  const segments = useMemo(() => {
    if (!data || total === 0) return [];
    const R = 58;
    const C = 2 * Math.PI * R;
    const parts = [
      { state: "Available" as const, count: data.available, color: STATE_COLORS.Available },
      { state: "Degraded" as const, count: data.degraded, color: STATE_COLORS.Degraded },
      { state: "Unavailable" as const, count: data.unavailable, color: STATE_COLORS.Unavailable },
      { state: "Unknown" as const, count: data.unknown, color: STATE_COLORS.Unknown },
    ].filter((p) => p.count > 0);

    let accumulated = 0;
    return parts.map((p) => {
      const frac = p.count / total;
      const dashLen = frac * C;
      const dashOffset = -accumulated * C;
      accumulated += frac;
      return { ...p, dashLen, dashOffset, circumference: C, R };
    });
  }, [data, total]);

  if (loading) return <div className={styles.empty}>{t("health.loading")}</div>;
  if (error) return <div className={styles.error}>{t("health.error")}: {error}</div>;

  return (
    <div className={styles.grid}>
      {/* Summary strip */}
      <div className={styles.summaryStrip}>
        {([
          { label: "Available", count: data?.available ?? 0, color: STATE_COLORS.Available },
          { label: "Degraded", count: data?.degraded ?? 0, color: STATE_COLORS.Degraded },
          { label: "Unavailable", count: data?.unavailable ?? 0, color: STATE_COLORS.Unavailable },
          { label: "Unknown", count: data?.unknown ?? 0, color: STATE_COLORS.Unknown },
        ] as const).map((s) => (
          <div key={s.label} className={styles.statCard}>
            <div className={styles.statDot} style={{ background: s.color }} />
            <div className={styles.statCount} style={{ color: s.color }}>{s.count}</div>
            <div className={styles.statLabel}>{s.label}</div>
          </div>
        ))}
      </div>

      {/* Donut chart */}
      <div className={styles.donutCard}>
        <div className={styles.donutWrap}>
          <svg className={styles.donutSvg} width="140" height="140" viewBox="0 0 140 140">
            <circle fill="none" stroke="rgba(20,21,23,0.06)" strokeWidth="12" cx="70" cy="70" r="58" />
            {segments.map((seg) => (
              <circle
                key={seg.state}
                fill="none"
                stroke={seg.color}
                strokeWidth="12"
                cx="70" cy="70" r={seg.R}
                strokeDasharray={`${seg.dashLen} ${seg.circumference - seg.dashLen}`}
                strokeDashoffset={seg.dashOffset}
                strokeLinecap="butt"
              />
            ))}
          </svg>
          <div className={styles.donutCenter}>
            <div className={styles.donutTotal}>{total}</div>
            <div className={styles.donutLabel}>resources</div>
          </div>
        </div>
        <div className={styles.donutTitle}>{t("health.healthDistribution")}</div>
        <div className={styles.donutLegend}>
          {segments.map((seg) => (
            <div key={seg.state} className={styles.legendItem}>
              <div className={styles.legendDot} style={{ background: seg.color }} />
              {seg.count}
            </div>
          ))}
        </div>
      </div>

      {/* Resource table */}
      <div className={styles.tableCard}>
        <div className={styles.cardTitle}>
          {t("health.resources")}
          <div className={styles.filterGroup}>
            {(["all", "Available", "Degraded", "Unavailable", "Unknown"] as FilterState[]).map((f) => (
              <button
                key={f}
                type="button"
                className={`${styles.filterBtn} ${filter === f ? styles.filterActive : ""}`}
                onClick={() => setFilter(f)}
              >
                {f === "all" ? `${t("health.filterAll")} (${total})` : f}
              </button>
            ))}
          </div>
        </div>
        <div className={styles.tableBody}>
          {filtered.length > 0 ? (
            filtered.map((r) => (
              <div key={r.resourceId} className={styles.resourceRow}>
                <div className={styles.resDot} style={{ background: STATE_COLORS[r.availabilityState] }} />
                <div className={styles.resInfo}>
                  <div className={styles.resName}>{r.resourceName}</div>
                  <div className={styles.resType}>{r.resourceType}</div>
                </div>
                <div className={styles.resGroup}>{r.resourceGroup}</div>
                <div className={`${styles.resState} ${STATE_STYLE[r.availabilityState]}`}>
                  {r.availabilityState}
                </div>
                {r.summary && <div className={styles.resSummary}>{r.summary}</div>}
              </div>
            ))
          ) : (
            <div className={styles.empty}>
              {loading ? t("health.loading") : "No resources match filter."}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function ServiceStatusPanel({
  data,
  loading,
  error,
}: {
  data: ServiceHealthEventsResponse | null;
  loading: boolean;
  error: string | null;
}) {
  const { t } = useI18n();

  const eventTypeCounts = (
    [
      { type: "ServiceIssue" as const, key: "serviceIssue" as const },
      { type: "PlannedMaintenance" as const, key: "plannedMaintenance" as const },
      { type: "HealthAdvisory" as const, key: "healthAdvisory" as const },
      { type: "SecurityAdvisory" as const, key: "securityAdvisory" as const },
    ]
  );

  if (loading) return <div className={styles.empty}>{t("health.loading")}</div>;
  if (error) return <div className={styles.error}>{t("health.error")}: {error}</div>;

  return (
    <div className={styles.grid}>
      {/* Event type summary strip */}
      <div className={styles.eventSummaryStrip}>
        {eventTypeCounts.map(({ type, key }) => (
          <div key={type} className={styles.statCard}>
            <div className={styles.statDot} style={{ background: EVENT_TYPE_COLORS[type] }} />
            <div className={styles.statCount} style={{ color: EVENT_TYPE_COLORS[type] }}>
              {data?.byType[key] ?? 0}
            </div>
            <div className={styles.statLabel}>{t(`health.eventType.${type}`)}</div>
          </div>
        ))}
      </div>

      {/* Event cards */}
      {!data || data.events.length === 0 ? (
        <div className={styles.emptyEvents}>{t("health.noEvents")}</div>
      ) : (
        <div className={styles.eventList}>
          {data.events.map((evt: ServiceHealthEvent) => (
            <div key={evt.id} className={styles.eventCard}>
              <div className={styles.eventHeader}>
                <span className={`${styles.eventTypeBadge} ${EVENT_TYPE_STYLE[evt.eventType]}`}>
                  {t(`health.eventType.${evt.eventType}`)}
                </span>
                <span className={styles.eventTime}>
                  {evt.lastUpdateTime ? fmtRelative(evt.lastUpdateTime) : ""}
                </span>
              </div>

              <div className={styles.eventTitle}>{evt.title}</div>

              {evt.summary && (
                <div className={styles.eventSummary}>{evt.summary}</div>
              )}

              <div className={styles.eventMeta}>
                {evt.impactStartTime && (
                  <span className={styles.eventMetaItem}>
                    <span className={styles.eventMetaLabel}>{t("health.impactStart")}:</span>
                    <span className={styles.eventMetaValue}>{fmtDate(evt.impactStartTime)}</span>
                  </span>
                )}
                {evt.impactMitigationTime && (
                  <span className={styles.eventMetaItem}>
                    <span className={styles.eventMetaLabel}>{t("health.impactEnd")}:</span>
                    <span className={styles.eventMetaValue}>{fmtDate(evt.impactMitigationTime)}</span>
                  </span>
                )}
                {evt.lastUpdateTime && (
                  <span className={styles.eventMetaItem}>
                    <span className={styles.eventMetaLabel}>{t("health.lastUpdate")}:</span>
                    <span className={styles.eventMetaValue}>{fmtDate(evt.lastUpdateTime)}</span>
                  </span>
                )}
              </div>

              {evt.affectedRegions.length > 0 && (
                <div className={styles.badgeRow}>
                  <span className={styles.badgeLabel}>{t("health.affectedRegions")}:</span>
                  {evt.affectedRegions.map((r) => (
                    <span key={r} className={styles.regionBadge}>{r}</span>
                  ))}
                </div>
              )}

              {evt.affectedServices.length > 0 && (
                <div className={styles.badgeRow}>
                  <span className={styles.badgeLabel}>{t("health.affectedServices")}:</span>
                  {evt.affectedServices.map((s) => (
                    <span key={s} className={styles.serviceBadge}>{s}</span>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Main Page ──

export default function HealthPage() {
  const { t } = useI18n();
  const getApiToken = useApiToken();
  const [activeTab, setActiveTab] = useState<HealthTab>("global");

  // Tab 1 — Global Status
  const [globalData, setGlobalData] = useState<GlobalStatusResponse | null>(null);
  const [globalLoading, setGlobalLoading] = useState(false);
  const [globalError, setGlobalError] = useState<string | null>(null);
  const [globalLoaded, setGlobalLoaded] = useState(false);

  // Tab 2 — Instance Health
  const [instanceData, setInstanceData] = useState<HealthSummary | null>(null);
  const [instanceLoading, setInstanceLoading] = useState(false);
  const [instanceError, setInstanceError] = useState<string | null>(null);
  const [instanceLoaded, setInstanceLoaded] = useState(false);

  // Tab 3 — Service Events
  const [eventsData, setEventsData] = useState<ServiceHealthEventsResponse | null>(null);
  const [eventsLoading, setEventsLoading] = useState(false);
  const [eventsError, setEventsError] = useState<string | null>(null);
  const [eventsLoaded, setEventsLoaded] = useState(false);

  const loadGlobal = useCallback(() => {
    if (globalLoaded || globalLoading) return;
    let cancelled = false;
    setGlobalLoading(true);
    setGlobalError(null);
    fetch(`${apiBaseUrl()}/api/health/global-status`)
      .then((r) => r.json() as Promise<GlobalStatusResponse>)
      .then((d) => { if (!cancelled) { setGlobalData(d); setGlobalLoaded(true); } })
      .catch((e: unknown) => { if (!cancelled) setGlobalError(e instanceof Error ? e.message : "error"); })
      .finally(() => { if (!cancelled) setGlobalLoading(false); });
    return () => { cancelled = true; };
  }, [globalLoaded, globalLoading]);

  const loadInstance = useCallback(() => {
    if (instanceLoaded || instanceLoading) return;
    let cancelled = false;
    setInstanceLoading(true);
    setInstanceError(null);
    getApiToken()
      .then(async (token) => {
        const d = await fetchJsonWithBearer<HealthSummary>(`${apiBaseUrl()}/api/health/summary`, token);
        if (!cancelled) { setInstanceData(d); setInstanceLoaded(true); }
      })
      .catch((e: unknown) => { if (!cancelled) setInstanceError(e instanceof Error ? e.message : "error"); })
      .finally(() => { if (!cancelled) setInstanceLoading(false); });
    return () => { cancelled = true; };
  }, [instanceLoaded, instanceLoading, getApiToken]);

  const loadEvents = useCallback(() => {
    if (eventsLoaded || eventsLoading) return;
    let cancelled = false;
    setEventsLoading(true);
    setEventsError(null);
    getApiToken()
      .then(async (token) => {
        const d = await fetchJsonWithBearer<ServiceHealthEventsResponse>(`${apiBaseUrl()}/api/health/events`, token);
        if (!cancelled) { setEventsData(d); setEventsLoaded(true); }
      })
      .catch((e: unknown) => { if (!cancelled) setEventsError(e instanceof Error ? e.message : "error"); })
      .finally(() => { if (!cancelled) setEventsLoading(false); });
    return () => { cancelled = true; };
  }, [eventsLoaded, eventsLoading, getApiToken]);

  // Load on tab switch (lazy — only loads when first visited)
  useEffect(() => {
    if (activeTab === "global") loadGlobal();
    else if (activeTab === "instance") loadInstance();
    else if (activeTab === "service") loadEvents();
  }, [activeTab, loadGlobal, loadInstance, loadEvents]);

  // Preload global tab on mount
  useEffect(() => { loadGlobal(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const activeGeneratedAt =
    activeTab === "global" ? globalData?.generatedAt
    : activeTab === "instance" ? instanceData?.generatedAt
    : eventsData?.generatedAt;

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <div>
          <div className={styles.title}>{t("health.title")}</div>
          <div className={styles.subTitle}>
            {activeGeneratedAt
              ? `${t("health.generatedAt")}: ${new Date(activeGeneratedAt).toLocaleString()}`
              : t("health.loading")}
          </div>
        </div>
      </div>

      {/* Tab Bar */}
      <div className={styles.tabBar}>
        <button
          type="button"
          className={`${styles.tabBtn} ${activeTab === "global" ? styles.tabActive : ""}`}
          onClick={() => setActiveTab("global")}
        >
          {t("health.tabGlobal")}
        </button>
        <button
          type="button"
          className={`${styles.tabBtn} ${activeTab === "instance" ? styles.tabActive : ""}`}
          onClick={() => setActiveTab("instance")}
        >
          {t("health.tabInstance")}
        </button>
        <button
          type="button"
          className={`${styles.tabBtn} ${activeTab === "service" ? styles.tabActive : ""}`}
          onClick={() => setActiveTab("service")}
        >
          {t("health.tabService")}
        </button>
      </div>

      {/* Tab Content */}
      {activeTab === "global" && (
        <GlobalStatusPanel data={globalData} loading={globalLoading} error={globalError} />
      )}
      {activeTab === "instance" && (
        <InstanceHealthPanel data={instanceData} loading={instanceLoading} error={instanceError} />
      )}
      {activeTab === "service" && (
        <ServiceStatusPanel data={eventsData} loading={eventsLoading} error={eventsError} />
      )}
    </div>
  );
}
