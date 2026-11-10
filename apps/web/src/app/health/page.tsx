"use client";

import { useCallback, useMemo, useState } from "react";
import styles from "./styles.module.css";
import type {
  HealthCoverage,
  HealthSummary,
  GlobalStatusResponse,
  GlobalStatusIncident,
  GlobalStatusIncidentStatus,
  ServiceHealthEventsResponse,
  ServiceHealthEvent,
  ServiceHealthEventType,
  RegionalStatusResponse,
  RegionHealthStatus,
} from "@aud/types";
import { apiUrl, fetchJsonWithBearer } from "@/lib/api";
import { useApiQuery } from "@/lib/useApiQuery";
import { useSubscriptions } from "@/lib/useSubscriptions";
import { useApiToken } from "@/lib/useApiToken";
import { dateLocale, useI18n, type Locale } from "@/lib/i18n";
import { Badge, Cell, Chip, EmptyState, ErrorNotice, Grid, LoadingState, PageHeader, Panel, SampleDataNotice, Stat, Tabs, useNoteText } from "@/components/ui";
import type { ChipLevel } from "@/components/ui";
import { InstanceHealthPanel } from "./InstanceHealthPanel";
import { rgba } from "@/lib/palette";

// ── Constants ──

type HealthTab = "global" | "instance" | "service";

const INCIDENT_STATUS_STYLE: Record<GlobalStatusIncidentStatus, string> = {
  Active: styles.statusActive ?? "",
  Investigating: styles.statusInvestigating ?? "",
  Mitigated: styles.statusMitigated ?? "",
  Resolved: styles.statusResolved ?? "",
};

/** Event type → the platform's state grammar (colour + glyph): an outage is danger, the two advisories watch, maintenance info */
const EVENT_TYPE_LEVEL: Record<ServiceHealthEventType, ChipLevel> = {
  ServiceIssue: "danger",
  PlannedMaintenance: "info",
  HealthAdvisory: "warn",
  SecurityAdvisory: "warn",
};

const EVENT_TYPE_COLORS: Record<ServiceHealthEventType, string> = {
  ServiceIssue: rgba("danger", 0.82),
  PlannedMaintenance: rgba("accent", 0.82),
  HealthAdvisory: rgba("warning", 0.82),
  SecurityAdvisory: rgba("violet", 0.82),
};


// ── Helpers ──

/** "3시간 전" / "3h ago" in the app's language (was English-only text on the Korean page) */
function fmtRelative(iso: string, locale: Locale): string {
  const diff = new Date(iso).getTime() - Date.now();
  const abs = Math.abs(diff);
  const rtf = new Intl.RelativeTimeFormat(dateLocale(locale), { numeric: "auto", style: "short" });
  if (abs >= 86_400_000) return rtf.format(Math.trunc(diff / 86_400_000), "day");
  if (abs >= 3_600_000) return rtf.format(Math.trunc(diff / 3_600_000), "hour");
  return rtf.format(Math.trunc(diff / 60_000), "minute");
}

/** In the app's language (was the browser's locale) */
function fmtDate(iso: string, locale: Locale): string {
  return new Date(iso).toLocaleString(dateLocale(locale), {
    month: "short", day: "numeric",
    hour: "2-digit", minute: "2-digit",
  });
}

// ── Sub-components ──

/**
 * Build a per-service status view from region events.
 * Groups events by service name and determines each service's worst status.
 */
function useRegionServices(region: RegionHealthStatus) {
  return useMemo(() => {
    // Collect all unique services mentioned across events for this region
    const serviceMap = new Map<string, { events: ServiceHealthEvent[]; worst: "ok" | "issue" | "maintenance" | "advisory" }>();

    for (const evt of region.events) {
      if (evt.isResolved) continue;
      for (const svc of evt.affectedServices) {
        if (!serviceMap.has(svc)) {
          serviceMap.set(svc, { events: [], worst: "ok" });
        }
        const entry = serviceMap.get(svc)!;
        entry.events.push(evt);
        // Determine worst status: issue > maintenance > advisory > ok
        if (evt.eventType === "ServiceIssue") entry.worst = "issue";
        else if (evt.eventType === "PlannedMaintenance" && entry.worst !== "issue") entry.worst = "maintenance";
        else if (entry.worst === "ok") entry.worst = "advisory";
      }
    }

    // Sort: affected services first, then alphabetical
    const PRIORITY: Record<string, number> = { issue: 0, maintenance: 1, advisory: 2, ok: 3 };
    return [...serviceMap.entries()]
      .sort((a, b) => (PRIORITY[a[1].worst] ?? 9) - (PRIORITY[b[1].worst] ?? 9) || a[0].localeCompare(b[0]));
  }, [region.events]);
}

