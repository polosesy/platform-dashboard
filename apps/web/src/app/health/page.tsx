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
  AzureSubscriptionOption,
  AzureSubscriptionsResponse,
  RegionalStatusResponse,
  RegionHealthStatus,
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

function RegionCard({ region }: { region: RegionHealthStatus }) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const isAffected = region.hasActiveIssues;

  return (
    <div
      className={`${styles.regionCard} ${isAffected ? styles.regionCardAffected : styles.regionCardGood}`}
      onClick={() => isAffected && setExpanded((v) => !v)}
      style={{ cursor: isAffected ? "pointer" : "default" }}
    >
      <div className={styles.regionCardHeader}>
        <div className={styles.regionDot} data-state={isAffected ? "affected" : "ok"} />
        <span className={styles.regionName}>{region.displayName}</span>
        <span className={`${styles.regionStatusBadge} ${isAffected ? styles.regionStatusAffected : styles.regionStatusOk}`}>
          {isAffected ? t("health.regionAffected") : t("health.regionOperational")}
        </span>
      </div>
      {isAffected && (
        <div className={styles.regionIssueRow}>
          {region.serviceIssueCount > 0 && (
            <span className={styles.regionIssueChip} data-type="issue">
              {region.serviceIssueCount} {t("health.regionServiceIssue")}
            </span>
          )}
          {region.maintenanceCount > 0 && (
            <span className={styles.regionIssueChip} data-type="maintenance">
              {region.maintenanceCount} {t("health.regionMaintenance")}
            </span>
          )}
          {region.affectedServices.length > 0 && (
            <div className={styles.regionServices}>
              {region.affectedServices.map((s) => (
                <span key={s} className={styles.serviceBadge}>{s}</span>
              ))}
            </div>
          )}
        </div>
      )}
      {expanded && region.events.length > 0 && (
        <div className={styles.regionEventsExpanded}>
          {region.events.filter((e) => !e.isResolved).map((evt) => (
            <div key={evt.id} className={styles.regionEventItem}>
              <span className={`${styles.eventTypeBadge} ${EVENT_TYPE_STYLE[evt.eventType]}`}>
                {evt.eventType.replace(/([A-Z])/g, " $1").trim()}
              </span>
              <span className={styles.regionEventTitle}>{evt.title}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function GlobalStatusPanel({
  data,
  loading,
  error,
  regionalData,
  regionalLoading,
}: {
  data: GlobalStatusResponse | null;
  loading: boolean;
  error: string | null;
  regionalData: RegionalStatusResponse | null;
  regionalLoading: boolean;
}) {
  const { t } = useI18n();

  if (loading) return <div className={styles.empty}>{t("health.loading")}</div>;
  if (error) return <div className={styles.error}>{t("health.error")}: {error}</div>;
  if (!data) return null;

  const hasRegions = regionalData && regionalData.regions.length > 0;

  return (
    <div className={styles.globalLayout}>
      {/* ── Your Deployed Regions ── */}
      <section className={styles.regionalSection}>
        <div className={styles.sectionHeader}>
          <div className={styles.sectionTitle}>{t("health.yourRegions")}</div>
          <div className={styles.sectionSub}>{t("health.yourRegionsSub")}</div>
        </div>
        {regionalLoading ? (
          <div className={styles.empty}>{t("health.loading")}</div>
        ) : hasRegions ? (
          <>
            {regionalData.totalAffected > 0 && (
              <div className={styles.regionAffectedBanner}>
                {regionalData.totalAffected}개 리전에 활성 이슈가 있습니다
              </div>
            )}
            <div className={styles.regionGrid}>
              {regionalData.regions.map((region) => (
                <RegionCard key={region.name} region={region} />
              ))}
            </div>
            {regionalData.note && (
              <div className={styles.regionalNote}>{regionalData.note}</div>
            )}
          </>
        ) : (
          <div className={styles.empty}>{t("health.permissionsNote")}</div>
        )}
      </section>

      {/* ── Global Incidents (RSS) ── */}
      <section>
        <div className={styles.sectionHeader}>
          <div className={styles.sectionTitle}>{t("health.globalIncidents")}</div>
        </div>
        {data.activeIncidents === 0 ? (
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
        ) : (
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
        )}
      </section>
    </div>
  );
}

const REASON_TYPE_STYLE: Record<string, string> = {
  Unplanned: "rgba(216, 59, 1, 0.82)",
  Planned: "rgba(0, 120, 212, 0.82)",
  UserInitiated: "rgba(20, 21, 23, 0.50)",
};

function InstanceHealthPanel({
  data,
  loading,
  error,
  subscriptions,
  subscriptionId,
  onSubscriptionChange,
}: {
  data: HealthSummary | null;
  loading: boolean;
  error: string | null;
  subscriptions: AzureSubscriptionOption[];
  subscriptionId: string;
  onSubscriptionChange: (id: string) => void;
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
      {/* Subscription selector */}
      {subscriptions.length > 0 && (
        <div className={styles.instanceHeader}>
          <span className={styles.instanceHeaderLabel}>{t("live.subscription")}</span>
          <select
            className={styles.subSelect}
            value={subscriptionId}
            onChange={(e) => onSubscriptionChange(e.target.value)}
          >
            <option value="">{t("health.allSubscriptions")}</option>
            {subscriptions.map((s) => (
              <option key={s.subscriptionId} value={s.subscriptionId}>
                {s.name || s.subscriptionId}
              </option>
            ))}
          </select>
          {data?.note && (
            <span className={styles.instanceNote}>{data.note}</span>
          )}
        </div>
      )}

      {/* Permissions guidance when showing mock data */}
      {data?.note?.includes("mock") && (
        <div className={styles.permissionsBox}>
          <div className={styles.permissionsTitle}>{t("health.permissionsRequired")}</div>
          <div className={styles.permissionsBody}>
            <p>{t("health.permissionsNote")}</p>
            <ul>
              <li><code>AZURE_AD_TENANT_ID</code>, <code>AZURE_AD_CLIENT_ID</code>, <code>AZURE_AD_CLIENT_SECRET</code></li>
              <li><code>AZURE_SUBSCRIPTION_IDS</code> — comma-separated subscription IDs</li>
              <li>RBAC: <strong>Reader</strong> role on each subscription (includes <code>Microsoft.ResourceHealth/availabilityStatuses/read</code>)</li>
            </ul>
          </div>
        </div>
      )}

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
                  {r.location && (
                    <div className={styles.resLocation}>{r.location}</div>
                  )}
                </div>
                <div className={styles.resGroup}>{r.resourceGroup}</div>
                <div className={styles.resRight}>
                  <div className={`${styles.resState} ${STATE_STYLE[r.availabilityState]}`}>
                    {r.availabilityState}
                  </div>
                  {r.reasonType && r.availabilityState !== "Available" && (
                    <div
                      className={styles.reasonBadge}
                      style={{ color: REASON_TYPE_STYLE[r.reasonType] ?? "var(--muted)" }}
                    >
                      {r.reasonType}
                      {r.reasonChronicity ? ` · ${r.reasonChronicity}` : ""}
                    </div>
                  )}
                </div>
                {r.summary && <div className={styles.resSummary}>{r.summary}</div>}
                {r.occurredTime && r.availabilityState !== "Available" && (
                  <div className={styles.resOccurred}>
                    {t("health.occurred")}: {fmtDate(r.occurredTime)}
                  </div>
                )}
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

const EVENT_SECTION: Record<ServiceHealthEventType, string> = {
  ServiceIssue: "serviceIssues",
  PlannedMaintenance: "plannedMaintenance",
  HealthAdvisory: "healthAdvisory",
  SecurityAdvisory: "securityAdvisory",
};

function eventPortalUrl(evt: ServiceHealthEvent, tenantId?: string): string {
  // Tenant-prefixed portal URL forces login in the correct tenant context.
  // Format: portal.azure.com/{tenantId}/#view/{extension}/{blade}/{params...}
  const portalBase = tenantId
    ? `https://portal.azure.com/${encodeURIComponent(tenantId)}`
    : "https://portal.azure.com";
  // Deep-link to the specific event — use EventDetailsBlade (plural, required by Azure Health extension v1.1+)
  // isRCA/false is a required parameter; omitting it causes the blade script to 404.
  if (evt.id && !evt.id.startsWith("0.") && !evt.id.startsWith("mock-")) {
    return `${portalBase}/#view/Microsoft_Azure_Health/EventDetailsBlade/trackingId/${encodeURIComponent(evt.id)}/isRCA/false`;
  }
  // Fall back to the category browse page
  return `${portalBase}/#view/Microsoft_Azure_Health/AzureHealthBrowseBlade/~/${EVENT_SECTION[evt.eventType]}`;
}

type EventTranslation = { title: string; summary: string };

function EventCard({
  evt,
  tenantId,
  translation,
  showTranslation,
}: {
  evt: ServiceHealthEvent;
  tenantId?: string;
  translation?: EventTranslation;
  showTranslation?: boolean;
}) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const toggle = () => setExpanded((v) => !v);

  const LEVEL_STYLE: Record<string, string> = {
    Error: styles.levelError ?? "",
    Warning: styles.levelWarning ?? "",
    Informational: styles.levelInfo ?? "",
  };

  const displayTitle = showTranslation && translation ? translation.title : evt.title;
  const displaySummary = showTranslation && translation ? translation.summary : (evt.summary ?? "");

  return (
    <div className={`${styles.eventCard} ${expanded ? styles.eventCardExpanded : ""}`}>
      {/* ── Header row (always visible, clickable) ── */}
      <button type="button" className={styles.eventCardBtn} onClick={toggle} aria-expanded={expanded}>
        <div className={styles.eventCardBtnLeft}>
          <span className={`${styles.eventTypeBadge} ${EVENT_TYPE_STYLE[evt.eventType]}`}>
            {t(`health.eventType.${evt.eventType}`)}
          </span>
          <span className={`${styles.eventLevelBadge} ${LEVEL_STYLE[evt.level] ?? ""}`}>
            {evt.level}
          </span>
          {evt.isResolved && (
            <span className={styles.resolvedBadge}>{t("health.incident.Resolved")}</span>
          )}
          {showTranslation && translation && (
            <span className={styles.translatedBadge}>KO</span>
          )}
        </div>
        <div className={styles.eventCardBtnRight}>
          <span className={styles.eventTime}>
            {evt.lastUpdateTime ? fmtRelative(evt.lastUpdateTime) : ""}
          </span>
          <span className={styles.eventChevron}>{expanded ? "▲" : "▼"}</span>
        </div>
      </button>

      {/* ── Title ── */}
      <div className={styles.eventTitle} onClick={toggle} style={{ cursor: "pointer" }}>
        {displayTitle}
      </div>

      {/* ── Summary (truncated when collapsed) ── */}
      {displaySummary && (
        <div className={`${styles.eventSummary} ${!expanded ? styles.eventSummaryClamp : ""}`}>
          {displaySummary}
        </div>
      )}

      {/* ── Collapsed hint: top regions/services ── */}
      {!expanded && (evt.affectedRegions.length > 0 || evt.affectedServices.length > 0) && (
        <div className={styles.eventCollapsedHint} onClick={toggle}>
          {evt.affectedRegions.slice(0, 4).map((r) => (
            <span key={r} className={styles.regionBadge}>{r}</span>
          ))}
          {evt.affectedRegions.length > 4 && (
            <span className={styles.moreBadge}>+{evt.affectedRegions.length - 4}</span>
          )}
          {evt.affectedServices.slice(0, 2).map((s) => (
            <span key={s} className={styles.serviceBadge}>{s}</span>
          ))}
          {evt.affectedServices.length > 2 && (
            <span className={styles.moreBadge}>+{evt.affectedServices.length - 2}</span>
          )}
          <span className={styles.expandHint}>{t("health.clickToExpand")}</span>
        </div>
      )}

      {/* ── Expanded detail ── */}
      {expanded && (
        <div className={styles.eventDetail}>
          {/* Timestamps — timeline grid */}
          {(evt.impactStartTime || evt.impactMitigationTime || evt.lastUpdateTime) && (
            <div className={styles.timestampGrid}>
              {evt.impactStartTime && (
                <div className={styles.timestampItem}>
                  <div className={styles.timestampDot} data-kind="start" />
                  <span className={styles.timestampLabel}>{t("health.impactStart")}</span>
                  <span className={styles.timestampValue}>{fmtDate(evt.impactStartTime)}</span>
                </div>
              )}
              {evt.impactMitigationTime && (
                <div className={styles.timestampItem}>
                  <div className={styles.timestampDot} data-kind="end" />
                  <span className={styles.timestampLabel}>{t("health.impactEnd")}</span>
                  <span className={styles.timestampValue}>{fmtDate(evt.impactMitigationTime)}</span>
                </div>
              )}
              {evt.lastUpdateTime && (
                <div className={styles.timestampItem}>
                  <div className={styles.timestampDot} data-kind="update" />
                  <span className={styles.timestampLabel}>{t("health.lastUpdate")}</span>
                  <span className={styles.timestampValue}>{fmtDate(evt.lastUpdateTime)}</span>
                </div>
              )}
            </div>
          )}

          {/* Affected regions */}
          {evt.affectedRegions.length > 0 && (
            <div className={styles.badgeRow}>
              <span className={styles.badgeLabel}>{t("health.affectedRegions")}:</span>
              {evt.affectedRegions.map((r) => (
                <span key={r} className={styles.regionBadge}>{r}</span>
              ))}
            </div>
          )}

          {/* Affected services */}
          {evt.affectedServices.length > 0 && (
            <div className={styles.badgeRow}>
              <span className={styles.badgeLabel}>{t("health.affectedServices")}:</span>
              {evt.affectedServices.map((s) => (
                <span key={s} className={styles.serviceBadge}>{s}</span>
              ))}
            </div>
          )}

          {/* Portal link — tenant-aware URL forces login in the correct tenant */}
          <a
            href={eventPortalUrl(evt, tenantId)}
            target="_blank"
            rel="noopener noreferrer"
            className={styles.eventPortalLink}
          >
            {t("health.viewInPortal")} →
          </a>
        </div>
      )}
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
  const getApiToken = useApiToken();

  // ── Translation state ──
  const [showKorean, setShowKorean] = useState(false);
  const [translating, setTranslating] = useState(false);
  const [translateNote, setTranslateNote] = useState<string | null>(null);
  const [translationMap, setTranslationMap] = useState<Map<string, EventTranslation>>(new Map());

  const handleTranslateToggle = useCallback(async (toKorean: boolean) => {
    if (!toKorean) { setShowKorean(false); return; }
    if (!data || data.events.length === 0) { setShowKorean(true); return; }

    const allCached = data.events.every((evt) => translationMap.has(evt.id));
    if (allCached) { setShowKorean(true); return; }

    setTranslating(true);
    setTranslateNote(null);
    try {
      const token = await getApiToken().catch(() => null);
      // Flat array: [title0, summary0, title1, summary1, ...]
      const texts = data.events.flatMap((evt) => [evt.title, evt.summary ?? ""]);
      const resp = await fetchJsonWithBearer<{ translations?: string[]; error?: string }>(
        `${apiBaseUrl()}/api/health/translate`,
        token,
        { method: "POST", body: JSON.stringify({ texts, to: "ko" }) },
      );
      if (resp.error === "not_configured") {
        setTranslateNote("not_configured");
      } else if (resp.error) {
        setTranslateNote("error");
      } else if (resp.translations) {
        const newMap = new Map(translationMap);
        data.events.forEach((evt, i) => {
          newMap.set(evt.id, {
            title: resp.translations![i * 2] ?? evt.title,
            summary: resp.translations![i * 2 + 1] ?? (evt.summary ?? ""),
          });
        });
        setTranslationMap(newMap);
        setShowKorean(true);
      }
    } catch {
      setTranslateNote("error");
    } finally {
      setTranslating(false);
    }
  }, [data, translationMap, getApiToken]);

  const eventTypeCounts = [
    { type: "ServiceIssue" as const, key: "serviceIssue" as const },
    { type: "PlannedMaintenance" as const, key: "plannedMaintenance" as const },
    { type: "HealthAdvisory" as const, key: "healthAdvisory" as const },
    { type: "SecurityAdvisory" as const, key: "securityAdvisory" as const },
  ];

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

      {/* ── Translation toggle row ── */}
      {data && data.events.length > 0 && (
        <div className={styles.translateRow}>
          <div className={styles.translateToggle}>
            <button
              type="button"
              className={`${styles.translateToggleBtn} ${!showKorean ? styles.translateToggleBtnActive : ""}`}
              onClick={() => void handleTranslateToggle(false)}
              disabled={translating}
            >
              EN
            </button>
            <button
              type="button"
              className={`${styles.translateToggleBtn} ${showKorean ? styles.translateToggleBtnActive : ""}`}
              onClick={() => void handleTranslateToggle(true)}
              disabled={translating}
            >
              한
            </button>
          </div>
          {translating && (
            <span className={styles.translateSpinner}>{t("health.translating")}</span>
          )}
          {translateNote === "not_configured" && (
            <span className={styles.translateNote}>{t("health.translateNotConfigured")}</span>
          )}
          {translateNote === "error" && (
            <span className={styles.translateNote}>{t("health.translateError")}</span>
          )}
        </div>
      )}

      {/* Event cards */}
      {!data || data.events.length === 0 ? (
        <div className={styles.emptyEvents}>{t("health.noEvents")}</div>
      ) : (
        <div className={styles.eventList}>
          {data.events.map((evt: ServiceHealthEvent) => (
            <EventCard
              key={evt.id}
              evt={evt}
              tenantId={data.tenantId}
              translation={translationMap.get(evt.id)}
              showTranslation={showKorean}
            />
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

  // Subscriptions list (shared across tabs)
  const [subscriptions, setSubscriptions] = useState<AzureSubscriptionOption[]>([]);
  const [subscriptionId, setSubscriptionId] = useState("");

  // Tab 1 — Global Status
  const [globalData, setGlobalData] = useState<GlobalStatusResponse | null>(null);
  const [globalLoading, setGlobalLoading] = useState(false);
  const [globalError, setGlobalError] = useState<string | null>(null);
  const [globalLoaded, setGlobalLoaded] = useState(false);

  // Tab 1 supplement — Regional Status
  const [regionalData, setRegionalData] = useState<RegionalStatusResponse | null>(null);
  const [regionalLoading, setRegionalLoading] = useState(false);
  const [regionalLoaded, setRegionalLoaded] = useState(false);

  // Tab 2 — Instance Health
  const [instanceData, setInstanceData] = useState<HealthSummary | null>(null);
  const [instanceLoading, setInstanceLoading] = useState(false);
  const [instanceError, setInstanceError] = useState<string | null>(null);

  // Tab 3 — Service Events
  const [eventsData, setEventsData] = useState<ServiceHealthEventsResponse | null>(null);
  const [eventsLoading, setEventsLoading] = useState(false);
  const [eventsError, setEventsError] = useState<string | null>(null);
  const [eventsLoaded, setEventsLoaded] = useState(false);

  // Fetch subscriptions on mount
  useEffect(() => {
    let cancelled = false;
    getApiToken()
      .catch(() => null)
      .then((token) =>
        fetchJsonWithBearer<AzureSubscriptionsResponse>(`${apiBaseUrl()}/api/azure/subscriptions`, token),
      )
      .then((resp) => {
        if (cancelled) return;
        const subs = resp.subscriptions ?? [];
        setSubscriptions(subs);
        setSubscriptionId((prev) => prev || subs[0]?.subscriptionId || "");
      })
      .catch(() => { /* ignore — subscriptions are optional */ });
    return () => { cancelled = true; };
  }, [getApiToken]);

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

  const loadRegional = useCallback((subId?: string) => {
    if (regionalLoaded || regionalLoading) return;
    let cancelled = false;
    setRegionalLoading(true);
    const url = subId
      ? `${apiBaseUrl()}/api/health/regional-status?subscriptionId=${encodeURIComponent(subId)}`
      : `${apiBaseUrl()}/api/health/regional-status`;
    getApiToken()
      .catch(() => null)
      .then(async (token) => {
        const d = await fetchJsonWithBearer<RegionalStatusResponse>(url, token);
        if (!cancelled) { setRegionalData(d); setRegionalLoaded(true); }
      })
      .catch(() => {
        // Mark as loaded even on error so we don't retry and show the fallback message
        if (!cancelled) setRegionalLoaded(true);
      })
      .finally(() => { if (!cancelled) setRegionalLoading(false); });
    return () => { cancelled = true; };
  }, [regionalLoaded, regionalLoading, getApiToken]);

  const loadInstance = useCallback((subId?: string) => {
    let cancelled = false;
    setInstanceLoading(true);
    setInstanceError(null);
    setInstanceData(null);
    const url = subId
      ? `${apiBaseUrl()}/api/health/summary?subscriptionId=${encodeURIComponent(subId)}`
      : `${apiBaseUrl()}/api/health/summary`;
    getApiToken()
      .catch(() => null)
      .then(async (token) => {
        const d = await fetchJsonWithBearer<HealthSummary>(url, token);
        if (!cancelled) setInstanceData(d);
      })
      .catch((e: unknown) => { if (!cancelled) setInstanceError(e instanceof Error ? e.message : "error"); })
      .finally(() => { if (!cancelled) setInstanceLoading(false); });
    return () => { cancelled = true; };
  }, [getApiToken]);

  const loadEvents = useCallback(() => {
    if (eventsLoaded || eventsLoading) return;
    let cancelled = false;
    setEventsLoading(true);
    setEventsError(null);
    const url = subscriptionId
      ? `${apiBaseUrl()}/api/health/events?subscriptionId=${encodeURIComponent(subscriptionId)}`
      : `${apiBaseUrl()}/api/health/events`;
    getApiToken()
      .catch(() => null)
      .then(async (token) => {
        const d = await fetchJsonWithBearer<ServiceHealthEventsResponse>(url, token);
        if (!cancelled) { setEventsData(d); setEventsLoaded(true); }
      })
      .catch((e: unknown) => { if (!cancelled) setEventsError(e instanceof Error ? e.message : "error"); })
      .finally(() => { if (!cancelled) setEventsLoading(false); });
    return () => { cancelled = true; };
  }, [eventsLoaded, eventsLoading, subscriptionId, getApiToken]);

  // Load on tab switch
  useEffect(() => {
    if (activeTab === "global") loadGlobal();
    else if (activeTab === "instance") loadInstance(subscriptionId);
    else if (activeTab === "service") loadEvents();
  }, [activeTab]); // eslint-disable-line react-hooks/exhaustive-deps

  // Re-fetch instance data when subscription changes
  useEffect(() => {
    if (activeTab === "instance") loadInstance(subscriptionId);
  }, [subscriptionId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Preload global tab on mount (RSS is public, regional needs auth)
  useEffect(() => { loadGlobal(); loadRegional(subscriptionId || undefined); }, []); // eslint-disable-line react-hooks/exhaustive-deps

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
        <GlobalStatusPanel
          data={globalData}
          loading={globalLoading}
          error={globalError}
          regionalData={regionalData}
          regionalLoading={regionalLoading}
        />
      )}
      {activeTab === "instance" && (
        <InstanceHealthPanel
          data={instanceData}
          loading={instanceLoading}
          error={instanceError}
          subscriptions={subscriptions}
          subscriptionId={subscriptionId}
          onSubscriptionChange={(id) => setSubscriptionId(id)}
        />
      )}
      {activeTab === "service" && (
        <ServiceStatusPanel data={eventsData} loading={eventsLoading} error={eventsError} />
      )}
    </div>
  );
}
