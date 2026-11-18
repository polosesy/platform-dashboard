"use client";

// 네트워크 › 네트워크 경로 — a user's device → a SaaS endpoint, hop by hop (Datadog Network Path + End User Device
// Monitoring, done honestly): the DEVICE measures with the probe script (Windows) or `mtr --json` (macOS / Linux) and
// the result is uploaded here; the API keeps runs (services/netPath.ts), this page shows per hop latency and loss, the
// device's history per target, and says how loss is read (lib/netPathView.ts). A browser cannot trace hops and the
// dashboard never probes the internet itself — said on the page.
//
// 2026-11-18 2nd pass: ① "what goes in -Target?" — three numbered steps, the target first (presets, an address bar
// pasted as it is → its host, the commands built with it, the script as a download); ② the path read top-down like
// mtr: a latency profile (average per hop, min–max per hop, the biggest added step marked) over a route list (a rail,
// one row per hop, silent runs folded, the numbers in aligned columns) — the same hops twice: the chart for the shape,
// the list for the values.

import { useEffect, useMemo, useRef, useState } from "react";
import type { NetPathResponse, NetPathRun } from "@aud/types";
import { apiUrl, fetchJsonWithBearer } from "@/lib/api";
import { useApiQuery } from "@/lib/useApiQuery";
import { useApiToken } from "@/lib/useApiToken";
import { dateLocale, useI18n } from "@/lib/i18n";
import { Button, Chip, CodeBlock, EmptyState, ErrorNotice, FilterChip, LinkButton, LoadingState, Notice, PageHeader, Panel, SignInNotice, Stat, TextInput } from "@/components/ui";
import { NETPATH_PROBE_PS1 } from "@/lib/netPathProbe";
import {
  TARGET_PRESETS, biggestJump, latencyProfile, msTicks, mtrCommand, pathSeries, pathView, probeCommand, routeRows, samePath, targetOf,
  type HopView, type PathView,
} from "@/lib/netPathView";
import s from "./styles.module.css";

const ms = (v: number | null) => (v === null ? "—" : `${v < 10 ? v.toFixed(1) : Math.round(v)} ms`);
const GLYPH: Record<HopView["verdict"], string> = { ok: "●", silent: "○", icmpLimited: "◌", pathLoss: "▲", destLoss: "▲", unreached: "■" };

