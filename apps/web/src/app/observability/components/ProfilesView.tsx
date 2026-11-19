"use client";

// 모니터링 › 프로필 (Datadog Continuous Profiler's visualizations, docs.datadoghq.com/profiler/profile_visualizations):
// a service and a profile type → the type's timeline over the page's range (drag to pick a window, click a point = one
// collection interval — Datadog's "single profile") → [flame graph | top functions | call graph], optionally against
// the previous window of the same length. Below, Datadog's profile types for each language seen here: collected, not
// collected (how to turn it on), not a Pyroscope profile. The thread timeline is said not to be possible, and why.
// Data: Pyroscope through the customer's Grafana (API services/grafanaProfiles.ts); numbers: lib/profileView.ts.

import { useEffect, useMemo, useRef, useState, type PointerEvent } from "react";
import type { ProfileCatalogResponse, ProfileKind, ProfileResponse, ProfileTree } from "@aud/types";
import { apiUrl, fetchJsonWithBearer } from "@/lib/api";
import { useApiQuery } from "@/lib/useApiQuery";
import { useRangeRefresh } from "@/lib/useTimeRange";
import { dateLocale, useI18n } from "@/lib/i18n";
import type { TimeRange } from "@/lib/timeRange";
import {
  LANG_OF, butterfly, callEdges, profileTypeOf, flameRects, frameKind, functionDiff, hasThreadLabel, languageCoverage, seriesUnit, shareDiff, shortName, topFunctions, valueText,
  type LangKey,
} from "@/lib/profileView";
import { Chip, EmptyState, ErrorNotice, LinkButton, LoadingState, Notice, Panel, SearchInput, Segmented, Select, Toggle } from "@/components/ui";
import styles from "../styles.module.css";

type View = "flame" | "top" | "call";
const FLAME_ROW = 20;

