"use client";

import { useMemo, type KeyboardEvent, type ReactNode } from "react";
import type { ResourceHealthStatus } from "@aud/types";
import { Panel, Select } from "@/components/ui";
import { useI18n } from "@/lib/i18n";
import { rgba } from "@/lib/palette";
import { groupResources, groupStateCounts, isUserInitiated, scopeOptions, stateTone, visibleTiles, type HeatmapGroupBy, type HealthState } from "@/lib/healthHeatmap";
import styles from "./styles.module.css";

/** Tiles per group in the "all" view before "+k" (one chosen group shows every tile) */
const MAX_TILES = 200;
/** A group this big takes two columns, so it does not tower over the rest */
const WIDE_AT = 60;

export type HeatmapGroupFilter = { by: HeatmapGroupBy; key: string; label: string };

/** Select values: "*" = all groups, "g:<key>" = one group (a key may be "" — no region) */
const ALL = "*";
const optValue = (key: string) => `g:${key}`;

/**
 * One tile per resource, colored by its current Resource Health state (lib/healthHeatmap), in one bordered card per
 * group — type / resource group / region, worst first. "묶는 기준" and "표시 범위" are selects; the chosen scope is
 * the page's one group filter (the list below follows it). Tooltips name the resource, type, group, state and
 * Azure's own text — never ids. Each group is one tab stop (arrow keys inside).
 */