/** Save the probe script as a file (BOM: Windows PowerShell 5.1 reads a file without one in the ANSI code page) */
function downloadScript() {
  const blob = new Blob(["﻿" + NETPATH_PROBE_PS1.replace(/\r?\n/g, "\r\n")], { type: "text/plain;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "netpath-probe.ps1";
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

export default function NetworkPathPage() {
  const { t, locale } = useI18n();
  const lc = dateLocale(locale);
  const getToken = useApiToken();
  const q = useApiQuery("netpath", (token) => fetchJsonWithBearer<NetPathResponse>(apiUrl("/api/netpath"), token));
  const d = q.data;
  const series = useMemo(() => pathSeries(d?.runs ?? []), [d]);
  const [pick, setPick] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [device, setDevice] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: "success" | "danger"; text: string } | null>(null);
  const [target, setTarget] = useState<string>(TARGET_PRESETS[0].host);
  // the dashboard's own host is a SaaS too (not when it is a local address)
  const [selfHost, setSelfHost] = useState<string | null>(null);
  useEffect(() => { const h = window.location.hostname; if (targetOf(h).host && h !== "localhost") setSelfHost(h); }, []);
  const tg = targetOf(target);
  const host = tg.host ?? "<host>";
  const run = d?.runs.find((r) => r.id === pick) ?? series[0]?.runs[0] ?? null;
  const ser = run ? series.find((x) => x.target === run.target && x.device === run.device) ?? null : null;

  const upload = async () => {
    setBusy(true);
    try {
      const r = await fetchJsonWithBearer<NetPathRun>(apiUrl("/api/netpath/runs"), await getToken(), { method: "POST", body: JSON.stringify({ text, ...(device.trim() ? { device: device.trim() } : {}) }) });
      setText(""); setPick(r.id); setMsg({ tone: "success", text: t("np.uploaded", { n: r.hops.length, t: r.target }) });
      q.reload();
    } catch (e: unknown) {
      const code = (e as { code?: string })?.code ?? "";
      setMsg({ tone: "danger", text: t(["netpath_not_json", "netpath_unknown_format", "netpath_too_large", "netpath_invalid"].includes(code) ? `np.err.${code}` : "np.err.other", { e: code || String(e) }) });
    } finally { setBusy(false); }
  };
  const remove = async (id: string) => {
    try { await fetchJsonWithBearer(apiUrl("/api/netpath/runs", { id }), await getToken(), { method: "DELETE" }); if (pick === id) setPick(null); q.reload(); }
    catch (e: unknown) { setMsg({ tone: "danger", text: t("np.err.other", { e: String(e) }) }); }
  };
  const presets = [...TARGET_PRESETS.map((p) => ({ id: p.id as string, host: p.host as string })), ...(selfHost ? [{ id: "self", host: selfHost }] : [])];

  return (
    <div className={s.page}>
      <PageHeader />
      {q.error ? <ErrorNotice error={q.error} /> : null}
      {d && !d.signedIn ? <SignInNotice /> : null}
      {d && d.signedIn && !d.durable ? <Notice tone="warning" title={t("np.notDurable")}>{t("np.notDurableHint")}</Notice> : null}

      <Panel title={t("np.measure.title")} sub={t("np.measure.sub")}>
        <ol className={s.steps}>
          <li className={s.step}>
            <h3><span className={s.stepNo} aria-hidden="true">1</span>{t("np.step.target")}</h3>
            <p className={s.muted}>{t("np.target.help")}</p>
            <div className={s.presets} role="group" aria-label={t("np.target.presets")}>
              {presets.map((p) => (
                <FilterChip key={p.id} pressed={tg.host === p.host} title={p.host} onClick={() => setTarget(p.host)}>{t(`np.target.preset.${p.id}`)}</FilterChip>
              ))}
            </div>
            <TextInput label={t("np.target.label")} value={target} onChange={setTarget} maxLength={2048} placeholder="login.microsoftonline.com"
              hint={tg.host ? undefined : t(`np.target.${tg.reason ?? "invalid"}`)} />
            <div className={s.using} data-ok={!!tg.host || undefined} aria-live="polite">
              {tg.host ? (
                <>
                  <span className={s.usingLabel}>{t("np.target.using")}</span>
                  <code>{tg.host}</code>
                  {tg.changed ? <span className={s.usingNote}>{t("np.target.changed")}</span> : null}
                </>
              ) : <span className={s.usingNote}>{t(`np.target.${tg.reason ?? "invalid"}`)}</span>}
            </div>
          </li>
          <li className={s.step}>
            <h3><span className={s.stepNo} aria-hidden="true">2</span>{t("np.step.run")}</h3>
            <h4>{t("np.measure.win")}</h4>
            <p className={s.muted}>{t("np.measure.winHint2")}</p>
            <div className={s.row}>
              <Button onClick={downloadScript}>{t("np.download")}</Button>
              <span className={s.muted}>{t("np.downloadNote")}</span>
            </div>
            <CodeBlock label={t("np.measure.run2")} code={probeCommand(host)} copyLabel={t("np.copy")} copiedLabel={t("np.copied")} />
            <details className={s.script}>
              <summary>{t("np.showScript")}</summary>
              <CodeBlock label="netpath-probe.ps1" code={NETPATH_PROBE_PS1} maxHeight={260} copyLabel={t("np.copy")} copiedLabel={t("np.copied")} />
            </details>
            <h4>{t("np.measure.mtr")}</h4>
            <CodeBlock label="mtr" code={mtrCommand(host)} copyLabel={t("np.copy")} copiedLabel={t("np.copied")} />
          </li>
          <li className={s.step}>
            <h3><span className={s.stepNo} aria-hidden="true">3</span>{t("np.upload.title")}</h3>
            <p className={s.muted}>{t("np.upload.help")}</p>
            <TextInput label={t("np.upload.text")} rows={5} value={text} onChange={setText} maxLength={256 * 1024} placeholder={t("np.upload.ph")} />
            <div className={s.row}>
              <TextInput label={t("np.upload.device")} value={device} onChange={setDevice} maxLength={64} placeholder={t("np.upload.devicePh")} width={240} />
              <Button variant="primary" onClick={() => void upload()} disabled={busy || !text.trim() || !d?.signedIn}>{busy ? t("np.upload.busy") : t("np.upload.go")}</Button>
            </div>
            {msg ? <Notice tone={msg.tone}>{msg.text}</Notice> : null}
          </li>
        </ol>
        <p className={s.readHow}>{t("np.limits")}</p>
      </Panel>

      {!d ? <LoadingState /> : !series.length ? (
        <EmptyState title={t("np.none")}>{t("np.noneHint")}</EmptyState>
      ) : (
        <>
          <Panel title={t("np.targets.title")} sub={t("np.targets.sub", { n: series.length })} flush>
            <div className={s.tableWrap}>
              <table className={s.table}>
                <thead><tr>
                  <th>{t("np.col.target")}</th><th>{t("np.col.device")}</th><th>{t("np.col.last")}</th>
                  <th className={s.num}>{t("np.col.latency")}</th><th className={s.num}>{t("np.col.loss")}</th><th className={s.num}>{t("np.col.hops")}</th><th className={s.num}>{t("np.col.runs")}</th>
                </tr></thead>
                <tbody>
                  {series.map((x) => {
                    const r0 = x.runs[0]!;
                    const v = pathView(r0);
                    const on = run?.target === x.target && run?.device === x.device;
                    return (
                      <tr key={x.key} aria-selected={on} className={on ? s.on : undefined}>
                        <td><LinkButton onClick={() => setPick(r0.id)}>{x.target}</LinkButton>{r0.targetIp ? <span className={s.sub}>{r0.targetIp}</span> : null}</td>
                        <td>{x.device}</td>
                        <td><span className={s.sub}>{new Date(r0.startedAt).toLocaleString(lc)}</span></td>
                        <td className={s.num}>{v.end.reached ? ms(v.end.rttAvg) : <Chip level="danger">{t("np.unreached")}</Chip>}</td>
                        <td className={s.num}>{v.end.lossPct === null ? "—" : v.end.lossPct > 0 ? `▲ ${v.end.lossPct}%` : "0%"}</td>
                        <td className={s.num}>{v.end.hops}</td>
                        <td className={s.num}>{x.runs.length}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Panel>

          {run ? <PathPanel key={run.id} run={run} canDelete={!!d.canDelete} onDelete={() => void remove(run.id)} /> : null}

          {ser && ser.runs.length > 1 ? (
            <Panel title={t("np.history.title", { t: ser.target, d: ser.device })} sub={t("np.history.sub")} flush>
              <div className={s.tableWrap}>
                <table className={s.table}>
                  <thead><tr><th>{t("np.col.when")}</th><th className={s.num}>{t("np.col.latency")}</th><th>{t("np.col.bar")}</th><th className={s.num}>{t("np.col.loss")}</th><th className={s.num}>{t("np.col.hops")}</th><th>{t("np.col.path")}</th></tr></thead>
                  <tbody>
                    {(() => {
                      const max = Math.max(1, ...ser.runs.map((r) => pathView(r).end.rttAvg ?? 0));
                      return ser.runs.map((r, i) => {
                        const v = pathView(r);
                        const prev = ser.runs[i + 1];
                        return (
                          <tr key={r.id} aria-selected={r.id === run?.id} className={r.id === run?.id ? s.on : undefined}>
                            <td><LinkButton onClick={() => setPick(r.id)}>{new Date(r.startedAt).toLocaleString(lc)}</LinkButton></td>
                            <td className={s.num}>{v.end.reached ? ms(v.end.rttAvg) : t("np.unreached")}</td>
                            <td><span className={s.bar} aria-hidden="true"><span style={{ width: `${((v.end.rttAvg ?? 0) / max) * 100}%` }} /></span></td>
                            <td className={s.num}>{v.end.lossPct === null ? "—" : `${v.end.lossPct}%`}</td>
                            <td className={s.num}>{v.end.hops}</td>
                            <td><span className={s.sub}>{prev ? (samePath(r, prev) ? t("np.path.same") : t("np.path.changed")) : "—"}</span></td>
                          </tr>
                        );
                      });
                    })()}
                  </tbody>
                </table>
              </div>
            </Panel>
          ) : null}
        </>
      )}
    </div>
  );
}

/** One run's path: the headline numbers, the latency profile, the route list */
function PathPanel({ run, canDelete, onDelete }: { run: NetPathRun; canDelete: boolean; onDelete: () => void }) {
  const { t, locale } = useI18n();
  const v = pathView(run);
  const jump = biggestJump(v);
  return (
    <Panel title={t("np.path.title", { t: run.target })}
      sub={t("np.path.sub", { d: run.device, at: new Date(run.startedAt).toLocaleString(dateLocale(locale)), p: run.probes, src: run.source === "mtr" ? "mtr" : "netpath-probe" })}
      actions={canDelete ? <Button size="sm" variant="ghost" onClick={onDelete}>{t("np.delete")}</Button> : undefined}>
      <div className={s.stats}>
        <Stat label={t("np.stat.end")} value={v.end.reached ? ms(v.end.rttAvg) : "—"} hint={v.end.reached ? t("np.stat.reached") : t("np.unreached")} />
        <Stat label={t("np.stat.loss")} value={v.end.lossPct === null ? "—" : `${v.end.lossPct}%`} hint={v.lossFrom !== null ? `▲ ${t("np.path.lossFrom", { n: v.lossFrom })}` : t("np.stat.lossHint")} />
        <Stat label={t("np.stat.hops")} value={v.end.hops} hint={t("np.stat.hopsHint", { n: v.silent })} />
        <Stat label={t("np.stat.jump")} value={jump ? `+${ms(jump.ms)}` : "—"} hint={jump ? t("np.stat.jumpHint", { n: jump.ttl }) : t("np.stat.noJump")} />
      </div>
      {run.targetIp ? <p className={s.muted}>{t("np.path.ipNote", { ip: run.targetIp })}</p> : null}
      <LatencyProfile v={v} jump={jump} />
      <RouteList run={run} v={v} jump={jump} />
      <ul className={s.legend}>
        {(["ok", "icmpLimited", "pathLoss", "silent", "unreached"] as const).map((k) => <li key={k} data-verdict={k}><span aria-hidden="true">{GLYPH[k]}</span>{t(`np.legend.${k}`)}</li>)}
      </ul>
    </Panel>
  );
}

const PAD = { l: 52, r: 16, t: 28, b: 30 };
const CHART_H = 220;

/**
 * Latency profile — one series (the average RTT per answering hop), so no legend: the title names it. Per hop the
 * min–max over the probes as a thin bar; a silent stretch is a dashed line (the path goes on, nothing measured); the
 * biggest added step is drawn heavier with its value. Hover a column: a crosshair and that hop's numbers.
 */
function LatencyProfile({ v, jump }: { v: PathView; jump: { ttl: number; ms: number } | null }) {
  const { t } = useI18n();
  const box = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(800);
  const [hover, setHover] = useState<number | null>(null);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(280, Math.round(e!.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const { points, top, ttls } = latencyProfile(v);
  const ticks = msTicks(top);
  const yTop = ticks[ticks.length - 1]!;
  const plotW = w - PAD.l - PAD.r, plotH = CHART_H - PAD.t - PAD.b;
  const col = plotW / Math.max(1, ttls);
  const x = (ttl: number) => PAD.l + (ttl - 0.5) * col;
  const y = (msv: number) => PAD.t + plotH - (msv / yTop) * plotH;
  const segs: { a: (typeof points)[number]; b: (typeof points)[number]; gap: boolean; big: boolean }[] = [];
  for (let i = 1; i < points.length; i++) segs.push({ a: points[i - 1]!, b: points[i]!, gap: points[i]!.ttl - points[i - 1]!.ttl > 1, big: jump?.ttl === points[i]!.ttl });
  const hp = hover === null ? null : v.hops.find((h) => h.ttl === hover) ?? null;
  const every = ttls > 24 ? 2 : 1;
  return (
    <figure className={s.chart} aria-label={t("np.chart.title")}>
      <figcaption className={s.chartHead}>
        <strong>{t("np.chart.title")}</strong>
        <span>{t("np.chart.sub")}</span>
      </figcaption>
      <div ref={box} className={s.chartBox} onMouseLeave={() => setHover(null)}>
        <svg width={w} height={CHART_H} data-chart="latency" role="img" aria-label={t("np.chart.aria", { n: points.length, top: ms(top) })}>
          {ticks.map((tk) => (
            <g key={tk}>
              <line className={s.grid} x1={PAD.l} x2={w - PAD.r} y1={y(tk)} y2={y(tk)} />
              <text className={s.axis} x={PAD.l - 8} y={y(tk) + 4} textAnchor="end">{tk === 0 ? "0" : `${tk} ms`}</text>
            </g>
          ))}
          {v.hops.map((h) => (h.ttl % every === 0 || h.ttl === 1 || h.ttl === ttls ? (
            <text key={`x${h.ttl}`} className={s.axis} x={x(h.ttl)} y={CHART_H - 10} textAnchor="middle">{h.ttl}</text>
          ) : null))}
          {hp ? <line className={s.cross} x1={x(hp.ttl)} x2={x(hp.ttl)} y1={PAD.t - 8} y2={PAD.t + plotH} /> : null}
          {/* min–max per hop */}
          {points.map((p) => <rect key={`r${p.ttl}`} className={s.range} x={x(p.ttl) - 3} width={6} y={y(p.max)} height={Math.max(2, y(p.min) - y(p.max))} rx={3} />)}
          {/* silent hops: a mark on the base line */}
          {v.hops.filter((h) => h.verdict === "silent").map((h) => <text key={`s${h.ttl}`} className={s.silentMark} x={x(h.ttl)} y={PAD.t + plotH - 4} textAnchor="middle">*</text>)}
          {segs.map((g) => (
            <line key={`l${g.b.ttl}`} className={g.big ? s.lineBig : g.gap ? s.lineGap : s.line} x1={x(g.a.ttl)} y1={y(g.a.avg)} x2={x(g.b.ttl)} y2={y(g.b.avg)} />
          ))}
          {points.map((p) => (
            <circle key={`p${p.ttl}`} data-point data-verdict={p.verdict} className={s.point} cx={x(p.ttl)} cy={y(p.avg)} r={hover === p.ttl ? 6 : 4.5} />
          ))}
          {jump ? (() => {
            const p = points.find((q) => q.ttl === jump.ttl)!;
            const lx = Math.min(w - PAD.r - 60, Math.max(PAD.l + 4, x(p.ttl) - col / 2));
            return <text className={s.jumpLabel} x={lx} y={Math.max(PAD.t - 10, y(p.max) - 10)}>{`+${ms(jump.ms)}`}</text>;
          })() : null}
          {/* hover targets: one column per hop */}
          {v.hops.map((h) => <rect key={`h${h.ttl}`} className={s.hit} x={PAD.l + (h.ttl - 1) * col} width={col} y={PAD.t - 8} height={plotH + 8} onMouseEnter={() => setHover(h.ttl)} />)}
        </svg>
        {hp ? (
          <div className={s.tip} style={{ left: Math.min(w - 220, Math.max(0, x(hp.ttl) + 12)), top: 8 }} role="status">
            <strong>{t("np.chart.hop", { n: hp.ttl })}</strong> <code>{hp.ip ?? "*"}</code>
            {hp.ip ? (
              <dl>
                <dt>{t("np.cell.rtt")}</dt><dd>{ms(hp.rttAvg)}</dd>
                <dt>{t("np.chart.range")}</dt><dd>{ms(hp.rttMin)} – {ms(hp.rttMax)}</dd>
                <dt>{t("np.cell.loss")}</dt><dd>{hp.lossPct}%</dd>
                <dt>{t("np.cell.added")}</dt><dd>{hp.addedMs === null ? "—" : `+${ms(hp.addedMs)}`}</dd>
              </dl>
            ) : <p>{t("np.why.silent")}</p>}
          </div>
        ) : null}
      </div>
    </figure>
  );
}

/** The route, top-down like mtr: the device, then one row per hop (silent runs folded), the destination last */
function RouteList({ run, v, jump }: { run: NetPathRun; v: PathView; jump: { ttl: number; ms: number } | null }) {
  const { t } = useI18n();
  const rows = routeRows(v);
  const top = latencyProfile(v).top;
  let seg: HopView["segment"] | null = null;
  return (
    <div className={s.routeWrap}>
      <div className={s.routeCols} aria-hidden="true">
        <span /><span>TTL</span><span>{t("np.route.addr")}</span><span>{t("np.route.rtt")}</span>
        <span className={s.n}>{t("np.cell.rtt")}</span><span className={s.n}>{t("np.cell.loss")}</span><span className={s.n}>{t("np.cell.added")}</span>
      </div>
      <ol className={s.route} aria-label={t("np.route.title")}>
        <li className={s.routeRow} data-kind="source">
          <span className={s.rail}><span className={s.dot} aria-hidden="true">◆</span></span>
          <span className={s.ttl}>0</span>
          <span className={s.addr}><strong>{run.device}</strong><span className={s.sub}>{t("np.source")}</span></span>
        </li>
        {rows.map((r) => {
          const segment = r.kind === "hop" ? r.hop.segment : r.segment;
          const head = segment !== seg ? <li key={`seg-${segment}-${r.kind === "hop" ? r.hop.ttl : r.from}`} className={s.routeSeg} role="presentation">{t(`np.seg.${segment}`)}</li> : null;
          seg = segment;
          if (r.kind === "silent") {
            return [head, (
              <li key={`silent-${r.from}`} className={s.routeRow} data-kind="silent" data-hop>
                <span className={s.rail}><span className={s.dot} aria-hidden="true">○</span></span>
                <span className={s.ttl}>{r.from === r.to ? r.from : `${r.from}–${r.to}`}</span>
                <span className={s.silentText}>{t("np.route.silent", { n: r.count })}</span>
              </li>
            )];
          }
          const h = r.hop;
          const big = jump?.ttl === h.ttl;
          const why = h.verdict === "icmpLimited" || h.verdict === "pathLoss" || h.verdict === "destLoss" || h.verdict === "unreached";
          return [head, (
            <li key={h.ttl} className={s.routeRow} data-hop data-ttl={h.ttl} data-verdict={h.verdict} data-dest={h.segment === "destination" || undefined} data-biggest={big || undefined}>
              <span className={s.rail}><span className={s.dot} aria-hidden="true">{GLYPH[h.verdict]}</span></span>
              <span className={s.ttl}>{h.ttl}</span>
              <span className={s.addr}>
                <code>{h.ip}</code>
                {h.scope ? <span className={s.scope}>{t(`np.scope.${h.scope}`)}</span> : null}
                {h.others.length ? <span className={s.sub} title={h.others.join(", ")}>{t("np.others", { n: h.others.length })}</span> : null}
              </span>
              <span className={s.rttBar} aria-hidden="true">
                {h.rttAvg !== null ? (
                  <>
                    <span className={s.rttRange} style={{ left: `${((h.rttMin ?? h.rttAvg) / top) * 100}%`, width: `${Math.max(0.6, (((h.rttMax ?? h.rttAvg) - (h.rttMin ?? h.rttAvg)) / top) * 100)}%` }} />
                    <span className={s.rttAvg} style={{ left: `${(h.rttAvg / top) * 100}%` }} />
                  </>
                ) : null}
              </span>
              <span className={s.n}>{ms(h.rttAvg)}</span>
              <span className={s.n} data-hot={h.verdict === "pathLoss" || h.verdict === "destLoss" || undefined}>{h.lossPct}%</span>
              <span className={s.n} data-big={big || undefined}>{h.addedMs === null ? "—" : `+${ms(h.addedMs)}`}</span>
              {why ? <span className={s.why}>{t(`np.why.${h.verdict}`)}</span> : null}
              {big ? <span className={s.why} data-big>{t("np.route.biggest")}</span> : null}
            </li>
          )];
        })}
      </ol>
    </div>
  );
}