export function ProfilesView({ clusterId, range, nonce, report }: { clusterId: string; range: TimeRange; nonce: number; report?: (id: string, loading: boolean) => void }) {
  const { t, locale } = useI18n();
  // the page's range in epoch seconds
  const end = Math.floor((range.to ?? Date.now()) / 1000 / 60) * 60;
  const start = end - range.span * 60;
  const atQ = range.to === null ? undefined : String(Math.floor(range.to / 1000));
  const cat = useApiQuery(`obs-profiles:${clusterId}:${range.span}:${atQ ?? "now"}`, (token) =>
    fetchJsonWithBearer<ProfileCatalogResponse>(apiUrl("/api/observability/profiles", { clusterId, minutes: String(range.span), at: atQ }), token),
  );
  useRangeRefresh("profiles", nonce, cat.loading, cat.reload, report);
  const c = cat.data;
  const [svcKey, setSvcKey] = useState<string>("");
  const [typeId, setTypeId] = useState<string>("");
  const [view, setView] = useState<View>("flame");
  const [compare, setCompare] = useState(false);
  const [win, setWin] = useState<[number, number] | null>(null);
  const [focus, setFocus] = useState(0);
  const [fn, setFn] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const services = c?.services ?? [];
  const svc = services.find((s) => `${s.namespace ?? ""}/${s.service}` === svcKey) ?? services[0] ?? null;
  const types = svc ? svc.types.map((x) => profileTypeOf(x.id)) : [];
  const type = types.find((x) => x.id === typeId) ?? types.find((x) => x.kind === "cpu") ?? types[0] ?? null;
  // a new service / type / range starts over (whole range, root focus)
  useEffect(() => { setWin(null); setFocus(0); setFn(null); }, [svc?.service, svc?.namespace, type?.id, start, end]);
  const [wf, wt] = win ?? [start, end];
  const cmp = compare ? [wf - (wt - wf), wf] as const : null;
  const prof = useApiQuery(svc && type ? `obs-profile:${clusterId}:${svc.namespace}:${svc.service}:${type.id}:${wf}:${wt}:${start}:${end}:${cmp?.join("-") ?? ""}` : null, (token) =>
    fetchJsonWithBearer<ProfileResponse>(apiUrl("/api/observability/profile", {
      clusterId, service: svc!.service, namespace: svc!.namespace ?? undefined, type: type!.id,
      from: String(wf), to: String(wt), seriesFrom: String(start), seriesTo: String(end),
      compareFrom: cmp ? String(cmp[0]) : undefined, compareTo: cmp ? String(cmp[1]) : undefined,
    }), token),
  );
  useRangeRefresh("profile", nonce, prof.loading, prof.reload, report);
  const p = prof.data?.service === svc?.service && prof.data?.typeId === type?.id ? prof.data : null;
  const tree = p?.tree ?? null;

  if (cat.error) return <ErrorNotice error={cat.error} />;
  if (!c) return <LoadingState />;
  if (c.state !== "ok") {
    return (
      <EmptyState title={t(`ob.pf.state.${c.state}`)}>
        {t(`ob.pf.state.${c.state}Hint`)}{c.message ? ` (${c.message})` : ""}
      </EmptyState>
    );
  }
  if (!services.length) return <EmptyState title={t("ob.pf.none")}>{t("ob.pf.noneHint")}</EmptyState>;

  const kindsSent = new Set<ProfileKind>(services.flatMap((s) => s.types.map((x) => profileTypeOf(x.id).kind)));
  const langs = [...new Set(services.map((s) => (s.language ? LANG_OF[s.language] : undefined)).filter((x): x is LangKey => !!x))];
  const unit = type?.unit ?? "";
  const lc = dateLocale(locale);
  const fmtTime = (s: number) => new Date(s * 1000).toLocaleString(lc, { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });

  return (
    <>
      <Panel title={t("ob.pf.title")} sub={t("ob.pf.sub", { n: services.length, t: c.types.length })}>
        <div className={styles.pfTools}>
          <Select label={t("ob.pf.service")} value={svc ? `${svc.namespace ?? ""}/${svc.service}` : ""} onChange={setSvcKey}
            options={services.map((s) => ({ value: `${s.namespace ?? ""}/${s.service}`, label: s.service, group: s.namespace ?? t("ob.pf.noNamespace") }))} />
          <Select label={t("ob.pf.type")} value={type?.id ?? ""} onChange={setTypeId}
            options={types.map((x) => ({ value: x.id, label: `${t(`ob.pf.kind.${x.kind}`)} · ${x.name}:${x.sampleType}` }))} />
          <Segmented label={t("ob.pf.view")} value={view} onChange={setView}
            items={[{ id: "flame", label: t("ob.pf.view.flame") }, { id: "top", label: t("ob.pf.view.top") }, { id: "call", label: t("ob.pf.view.call") }]} />
          <Toggle checked={compare} onChange={setCompare} title={t("ob.pf.compareHint")}>{t("ob.pf.compare")}</Toggle>
        </div>
        {svc ? <p className={styles.pfMeta}>{t("ob.pf.meta", { lang: svc.language ? t(`ob.pf.lang.${LANG_OF[svc.language] ?? "native"}`) : (svc.spy ?? "—"), spy: svc.spy ?? "—" })}</p> : null}

        {/* the timeline: the type's series for this service over the page's range — the window to read is picked here */}
        {p?.series ? (
          <Timeline series={p.series} step={p.stepSeconds ?? 15} unit={unit} start={start} end={end} win={win} onWin={(w) => { setWin(w); setFocus(0); }} fmtTime={fmtTime} />
        ) : prof.loading ? <LoadingState /> : null}
        <p className={styles.pfWin} aria-live="polite">
          {win === null ? t("ob.pf.win.all", { a: fmtTime(start), b: fmtTime(end) })
            : p?.stepSeconds && wt - wf <= p.stepSeconds ? t("ob.pf.win.single", { a: fmtTime(wf), n: wt - wf })
            : t("ob.pf.win.range", { a: fmtTime(wf), b: fmtTime(wt) })}
          {win !== null ? <> · <LinkButton onClick={() => setWin(null)}>{t("ob.pf.win.reset")}</LinkButton></> : null}
          {cmp ? <> · {t("ob.pf.win.compare", { a: fmtTime(cmp[0]), b: fmtTime(cmp[1]) })}</> : null}
        </p>

        {prof.error ? <ErrorNotice error={prof.error} /> : null}
        {p && p.state !== "ok" ? <Notice tone="warning" title={t(`ob.pf.state.${p.state}`)}>{p.message ?? ""}</Notice> : null}
        {p && p.state === "ok" && !tree ? <EmptyState title={t("ob.pf.empty")} /> : null}
        {tree && p ? (
          <>
            <p className={styles.pfTotal}>
              {t("ob.pf.total", { v: `${valueText(p.total ?? 0, unit).n} ${valueText(p.total ?? 0, unit).unit}`, k: t(`ob.pf.kind.${type!.kind}`) })}
              {p.compare?.total != null ? ` · ${t("ob.pf.totalPrev", { v: `${valueText(p.compare.total, unit).n} ${valueText(p.compare.total, unit).unit}` })}` : null}
            </p>
            {view !== "call" ? <SearchInput label={t("ob.pf.search")} value={q} onChange={setQ} placeholder={t("ob.pf.searchPh")} /> : null}
            {view === "flame" ? <Flame tree={tree} prev={p.compare?.tree ?? null} unit={unit} focus={focus} onFocus={setFocus} q={q} onFn={(name) => { setFn(name); }} /> : null}
            {view === "top" ? <TopTable tree={tree} prev={p.compare?.tree ?? null} unit={unit} q={q} onFn={(name) => { setFn(name); setView("call"); }} /> : null}
            {view === "call" ? <CallGraph tree={tree} unit={unit} fn={fn} onFn={setFn} /> : null}
          </>
        ) : null}
      </Panel>

      <Panel title={t("ob.pf.cov.title")} sub={t("ob.pf.cov.sub")}>
        {langs.map((lang) => (
          <div key={lang} className={styles.pfCov}>
            <h4>{t(`ob.pf.lang.${lang}`)} <span>{t("ob.pf.cov.services", { n: services.filter((s) => s.language && LANG_OF[s.language] === lang).length })}</span></h4>
            <ul>
              {languageCoverage(lang, kindsSent).map((r) => (
                <li key={r.key} data-state={r.state}>
                  <Chip level={r.state === "collected" ? "ok" : r.state === "notCollected" ? "neutral" : "unknown"}>{t(`ob.pf.dd.${r.key}`)}</Chip>
                  <span>{t(`ob.pf.cov.${r.state}`)}{r.state === "notCollected" && lang === "java" ? ` — ${t(`ob.pf.enable.java.${r.key}`)}` : ""}</span>
                </li>
              ))}
            </ul>
            {lang === "java" ? <p className={styles.pfMeta}>{t("ob.pf.cov.javaNote")}</p> : null}
          </div>
        ))}
        <Notice tone="info" title={t("ob.pf.timeline.title")}>
          {hasThreadLabel(c.labels) ? t("ob.pf.timeline.maybe") : t("ob.pf.timeline.no", { labels: c.labels.join(", ") || "—" })}
        </Notice>
      </Panel>
    </>
  );
}

