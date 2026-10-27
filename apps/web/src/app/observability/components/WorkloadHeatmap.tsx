"use client";

// AKS 모니터링 › 워크로드 › 히트맵 — problems first: one summary line (verdict · fired signals · legend), a "주의 필요"
// list only when something needs attention, then every workload as a tile inside namespace cards packed as a mosaic
// (no holes — cards sized to their tiles, small namespaces fill the gaps). Tiles use the live diagram's card grammar:
// a status strip and glyph (● ok green, ▲ warn, ■ danger, ○ nothing to run, ◎ measured without a baseline), the value
// as a tinted pill for warn/danger. DaemonSets no node matches are hidden by default (one quiet line says how many).
// Levels come from the API (services/workloadHeatmap.ts, the customer's Grafana container-map thresholds); the view
// model is lib/workloadHeatView.ts. Clicking a tile opens its pods, Warning events and log stream beside it.

import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import type { HeatLevel, HeatMetric, HeatWorkload, WorkloadHeatmapResponse } from "@aud/types";
import { apiUrl, fetchJsonWithBearer } from "@/lib/api";
import { useApiQuery } from "@/lib/useApiQuery";
import { dateLocale, useI18n } from "@/lib/i18n";
import { Button, EmptyState, ErrorNotice, LoadingState, Notice, Segmented, Select, Toggle } from "@/components/ui";
import {
  GLYPH, SIGNAL_GROUPS, attentionRows, cardShape, formatCell, formatThreshold, groupByNamespace, heatKey, isIdle, isProblem,
  legendLevels, levelIn, mosaicColumns, problemSignals, shortName, signalSummary, tileText, type HeatView,
} from "@/lib/workloadHeatView";
import { WorkloadHeatPanel } from "./WorkloadHeatPanel";
import styles from "../styles.module.css";

const WINDOWS = [60, 360, 1440] as const;
const ATTN_SHOWN = 8;

/** Arrow keys move between tiles of one namespace card (visual rows by position), Home/End to the ends */
function moveFocus(e: KeyboardEvent<HTMLButtonElement>) {
  const keys = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"];
  if (!keys.includes(e.key)) return;
  const grid = e.currentTarget.parentElement;
  if (!grid) return;
  const tiles = [...grid.querySelectorAll<HTMLButtonElement>("button")];
  const i = tiles.indexOf(e.currentTarget);
  let next = i;
  if (e.key === "ArrowLeft") next = Math.max(0, i - 1);
  else if (e.key === "ArrowRight") next = Math.min(tiles.length - 1, i + 1);
  else if (e.key === "Home") next = 0;
  else if (e.key === "End") next = tiles.length - 1;
  else {
    const me = e.currentTarget.getBoundingClientRect();
    const down = e.key === "ArrowDown";
    const row = tiles.filter((t) => (down ? t.getBoundingClientRect().top > me.top + 2 : t.getBoundingClientRect().top < me.top - 2));
    const target = down ? row.find((t) => t.getBoundingClientRect().top === Math.min(...row.map((r) => r.getBoundingClientRect().top))) : null;
    const rowTop = down ? target?.getBoundingClientRect().top : Math.max(...row.map((r) => r.getBoundingClientRect().top));
    const sameRow = row.filter((t) => t.getBoundingClientRect().top === rowTop);
    const best = sameRow.sort((a, b) => Math.abs(a.getBoundingClientRect().left - me.left) - Math.abs(b.getBoundingClientRect().left - me.left))[0];
    if (best) next = tiles.indexOf(best);
  }
  e.preventDefault();
  tiles[next]?.focus();
}

/**
 * Tile tracks that fit the mosaic's width, followed as the panel opens / the window resizes. A callback ref: the grid
 * mounts only after the data loads (a ref read in a mount effect would still be null then and never observe).
 */
function useMosaicColumns() {
  const [el, ref] = useState<HTMLDivElement | null>(null);
  const [cols, setCols] = useState(6);
  useEffect(() => {
    if (!el || typeof ResizeObserver === "undefined") return;
    setCols(mosaicColumns(el.clientWidth));
    const ro = new ResizeObserver((entries) => setCols(mosaicColumns(entries[0]?.contentRect.width ?? el.clientWidth)));
    ro.observe(el);
    return () => ro.disconnect();
  }, [el]);
  return { ref, cols };
}