export function HealthHeatmap({
  resources, by, onBy, scope, onScope, selectedId, onSelect, checks, footer,
}: {
  resources: ResourceHealthStatus[];
  by: HeatmapGroupBy;
  onBy: (by: HeatmapGroupBy) => void;
  scope: HeatmapGroupFilter | null;
  onScope: (g: HeatmapGroupFilter | null) => void;
  selectedId: string | null;
  onSelect: (resourceId: string) => void;
  /** What Azure checks per type (lower-case ARM type → lines), from /api/health/coverage */
  checks: Record<string, string[]>;
  /** Under the groups: what Resource Health does not cover */
  footer?: ReactNode;
}) {
  const { t } = useI18n();
  const groups = useMemo(() => groupResources(resources, by), [resources, by]);
  const shown = scope && scope.by === by ? groups.filter((g) => g.key === scope.key) : groups;
  const stateText = (s: HealthState) => t(`health.state.${s}`);
  const nameOf = (label: string) => label || (by === "region" ? t("health.heatmap.noRegion") : "—");

  // Roving focus inside a group: ←/→/↑/↓/Home/End move between its tiles
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const tiles = [...e.currentTarget.querySelectorAll<HTMLButtonElement>("button[data-tile]")];
    const i = tiles.indexOf(document.activeElement as HTMLButtonElement);
    if (i < 0) return;
    const next = e.key === "ArrowRight" || e.key === "ArrowDown" ? i + 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? i - 1 : e.key === "Home" ? 0 : e.key === "End" ? tiles.length - 1 : null;
    if (next == null) return;
    e.preventDefault();
    const target = tiles[Math.max(0, Math.min(tiles.length - 1, next))];
    tiles.forEach((b) => (b.tabIndex = b === target ? 0 : -1));
    target?.focus();
  };

  const legend: Array<{ key: string; tone: ReturnType<typeof stateTone>; label: string; hint?: string }> = [
    { key: "u", tone: stateTone("Unavailable"), label: stateText("Unavailable") },
    { key: "uu", tone: stateTone("Unavailable", true), label: t("health.userInitiated"), hint: t("health.userInitiated.hint") },
    { key: "d", tone: stateTone("Degraded"), label: stateText("Degraded") },
    { key: "k", tone: stateTone("Unknown"), label: stateText("Unknown"), hint: t("health.unknown.hint") },
    { key: "a", tone: stateTone("Available"), label: stateText("Available") },
  ];

  return (
    <Panel
      className={styles.heatmapPanel}
      title={t("health.heatmap.title")}
      sub={t("health.heatmap.currentOnly")}
      actions={
        <div className={styles.heatmapControls}>
          <Select
            label={t("health.heatmap.groupBy")}
            value={by}
            onChange={(v) => { onBy(v as HeatmapGroupBy); onScope(null); }}
            options={[
              { value: "type", label: t("health.heatmap.by.type") },
              { value: "rg", label: t("health.heatmap.by.rg") },
              { value: "region", label: t("health.heatmap.by.region") },
            ]}
          />
          <Select
            label={t("health.heatmap.scope")}
            value={scope && scope.by === by ? optValue(scope.key) : ALL}
            onChange={(v) => {
              if (v === ALL) return onScope(null);
              const g = groups.find((x) => optValue(x.key) === v);
              if (g) onScope({ by, key: g.key, label: nameOf(g.label) });
            }}
            options={[
              { value: ALL, label: t("health.heatmap.scopeAll", { n: resources.length }) },
              ...scopeOptions(groups).map((o) => ({ value: optValue(o.key), label: t("health.heatmap.scopeOption", { label: nameOf(o.label), n: o.n }) })),
            ]}
          />
        </div>
      }
    >
      <div className={styles.heatmapLegend}>
        {legend.map((l) => (
          <span key={l.key} className={styles.heatmapLegendItem} title={l.hint}>
            <span className={`${styles.heatTile} ${l.tone.dashed ? styles.heatTileDashed : ""}`} style={{ background: rgba(l.tone.color, l.tone.alpha) }} aria-hidden="true">{l.tone.glyph}</span>
            {l.label}
            {l.hint ? <span className={styles.heatmapLegendHint} aria-hidden="true">ⓘ</span> : null}
          </span>
        ))}
      </div>

      <div className={styles.heatmapGroups}>
        {shown.map((g) => {
          const { tiles, more } = scope ? { tiles: g.resources, more: 0 } : visibleTiles(g, MAX_TILES);
          const label = nameOf(g.label);
          const c = groupStateCounts(g);
          const worst = g.worst === "Unavailable" && c.unavailable === 0 ? (g.counts.Degraded ? "Degraded" : "Unavailable-user") : g.worst;
          const accent = worst === "Unavailable" ? styles.heatGroupWorstDanger : worst === "Degraded" ? styles.heatGroupWorstWarning : "";
          const typeChecks = by === "type" ? checks[g.key] : undefined;
          const headTitle = [
            by === "type" ? g.resources[0]?.resourceType : undefined,
            typeChecks?.length ? `${t("health.heatmap.checksTitle")}\n${typeChecks.map((x) => `- ${x}`).join("\n")}` : undefined,
            scope ? undefined : t("health.heatmap.filterGroup"),
          ].filter(Boolean).join("\n\n");
          const headId = `hm-${by}-${g.key || "none"}`.replace(/[^a-zA-Z0-9_-]/g, "_");
          return (
            <section
              key={g.key}
              className={`${styles.heatGroupCard} ${accent} ${!scope && g.resources.length > WIDE_AT ? styles.heatGroupWide : ""}`}
              aria-labelledby={headId}
            >
              <header className={styles.heatGroupHead}>
                <button
                  type="button"
                  id={headId}
                  className={styles.heatmapGroupHead}
                  onClick={() => onScope(scope ? null : { by, key: g.key, label })}
                  title={headTitle}
                >
                  <span className={styles.heatmapGroupName}>{label}</span>
                </button>
                <span className={styles.heatGroupCounts} aria-label={t("health.heatmap.stateCounts", { unavailable: c.unavailable, user: c.user, degraded: c.degraded, unknown: c.unknown, available: c.available })}>
                  {c.unavailable ? <span className={styles.countDanger}>✕{c.unavailable}</span> : null}
                  {c.user ? <span className={styles.countUser} title={t("health.userInitiated")}>✕{c.user}</span> : null}
                  {c.degraded ? <span className={styles.countWarning}>!{c.degraded}</span> : null}
                  {c.unknown ? <span className={styles.countMuted}>?{c.unknown}</span> : null}
                  <span className={styles.countOk}>·{c.available}</span>
                </span>
              </header>
              <div className={styles.heatmapTiles} role="group" aria-label={label} onKeyDown={onKey}>
                {tiles.map((r, i) => {
                  const user = isUserInitiated(r);
                  const tone = stateTone(r.availabilityState, user);
                  const state = user ? `${stateText(r.availabilityState)} · ${t("health.userInitiated")}` : stateText(r.availabilityState);
                  const tip = [r.resourceName, `${r.resourceType} · ${r.resourceGroup}`, state, r.summary ? `${t("health.azureSummary")}: ${r.summary}` : ""].filter(Boolean).join("\n");
                  return (
                    <button
                      key={r.resourceId}
                      type="button"
                      data-tile=""
                      tabIndex={i === 0 ? 0 : -1}
                      className={`${styles.heatTile} ${tone.dashed ? styles.heatTileDashed : ""} ${selectedId === r.resourceId ? styles.heatTileSelected : ""}`}
                      style={{ background: rgba(tone.color, tone.alpha) }}
                      title={tip}
                      aria-label={t("health.heatmap.tileLabel", { name: r.resourceName, state })}
                      aria-pressed={selectedId === r.resourceId}
                      onClick={() => onSelect(r.resourceId)}
                    >
                      {tone.glyph}
                    </button>
                  );
                })}
                {more > 0 ? (
                  <button type="button" className={styles.heatmapMore} onClick={() => onScope({ by, key: g.key, label })}>{t("health.heatmap.more", { n: more })}</button>
                ) : null}
              </div>
            </section>
          );
        })}
      </div>
      {footer}
    </Panel>
  );
}