/** The type's series (one point per step): drag to pick a window, click a point = that one interval */
function Timeline({ series, step, unit, start, end, win, onWin, fmtTime }: {
  series: Array<{ t: number; v: number }>; step: number; unit: string; start: number; end: number;
  win: [number, number] | null; onWin: (w: [number, number] | null) => void; fmtTime: (s: number) => string;
}) {
  const { t, locale } = useI18n();
  const box = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(800);
  const [drag, setDrag] = useState<[number, number] | null>(null);
  const [hover, setHover] = useState<number | null>(null);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(240, Math.round(e!.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const H = 96, pad = { l: 84, r: 8, t: 8, b: 18 };
  const top = Math.max(...series.map((p) => p.v), 0) || 1;
  const x = (s: number) => pad.l + ((s - start) / Math.max(1, end - start)) * (w - pad.l - pad.r);
  const y = (v: number) => pad.t + (1 - v / top) * (H - pad.t - pad.b);
  const secOf = (clientX: number) => {
    const r = box.current!.getBoundingClientRect();
    const f = Math.min(1, Math.max(0, (clientX - r.left - pad.l) / (w - pad.l - pad.r)));
    return Math.round(start + f * (end - start));
  };
  const su = seriesUnit(unit);
  const hhmm = (sec: number) => new Date(sec * 1000).toLocaleTimeString(dateLocale(locale), { hour: "2-digit", minute: "2-digit", hour12: false });
  const fmtV = (v: number) => (su.key === "cores" ? `${v.toFixed(v >= 1 ? 2 : 3)} ${t("ob.pf.unit.cores")}` : su.key === "perSec" ? `${valueText(v, unit).n} ${valueText(v, unit).unit}/s` : `${Math.round(v)}`);
  const down = (e: PointerEvent<SVGSVGElement>) => { const s = secOf(e.clientX); setDrag([s, s]); (e.target as Element).setPointerCapture?.(e.pointerId); };
  const move = (e: PointerEvent<SVGSVGElement>) => {
    const s = secOf(e.clientX);
    setHover(s);
    if (drag) setDrag([drag[0], s]);
  };
  const up = () => {
    if (!drag) return;
    const [a, b] = drag[0] <= drag[1] ? drag : [drag[1], drag[0]];
    setDrag(null);
    if (b - a < step) {
      // a click: the interval that point stands for (Pyroscope merges per step — Datadog's single ~60 s profile)
      const pt = series.reduce((best, p) => (Math.abs(p.t / 1000 - a) < Math.abs(best.t / 1000 - a) ? p : best), series[0]!);
      const s0 = Math.floor(pt.t / 1000);
      onWin([s0, s0 + step]);
    } else onWin([a, b]);
  };
  const shown = drag ? (drag[0] <= drag[1] ? drag : [drag[1], drag[0]]) : win;
  const path = series.map((p, i) => `${i ? "L" : "M"}${x(p.t / 1000).toFixed(1)},${y(p.v).toFixed(1)}`).join("");
  const hp = hover === null ? null : series.reduce((best, p) => (Math.abs(p.t / 1000 - hover) < Math.abs(best.t / 1000 - hover) ? p : best), series[0]!);
  return (
    <figure className={styles.pfTimeline} aria-label={t("ob.pf.timeline.aria")}>
      <figcaption>{t(`ob.pf.series.${su.key}`, { s: step })}</figcaption>
      <div ref={box} className={styles.pfTimelineBox} onPointerLeave={() => setHover(null)}>
        <svg width={w} height={H} onPointerDown={down} onPointerMove={move} onPointerUp={up} data-profile-timeline role="img" aria-label={t("ob.pf.timeline.aria")}>
          <line className={styles.pfAxis} x1={pad.l} x2={w - pad.r} y1={H - pad.b} y2={H - pad.b} />
          <text className={styles.pfAxisText} x={pad.l - 6} y={pad.t + 8} textAnchor="end">{fmtV(top)}</text>
          <text className={styles.pfAxisText} x={pad.l - 6} y={H - pad.b} textAnchor="end">0</text>
          {shown ? <rect className={styles.pfSel} x={x(shown[0])} width={Math.max(3, x(shown[1]) - x(shown[0]))} y={pad.t} height={H - pad.t - pad.b} /> : null}
          <path className={styles.pfLine} d={path} />
          {hp ? <circle className={styles.pfDot} cx={x(hp.t / 1000)} cy={y(hp.v)} r={4} /> : null}
          {/* narrow: hours and minutes only — the two full stamps ran into each other at 390 px */}
          <text className={styles.pfAxisText} x={pad.l} y={H - 4}>{w < 560 ? hhmm(start) : fmtTime(start)}</text>
          <text className={styles.pfAxisText} x={w - pad.r} y={H - 4} textAnchor="end">{w < 560 ? hhmm(end) : fmtTime(end)}</text>
        </svg>
        {hp ? <div className={styles.pfTip} style={{ left: Math.min(w - 200, Math.max(0, x(hp.t / 1000) + 8)) }} role="status">{fmtTime(hp.t / 1000)} · {fmtV(hp.v)}</div> : null}
      </div>
    </figure>
  );
}

/** Icicle-style flame graph (root on top, Datadog / Pyroscope): width = share of the focused node, click = zoom in */
function Flame({ tree, prev, unit, focus, onFocus, q, onFn }: { tree: ProfileTree; prev: ProfileTree | null; unit: string; focus: number; onFocus: (i: number) => void; q: string; onFn: (name: string) => void }) {
  const { t } = useI18n();
  const box = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(900);
  const [hover, setHover] = useState<{ i: number; x: number; y: number } | null>(null);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(240, Math.round(e!.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const { rects, ancestors, depth } = useMemo(() => flameRects(tree, focus, 0.5 / w), [tree, focus, w]);
  const diff = useMemo(() => (prev ? shareDiff(tree, prev) : null), [tree, prev]);
  const needle = q.trim().toLowerCase();
  const total = tree.value[0] || 1;
  const hr = hover ? rects.find((r) => r.i === hover.i) ?? null : null;
  const v = (n: number) => { const x = valueText(n, unit); return `${x.n} ${x.unit}`.trim(); };
  return (
    <div className={styles.pfFlameWrap}>
      {ancestors.length ? (
        <nav className={styles.pfCrumbs} aria-label={t("ob.pf.crumbs")}>
          {ancestors.map((a) => <LinkButton key={a} onClick={() => onFocus(a)}>{shortName(tree.names[tree.label[a]!] ?? "")}</LinkButton>)}
          <span>{shortName(tree.names[tree.label[focus]!] ?? "")}</span>
        </nav>
      ) : null}
      <div ref={box} className={styles.pfFlame} style={{ height: depth * FLAME_ROW }} data-flame onPointerLeave={() => setHover(null)}>
        {rects.map((r) => {
          const hit = needle && r.name.toLowerCase().includes(needle);
          const d = diff ? diff[r.i]! : null;
          const bucket = d === null ? undefined : d >= 5 ? "3" : d >= 1 ? "2" : d > 0.1 ? "1" : d <= -5 ? "-3" : d <= -1 ? "-2" : d < -0.1 ? "-1" : "0";
          return (
            <div key={r.i} className={styles.pfFrame} data-kind={frameKind(r.name)} data-diff={bucket} data-hit={hit || undefined} data-dim={(needle && !hit) || undefined}
              style={{ left: r.x * w, width: Math.max(1, r.w * w - 1), top: r.level * FLAME_ROW }}
              onClick={() => { onFocus(r.i); onFn(r.name); }} onPointerMove={(e) => setHover({ i: r.i, x: e.nativeEvent.offsetX + r.x * w, y: r.level * FLAME_ROW })}
              role="button" tabIndex={-1} aria-label={r.name}>
              {r.w * w > 40 ? shortName(r.name) : ""}
            </div>
          );
        })}
        {hr && hover ? (
          <div className={styles.pfTip} style={{ left: Math.min(w - 320, Math.max(0, hover.x + 12)), top: hover.y + FLAME_ROW + 4 }} role="status">
            <strong>{hr.name}</strong>
            <dl>
              <dt>{t("ob.pf.col.total")}</dt><dd>{v(hr.value)} · {((hr.value / total) * 100).toFixed(2)}%</dd>
              <dt>{t("ob.pf.col.self")}</dt><dd>{v(hr.self)} · {((hr.self / total) * 100).toFixed(2)}%</dd>
              {diff ? <><dt>{t("ob.pf.col.diff")}</dt><dd>{diff[hr.i]! >= 0 ? "+" : ""}{diff[hr.i]}%p</dd></> : null}
            </dl>
          </div>
        ) : null}
      </div>
      <ul className={styles.pfLegend}>
        {diff ? (["3", "1", "0", "-1", "-3"] as const).map((b) => <li key={b}><span className={styles.pfKey} data-diff={b} aria-hidden="true" />{t(`ob.pf.diff.${b}`)}</li>)
          : (["code", "runtime", "native"] as const).map((k) => <li key={k}><span className={styles.pfKey} data-kind={k} aria-hidden="true" />{t(`ob.pf.frame.${k}`)}</li>)}
        <li>{t("ob.pf.flameHint")}</li>
      </ul>
    </div>
  );
}

/** Top functions (Datadog "CPU time by Method"): self and total per function — click = its call graph */
function TopTable({ tree, prev, unit, q, onFn }: { tree: ProfileTree; prev: ProfileTree | null; unit: string; q: string; onFn: (name: string) => void }) {
  const { t } = useI18n();
  const rows = useMemo(() => topFunctions(tree), [tree]);
  const diffs = useMemo(() => (prev ? new Map(functionDiff(tree, prev, 100000).map((d) => [d.name, d.deltaPp])) : null), [tree, prev]);
  const total = tree.value[0] || 1;
  const needle = q.trim().toLowerCase();
  const shown = rows.filter((r) => !needle || r.name.toLowerCase().includes(needle)).slice(0, 100);
  const v = (n: number) => { const x = valueText(n, unit); return `${x.n} ${x.unit}`.trim(); };
  return (
    <div className={styles.sloTableWrap}>
      <table className={styles.sloTable} data-top-functions>
        <thead><tr>
          <th>{t("ob.pf.col.fn")}</th><th className={styles.redNum}>{t("ob.pf.col.self")}</th><th className={styles.redNum}>{t("ob.pf.col.total")}</th>
          {diffs ? <th className={styles.redNum}>{t("ob.pf.col.diff")}</th> : null}
        </tr></thead>
        <tbody>
          {shown.map((r) => (
            <tr key={r.name}>
              <td><LinkButton onClick={() => onFn(r.name)}><span className={styles.pfFn} data-kind={frameKind(r.name)} title={r.name}>{r.name}</span></LinkButton></td>
              <td className={styles.redNum}>{v(r.self)} · {((r.self / total) * 100).toFixed(2)}%</td>
              <td className={styles.redNum}>{v(r.total)} · {((r.total / total) * 100).toFixed(2)}%</td>
              {diffs ? <td className={styles.redNum}>{diffs.has(r.name) ? `${diffs.get(r.name)! >= 0 ? "+" : ""}${diffs.get(r.name)}%p` : "0"}</td> : null}
            </tr>
          ))}
        </tbody>
      </table>
      <p className={styles.pfMeta}>{t("ob.pf.topHint", { n: rows.length, s: shown.length })}</p>
    </div>
  );
}

/** Call graph around one function (Datadog: each method once, edge = time calling the callee) — its callers and callees */
function CallGraph({ tree, unit, fn, onFn }: { tree: ProfileTree; unit: string; fn: string | null; onFn: (name: string) => void }) {
  const { t } = useI18n();
  const edges = useMemo(() => callEdges(tree), [tree]);
  const top = useMemo(() => topFunctions(tree), [tree]);
  const name = fn && top.some((r) => r.name === fn) ? fn : top[0]?.name ?? null;
  if (!name) return <EmptyState title={t("ob.pf.empty")} />;
  const me = top.find((r) => r.name === name)!;
  const b = butterfly(edges, name);
  const total = tree.value[0] || 1;
  const max = Math.max(me.total, ...b.callers.map((e) => e.value), ...b.callees.map((e) => e.value), 1);
  const v = (n: number) => { const x = valueText(n, unit); return `${x.n} ${x.unit}`.trim(); };
  const row = (e: { label: string; value: number }, side: "in" | "out") => (
    <li key={`${side}:${e.label}`}>
      <LinkButton onClick={() => onFn(e.label)}><span className={styles.pfFn} data-kind={frameKind(e.label)} title={e.label}>{shortName(e.label)}</span></LinkButton>
      <span className={styles.pfEdge} data-side={side} style={{ width: `${Math.max(2, (e.value / max) * 100)}%` }} aria-hidden="true" />
      <span className={styles.pfEdgeV}>{v(e.value)} · {((e.value / total) * 100).toFixed(1)}%</span>
    </li>
  );
  return (
    <div className={styles.pfCall} data-call-graph>
      <section>
        <h4>{t("ob.pf.callers", { n: b.callers.length + b.moreCallers })}</h4>
        <ul>{b.callers.map((e) => row({ label: e.caller, value: e.value }, "in"))}</ul>
        {b.moreCallers ? <p className={styles.pfMeta}>{t("ob.pf.more", { n: b.moreCallers })}</p> : null}
        {!b.callers.length ? <p className={styles.pfMeta}>{t("ob.pf.noCallers")}</p> : null}
      </section>
      <section className={styles.pfCallMe}>
        <span className={styles.pfFn} data-kind={frameKind(name)} title={name}>{name}</span>
        <dl>
          <dt>{t("ob.pf.col.self")}</dt><dd>{v(me.self)} · {((me.self / total) * 100).toFixed(2)}%</dd>
          <dt>{t("ob.pf.col.total")}</dt><dd>{v(me.total)} · {((me.total / total) * 100).toFixed(2)}%</dd>
        </dl>
        <p className={styles.pfMeta}>{t("ob.pf.callHint")}</p>
      </section>
      <section>
        <h4>{t("ob.pf.callees", { n: b.callees.length + b.moreCallees })}</h4>
        <ul>{b.callees.map((e) => row({ label: e.callee, value: e.value }, "out"))}</ul>
        {b.moreCallees ? <p className={styles.pfMeta}>{t("ob.pf.more", { n: b.moreCallees })}</p> : null}
        {!b.callees.length ? <p className={styles.pfMeta}>{t("ob.pf.noCallees")}</p> : null}
      </section>
    </div>
  );
}