const SERVICE_STATUS_STYLE: Record<string, string> = {
  ok: styles.regionServiceOk ?? "",
  issue: styles.regionServiceIssue ?? "",
  maintenance: styles.regionServiceMaintenance ?? "",
  advisory: styles.regionServiceAdvisory ?? "",
};

const SERVICE_STATUSES = new Set(["ok", "issue", "maintenance", "advisory"]);

const SERVICE_DOT_COLOR: Record<string, string> = {
  ok: rgba("ok", 0.7),
  issue: rgba("danger", 0.8),
  maintenance: rgba("accent", 0.8),
  advisory: rgba("warning", 0.8),
};

function RegionCard({ region }: { region: RegionHealthStatus }) {
  const { t, locale } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const isAffected = region.hasActiveIssues;
  const services = useRegionServices(region);

  const cardClass = [
    styles.regionCard,
    isAffected ? styles.regionCardAffected : styles.regionCardGood,
    expanded ? styles.regionCardExpanded : "",
  ].filter(Boolean).join(" ");

  return (
    <div className={cardClass}>
      {/* The header is the toggle — a real button (keyboard, screen readers); the card itself is not clickable */}
      <button type="button" className={styles.regionCardHeader} aria-expanded={expanded} onClick={() => setExpanded((v) => !v)}>
        <span className={styles.regionName}>{region.displayName}</span>
        <Chip level={isAffected ? "danger" : "ok"}>{isAffected ? t("health.regionAffected") : t("health.regionOperational")}</Chip>
        <span className={`${styles.regionChevron} ${expanded ? styles.regionChevronOpen : ""}`} aria-hidden="true">▾</span>
      </button>

      {/* Collapsed summary chips */}
      {!expanded && isAffected && (
        <div className={styles.regionIssueRow}>
          {region.serviceIssueCount > 0 && <Chip level="danger" glyph={false}>{region.serviceIssueCount} {t("health.regionServiceIssue")}</Chip>}
          {region.maintenanceCount > 0 && <Chip level="info" glyph={false}>{region.maintenanceCount} {t("health.regionMaintenance")}</Chip>}
        </div>
      )}

      {/* Expanded: per-service detail */}
      {expanded && (
        <div className={styles.regionDetailSection}>
          {services.length > 0 ? services.map(([svcName, { events: svcEvents, worst }]) => (
            <div key={svcName} className={styles.regionServiceGroup}>
              <div className={styles.regionServiceHeader}>
                <div className={styles.regionServiceDot} style={{ background: SERVICE_DOT_COLOR[worst] }} />
                <span className={styles.regionServiceName}>{svcName}</span>
                <span className={`${styles.regionServiceStatus} ${SERVICE_STATUS_STYLE[worst]}`}>
                  {SERVICE_STATUSES.has(worst) ? t(`health.svc.${worst}`) : worst}
                </span>
              </div>
              {svcEvents.map((evt) => (
                <div key={evt.id} className={styles.regionEventItem}>
                  <div className={styles.regionEventItemHeader}>
                    <Chip level={EVENT_TYPE_LEVEL[evt.eventType]}>
                      {t(`health.eventType.${evt.eventType}`)}
                    </Chip>
                    <span className={styles.regionEventTime}>
                      {evt.lastUpdateTime ? fmtRelative(evt.lastUpdateTime, locale) : ""}
                    </span>
                  </div>
                  <div className={styles.regionEventTitle}>{evt.title}</div>
                  {evt.summary && (
                    <div className={styles.regionEventSummary}>{evt.summary}</div>
                  )}
                </div>
              ))}
            </div>
          )) : (
            <div className={styles.regionNoEvents}>
              {t("health.regionNoEvents")}
            </div>
          )}
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
  const { t, locale } = useI18n();
  const noteText = useNoteText();

  if (loading) return <LoadingState label={t("health.loading")} />;
  if (error) return <ErrorNotice error={error} title={t("health.error")} />;
  if (!data) return null;

  const hasRegions = regionalData && regionalData.regions.length > 0;

  // Kit layout (design-system.md · 8): the sample notice first (the only notice), then two panels —
  // regions (the count of affected regions is the head's chip, not a second banner) and global incidents
  return (
    <div className={styles.globalLayout}>
      {/* Sample first: the red "n regions affected" chip below must not be read as a real outage */}
      {regionalData?.source === "mock" ? <SampleDataNotice note={regionalData.note ?? "mock data"} /> : null}
      <Panel title={t("health.yourRegions")} sub={t("health.yourRegionsSub")}
        actions={hasRegions ? (regionalData.totalAffected > 0
          ? <Chip level="danger">{t("health.regionsAffected", { n: regionalData.totalAffected })}</Chip>
          : <Chip level="ok">{t("health.regionsAllOk")}</Chip>) : undefined}
        footer={hasRegions && regionalData.source !== "mock" && regionalData.note ? <span>{noteText(regionalData.note)}</span> : undefined}>
        {regionalLoading ? <LoadingState label={t("health.loading")} /> : hasRegions ? (
          <Grid>
            {regionalData.regions.map((region) => (
              <Cell span={3} key={region.name}><RegionCard region={region} /></Cell>
            ))}
          </Grid>
        ) : (
          <EmptyState title={regionalData?.note ? t("health.error") : t("health.noRegions")}>
            {regionalData?.note ? noteText(regionalData.note) : t("health.permissionsNote")}
          </EmptyState>
        )}
      </Panel>

      <Panel title={t("health.globalIncidents")}
        actions={data.activeIncidents === 0 ? <Chip level="ok">{t("health.allOperational")}</Chip> : <Chip level="danger">{t("health.incidentsN", { n: data.activeIncidents })}</Chip>}
        footer={<a href="https://azure.status.microsoft/en-us/status" target="_blank" rel="noopener noreferrer" className={styles.allGoodLink}>{t("health.azureStatusLink")} ↗</a>}>
        {data.activeIncidents === 0 ? (
          <p className={styles.panelText}>{t("health.allOperationalSub")}</p>
        ) : (
          <div className={styles.incidentList}>
            {data.incidents.map((inc: GlobalStatusIncident) => (
              <div key={inc.id} className={styles.incidentCard}>
                <div className={styles.incidentHeader}>
                  <span className={`${styles.incidentStatus} ${INCIDENT_STATUS_STYLE[inc.status]}`}>
                    {t(`health.incident.${inc.status}`)}
                  </span>
                  <span className={styles.incidentDate}>{inc.pubDate ? fmtDate(inc.pubDate, locale) : ""}</span>
                </div>
                <div className={styles.incidentTitle}>{inc.title}</div>
                {inc.description && (
                  <div className={styles.incidentDesc}>{inc.description}</div>
                )}
                {inc.affectedRegions.length > 0 && (
                  <div className={styles.tagRow}>
                    <span className={styles.tagLabel}>{t("health.affectedRegions")}:</span>
                    {inc.affectedRegions.map((r) => <Chip key={r} level="plain" glyph={false}>{r}</Chip>)}
                  </div>
                )}
                {inc.affectedServices.length > 0 && (
                  <div className={styles.tagRow}>
                    <span className={styles.tagLabel}>{t("health.affectedServices")}:</span>
                    {inc.affectedServices.map((sv) => <Chip key={sv} level="plain" glyph={false}>{sv}</Chip>)}
                  </div>
                )}
                {inc.link && (
                  <a href={inc.link} target="_blank" rel="noopener noreferrer" className={styles.incidentLink}>
                    {t("health.viewDetails")} →
                  </a>
                )}
              </div>
            ))}
          </div>
        )}
      </Panel>
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
  const { t, locale } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const toggle = () => setExpanded((v) => !v);

  const displayTitle = showTranslation && translation ? translation.title : evt.title;
  const displaySummary = showTranslation && translation ? translation.summary : (evt.summary ?? "");

  return (
    <div className={`${styles.eventCard} ${expanded ? styles.eventCardExpanded : ""}`}>
      {/* ── Header row (always visible, clickable) ── */}
      <button type="button" className={styles.eventCardBtn} onClick={toggle} aria-expanded={expanded}>
        <div className={styles.eventCardBtnLeft}>
          <Chip level={EVENT_TYPE_LEVEL[evt.eventType]}>
            {t(`health.eventType.${evt.eventType}`)}
          </Chip>
          <Chip level="plain" glyph={false}>{evt.level}</Chip>
          {evt.isResolved && <Chip level="ok">{t("health.incident.Resolved")}</Chip>}
          {showTranslation && translation && <Badge tone="info">KO</Badge>}
        </div>
        <div className={styles.eventCardBtnRight}>
          <span className={styles.eventTime}>
            {evt.lastUpdateTime ? fmtRelative(evt.lastUpdateTime, locale) : ""}
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
            <Chip key={r} level="plain" glyph={false}>{r}</Chip>
          ))}
          {evt.affectedRegions.length > 4 && (
            <Badge>+{evt.affectedRegions.length - 4}</Badge>
          )}
          {evt.affectedServices.slice(0, 2).map((s) => (
            <Chip key={s} level="plain" glyph={false}>{s}</Chip>
          ))}
          {evt.affectedServices.length > 2 && (
            <Badge>+{evt.affectedServices.length - 2}</Badge>
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
                  <span className={styles.timestampValue}>{fmtDate(evt.impactStartTime, locale)}</span>
                </div>
              )}
              {evt.impactMitigationTime && (
                <div className={styles.timestampItem}>
                  <div className={styles.timestampDot} data-kind="end" />
                  <span className={styles.timestampLabel}>{t("health.impactEnd")}</span>
                  <span className={styles.timestampValue}>{fmtDate(evt.impactMitigationTime, locale)}</span>
                </div>
              )}
              {evt.lastUpdateTime && (
                <div className={styles.timestampItem}>
                  <div className={styles.timestampDot} data-kind="update" />
                  <span className={styles.timestampLabel}>{t("health.lastUpdate")}</span>
                  <span className={styles.timestampValue}>{fmtDate(evt.lastUpdateTime, locale)}</span>
                </div>
              )}
            </div>
          )}

          {/* Affected regions */}
          {evt.affectedRegions.length > 0 && (
            <div className={styles.tagRow}>
              <span className={styles.tagLabel}>{t("health.affectedRegions")}:</span>
              {evt.affectedRegions.map((r) => (
                <Chip key={r} level="plain" glyph={false}>{r}</Chip>
              ))}
            </div>
          )}

          {/* Affected services */}
          {evt.affectedServices.length > 0 && (
            <div className={styles.tagRow}>
              <span className={styles.tagLabel}>{t("health.affectedServices")}:</span>
              {evt.affectedServices.map((s) => (
                <Chip key={s} level="plain" glyph={false}>{s}</Chip>
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
  // Why the translation did not happen (i18n key + vars) — the API names the reason (services/health.ts translateTexts)
  const [translateNote, setTranslateNote] = useState<{ key: string; vars?: Record<string, string | number> } | null>(null);
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
      const resp = await fetchJsonWithBearer<{ translations?: string[] | null; error?: string; status?: number; freeStatus?: number | "network" }>(
        apiUrl("/api/health/translate"),
        token,
        { method: "POST", body: JSON.stringify({ texts, to: "ko" }) },
      );
      if (resp.error === "not_configured") {
        setTranslateNote(resp.freeStatus
          ? { key: "health.translateNotConfiguredFree", vars: { status: resp.freeStatus === "network" ? t("health.translateNetwork") : `HTTP ${resp.freeStatus}` } }
          : { key: "health.translateNotConfigured" });
      } else if (resp.error === "translator_auth") {
        setTranslateNote({ key: "health.translateAuth", vars: { status: resp.status ?? 401 } });
      } else if (resp.error === "translator_quota") {
        setTranslateNote({ key: "health.translateQuota" });
      } else if (resp.error) {
        setTranslateNote({ key: "health.translateError" });
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
      setTranslateNote({ key: "health.translateError" });
    } finally {
      setTranslating(false);
    }
  }, [data, translationMap, getApiToken, t]);

  const eventTypeCounts = [
    { type: "ServiceIssue" as const, key: "serviceIssue" as const, glyph: "■", tone: "high" as const },
    { type: "PlannedMaintenance" as const, key: "plannedMaintenance" as const, glyph: "●", tone: undefined },
    { type: "HealthAdvisory" as const, key: "healthAdvisory" as const, glyph: "▲", tone: "medium" as const },
    { type: "SecurityAdvisory" as const, key: "securityAdvisory" as const, glyph: "▲", tone: "medium" as const },
  ];

  if (loading) return <LoadingState label={t("health.loading")} />;
  if (error) return <ErrorNotice error={error} title={t("health.error")} />;

  return (
    <div className={styles.grid}>
      {/* Sample events (anonymous) are marked before anything else — they read like real outages */}
      {data?.source === "mock" ? <SampleDataNotice note={data.note ?? "mock data"} /> : null}
      {/* Event type summary strip */}
      {/* Four kit Stat cards (3 columns each) — the glyph and colour say the kind, the number is Azure's count */}
      <div className={styles.eventStats}>
        <Grid>
          {eventTypeCounts.map(({ type, key, glyph, tone }) => {
            const n = data?.byType[key] ?? 0;
            return (
              <Cell span={3} key={type}>
                <Stat label={<><span aria-hidden="true" style={{ color: EVENT_TYPE_COLORS[type] }}>{glyph}</span> {t(`health.eventType.${type}`)}</>}
                  value={n} tone={n > 0 ? tone : undefined} />
              </Cell>
            );
          })}
        </Grid>
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
          {translateNote && (
            <span className={styles.translateNote}>{t(translateNote.key, translateNote.vars)}</span>
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
  const { t, locale } = useI18n();
  const [activeTab, setActiveTab] = useState<HealthTab>("global");
  // Tabs load lazily on first visit
  const [visited, setVisited] = useState<ReadonlySet<HealthTab>>(() => new Set<HealthTab>(["global"]));
  const selectTab = (tab: HealthTab) => {
    setActiveTab(tab);
    setVisited((prev) => (prev.has(tab) ? prev : new Set(prev).add(tab)));
  };

  // Subscriptions list (shared across tabs) — every subscription-scoped query is keyed by it
  const { subscriptions, subscriptionId, setSubscriptionId, loaded: subsLoaded } = useSubscriptions();
  const sub = subscriptionId || undefined;

  // Tab 1 — Global Status (public RSS feed) + regional status for the user's deployed regions
  const global = useApiQuery(
    "health-global",
    (token) => fetchJsonWithBearer<GlobalStatusResponse>(apiUrl("/api/health/global-status"), token),
    { tokenOptional: true },
  );
  const regional = useApiQuery(
    subsLoaded ? `health-regional:${subscriptionId}` : null,
    (token) => fetchJsonWithBearer<RegionalStatusResponse>(apiUrl("/api/health/regional-status", { subscriptionId: sub }), token),
    { tokenOptional: true },
  );

  // Tab 2 — Instance Health
  const instance = useApiQuery(
    // Resource Health writes its summaries in the requested language (no translator) — the key follows the app language
    subsLoaded && visited.has("instance") ? `health-instance:${subscriptionId}:${locale}` : null,
    (token) => fetchJsonWithBearer<HealthSummary>(apiUrl("/api/health/summary", { subscriptionId: sub, lang: locale }), token),
    { tokenOptional: true },
  );

  // Tab 2 supplement — which resources Resource Health gives no status for (counts by type)
  const coverage = useApiQuery(
    subsLoaded && visited.has("instance") ? `health-coverage:${subscriptionId}:${locale}` : null,
    (token) => fetchJsonWithBearer<HealthCoverage>(apiUrl("/api/health/coverage", { subscriptionId: sub, lang: locale }), token),
    { tokenOptional: true },
  );

  // Tab 3 — Service Events
  const events = useApiQuery(
    subsLoaded && visited.has("service") ? `health-events:${subscriptionId}` : null,
    (token) => fetchJsonWithBearer<ServiceHealthEventsResponse>(apiUrl("/api/health/events", { subscriptionId: sub }), token),
    { tokenOptional: true },
  );

  // Hide the previous subscription's results while the new ones load
  const globalData = global.data ?? null;
  const regionalData = regional.loading ? null : (regional.data ?? null);
  const instanceData = instance.loading ? null : (instance.data ?? null);
  const eventsData = events.loading ? null : (events.data ?? null);

  const activeGeneratedAt =
    activeTab === "global" ? globalData?.generatedAt
    : activeTab === "instance" ? instanceData?.generatedAt
    : eventsData?.generatedAt;

  return (
    <div className={styles.page}>
      <PageHeader
        meta={<span>{activeGeneratedAt ? `${t("health.generatedAt")}: ${new Date(activeGeneratedAt).toLocaleString(dateLocale(locale))}` : t("health.loading")}</span>}
      />

      <Tabs
        label={t("nav.item.health")}
        idPrefix="health-tab"
        value={activeTab}
        onChange={selectTab}
        items={[
          { id: "global", label: t("health.tabGlobal") },
          { id: "instance", label: t("health.tabInstance") },
          { id: "service", label: t("health.tabService") },
        ]}
      />

      {/* Tab Content */}
      {activeTab === "global" && (
        <GlobalStatusPanel
          data={globalData}
          loading={global.loading}
          error={global.error}
          regionalData={regionalData}
          regionalLoading={regional.loading}
        />
      )}
      {activeTab === "instance" && (
        <InstanceHealthPanel
          data={instanceData}
          loading={instance.loading}
          error={instance.error}
          coverage={coverage.loading ? null : (coverage.data ?? null)}
        />
      )}
      {activeTab === "service" && (
        <ServiceStatusPanel data={eventsData} loading={events.loading} error={events.error} />
      )}
    </div>
  );
}