export function WorkloadHeatmap({ clusterId }: { clusterId: string }) {
  const { t, locale } = useI18n();
  const [win, setWin] = useState<number>(60);
  const [view, setView] = useState<HeatView>("worst");
  const [ns, setNs] = useState("");
  const [problemsOnly, setProblemsOnly] = useState(false);
  const [showIdle, setShowIdle] = useState(false);
  const [allAttn, setAllAttn] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const lastTile = useRef<HTMLElement | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const mosaic = useMosaicColumns();
  const q = useApiQuery(clusterId ? `heatmap:${clusterId}:${win}` : null, (token) =>
    fetchJsonWithBearer<WorkloadHeatmapResponse>(apiUrl("/api/observability/heatmap", { clusterId, window: String(win) }), token),
  );
  const d = q.data?.clusterId === clusterId && q.data.windowMinutes === win ? q.data : null;

  const ws = d?.workloads ?? [];
  const idleCount = useMemo(() => ws.filter((w) => isIdle(w) && (!ns || w.namespace === ns)).length, [ws, ns]);
  const groups = useMemo(() => groupByNamespace(ws, view, { namespace: ns || undefined, problemsOnly, hideIdle: !showIdle }), [ws, view, ns, problemsOnly, showIdle]);
  const allGroups = useMemo(() => groupByNamespace(ws, view), [ws, view]);
  const attn = useMemo(() => attentionRows(ns ? ws.filter((w) => w.namespace === ns) : ws, view), [ws, view, ns]);
  const signals = useMemo(() => (d ? signalSummary(d.flags, ws) : null), [d, ws]);
  const sel = ws.find((w) => heatKey(w) === selected) ?? null;

  const open = (w: HeatWorkload, from: HTMLElement) => {
    const k = heatKey(w);
    lastTile.current = from;
    setSelected(selected === k ? null : k);
  };
  const close = () => {
    setSelected(null);
    lastTile.current?.focus();
  };
  // Narrow screens put the panel below the map — bring it into view when it opens
  useEffect(() => {
    if (sel && panelRef.current && window.matchMedia("(max-width: 1100px)").matches) panelRef.current.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [sel]);
  useEffect(() => {
    if (!sel) return;
    const onKey = (e: globalThis.KeyboardEvent) => { if (e.key === "Escape") close(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  if (q.error) return <ErrorNotice error={q.error} />;
  if (!d || !signals) return <LoadingState />;
  if (d.metricsState !== "ok") {
    return <Notice tone="warning" title={t(`hb.m.state.${d.metricsState}`)}>{t(`hb.m.stateHint.${d.metricsState}`)}{d.message ? ` (${d.message})` : ""}</Notice>;
  }

  const names = (ms: HeatMetric[]) => ms.map((m) => t(`ob.hm.short.${m}`)).join(" · ");
  const threshold = view !== "worst"
    ? view === "ready" ? t("ob.hm.thresholdReady")
      : t("ob.hm.threshold", { warn: formatThreshold(view, d.thresholds[view].warn) ?? "", danger: formatThreshold(view, d.thresholds[view].danger) ?? "" })
    : null;
  const nsCount = new Set(ws.map((w) => w.namespace)).size;
  const reason = (w: HeatWorkload, ms: HeatMetric[]) => ms.map((m) => `${t(`ob.hm.short.${m}`)} ${formatCell(m, w, t)}`).join(" · ");
  const dangerN = attn.filter((r) => r.level === "danger").length;
  const verdict: HeatLevel = dangerN > 0 ? "danger" : attn.length > 0 ? "warn" : "ok";
  const verdictText = verdict === "ok" ? t("ob.hm.verdictOk")
    : verdict === "danger" ? t("ob.hm.verdictDanger", { d: dangerN, w: attn.length - dangerN }) : t("ob.hm.verdictWarn", { n: attn.length });

  return (
    <div className={styles.hm}>
      {/* Controls: one signal selector (grouped), namespace, window, problems only — meta and refresh on the right */}
      <div className={styles.hmBar}>
        <Select label={t("ob.hm.metric")} value={view} onChange={(v) => setView(v as HeatView)}
          options={[
            { value: "worst", label: t("ob.hm.metric.worst") },
            ...SIGNAL_GROUPS.flatMap((g) => g.metrics.map((m) => ({ value: m, label: t(`ob.hm.metric.${m}`), group: t(`ob.hm.group.${g.id}`) }))),
          ]} />
        <Select label={t("hb.m.namespace")} value={ns} onChange={setNs}
          options={[{ value: "", label: t("hb.m.allNamespaces") }, ...allGroups.map((g) => ({ value: g.namespace, label: `${g.namespace} (${g.workloads.length})` }))]} />
        <Segmented label={t("ob.hm.window")} value={win} onChange={setWin} items={WINDOWS.map((w) => ({ id: w, label: t(`ob.hm.window.${w}`) }))} />
        <Toggle checked={problemsOnly} onChange={setProblemsOnly}>{t("ob.hm.problemsOnly")}</Toggle>
        <span className={styles.hmMeta}>
          <span title={t("ob.hm.basis", { n: ws.length, at: new Date(d.generatedAt).toLocaleString(dateLocale(locale)) })}>
            {t("ob.hm.meta", { n: ws.length, ns: nsCount, at: new Date(d.generatedAt).toLocaleTimeString(dateLocale(locale)) })} ⓘ
          </span>
          <Button size="sm" variant="ghost" ariaLabel={t("hb.m.refresh")} title={t("hb.m.refresh")} onClick={q.reload}>↻</Button>
        </span>
      </div>

      {/* Summary: the verdict (live card glyph), fired signals as chips (click = colour by it), quiet words, legend */}
      <div className={styles.hmSummary}>
        <span className={styles.hmVerdict} data-level={verdict}>
          <span className={styles.hmGlyph} aria-hidden="true">{GLYPH[verdict]}</span> {verdictText}
        </span>
        {signals.active.map((s) => (
          <button key={s.metric} type="button" aria-pressed={view === s.metric} data-level={s.tone}
            className={styles.hmSignal} onClick={() => setView(view === s.metric ? "worst" : s.metric)}>
            <span className={styles.hmGlyph} aria-hidden="true">{GLYPH[s.tone]}</span> {t(`ob.hm.flag.${s.metric}`)} <strong>{s.count}</strong>
          </button>
        ))}
        {signals.clear.length > 0 && <span className={styles.hmQuiet} title={t("ob.hm.clear", { list: names(signals.clear) })}>{t("ob.hm.clearN", { n: signals.clear.length })}</span>}
        {signals.notMeasured.length > 0 && <span className={`${styles.hmQuiet} ${styles.hmNotMeasured}`} title={t("ob.hm.notMeasuredList", { list: names(signals.notMeasured) })}>{t("ob.hm.notMeasuredN", { n: signals.notMeasured.length })}</span>}
        <ul className={styles.hmLegend} aria-label={t("ob.hm.legend")}>
          {legendLevels(allGroups).map((lv) => (
            <li key={lv} data-level={lv}><span className={styles.hmSwatch} aria-hidden="true"><span className={styles.hmGlyph}>{GLYPH[lv]}</span></span>{t(`ob.hm.level.${lv}`)}</li>
          ))}
        </ul>
      </div>
      {threshold && <p className={styles.hmThreshold}>{threshold}</p>}

      {/* Needs attention: only when something does — what and why, worst first */}
      {attn.length > 0 && (
        <section className={styles.hmAttention} aria-label={t("ob.hm.attention", { n: attn.length })}>
          <h4 className={styles.hmAttnHead}>{t("ob.hm.attention", { n: attn.length })}</h4>
          <ul className={styles.hmAttnList}>
            {(allAttn ? attn : attn.slice(0, ATTN_SHOWN)).map((r) => (
              <li key={heatKey(r.w)}>
                <button type="button" className={styles.hmAttnRow} data-level={r.level} aria-pressed={selected === heatKey(r.w)} onClick={(e) => open(r.w, e.currentTarget)}>
                  <span aria-hidden="true" className={styles.hmGlyph}>{GLYPH[r.level]}</span>
                  <span className={styles.hmAttnName} title={heatKey(r.w)}>{r.w.namespace} / <strong>{r.w.workload}</strong></span>
                  <span className={styles.hmAttnWhy}>{reason(r.w, r.signals)}</span>
                </button>
              </li>
            ))}
          </ul>
          {attn.length > ATTN_SHOWN && (
            <Button size="sm" variant="ghost" onClick={() => setAllAttn(!allAttn)}>
              {allAttn ? t("ob.hm.attentionLess") : t("ob.hm.attentionMore", { n: attn.length - ATTN_SHOWN })}
            </Button>
          )}
        </section>
      )}

      <div className={styles.hmLayout} data-open={!!sel || undefined}>
        <div className={styles.hmMain}>
          <div ref={mosaic.ref} className={styles.hmGroups} style={{ "--hm-cols": mosaic.cols } as CSSProperties}>
            {groups.length === 0 && <div className={styles.hmEmpty}><EmptyState title={problemsOnly ? t("ob.hm.problemsOnlyEmpty") : t("ob.hm.empty")} /></div>}
            {groups.map((g) => {
              const shape = cardShape(g.workloads.length, mosaic.cols);
              const others = g.workloads.length - g.counts.danger - g.counts.warn - g.counts.ok;
              return (
                <section key={g.namespace} aria-label={g.namespace} className={styles.hmNs} data-level={g.worst}
                  style={{ gridColumn: `span ${shape.cols}`, gridRow: `span ${shape.span}`, "--ns-cols": shape.cols } as CSSProperties}>
                  <header className={styles.hmNsHead} title={`${g.namespace} — ${t("ob.hm.nsCounts", { danger: g.counts.danger, warn: g.counts.warn, n: g.workloads.length })}`}>
                    <span className={styles.hmNsName}>
                      {g.namespace}{g.prefix ? <span className={styles.hmNsPrefix} title={t("ob.hm.prefix", { p: g.prefix })}> · {g.prefix}…</span> : null}
                    </span>
                    <span className={styles.hmNsCounts}>
                      {g.counts.danger > 0 && <span data-level="danger"><span className={styles.hmGlyph}>{GLYPH.danger}</span>{g.counts.danger}</span>}
                      {g.counts.warn > 0 && <span data-level="warn"><span className={styles.hmGlyph}>{GLYPH.warn}</span>{g.counts.warn}</span>}
                      {g.counts.ok > 0 && <span data-level="ok"><span className={styles.hmGlyph}>{GLYPH.ok}</span>{g.counts.ok}</span>}
                      {others > 0 && <span data-level="stopped"><span className={styles.hmGlyph}>{GLYPH.stopped}</span>{others}</span>}
                    </span>
                  </header>
                  <div className={styles.hmGrid}>
                    {g.workloads.map((w) => {
                      const lv = levelIn(w, view);
                      const k = heatKey(w);
                      const tt = tileText(w, view, t);
                      const probs = problemSignals(w).slice(0, 3);
                      const tip = [
                        k, `${w.kind ?? t("hb.m.kindUnknown")} · ${t(`ob.hm.level.${lv}`)}`,
                        ...(probs.length ? [reason(w, probs)] : []), t("ob.hm.tileHint"),
                      ].join("\n");
                      return (
                        <button key={k} type="button" className={styles.hmTile} data-level={lv} aria-pressed={selected === k}
                          aria-label={t("ob.hm.tileLabel", { name: k, state: t(`ob.hm.level.${lv}`), value: tt.text })}
                          title={tip} onClick={(e) => open(w, e.currentTarget)} onKeyDown={moveFocus}>
                          <span className={styles.hmTileName}>{shortName(w.workload, w.namespace, g.prefix)}</span>
                          <span className={styles.hmTileValue}>
                            <span className={styles.hmGlyph} aria-hidden="true">{tt.glyph}</span>
                            <span className={styles.hmTileText}>{tt.text}</span>
                            {tt.more ? <span className={styles.hmTileMore}>+{tt.more}</span> : null}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </section>
              );
            })}
          </div>
          {idleCount > 0 && (
            <p className={styles.hmIdle}>
              <span className={styles.hmGlyph} aria-hidden="true">{GLYPH.stopped}</span>{" "}
              {t(showIdle ? "ob.hm.idleShown" : "ob.hm.idleHidden", { n: idleCount })}{" "}
              <Button size="sm" variant="ghost" onClick={() => setShowIdle(!showIdle)}>{t(showIdle ? "ob.hm.idleHide" : "ob.hm.idleShow")}</Button>
            </p>
          )}
        </div>
        {sel && (
          <div ref={panelRef} className={styles.hmPanelWrap}>
            <WorkloadHeatPanel clusterId={clusterId} w={sel} grafana={d.grafana} onClose={close} />
          </div>
        )}
      </div>
    </div>
  );
}
