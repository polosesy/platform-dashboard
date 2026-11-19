"use client";

// 네트워크 › 네트워크 경로 — a user's device → a SaaS endpoint, hop by hop (Datadog End User Device Monitoring + Network
// Path, done honestly): the DEVICE measures with the probe script (Windows) or `mtr --json` (macOS / Linux) and the
// result is uploaded here; the API keeps the runs (services/netPath.ts). The dashboard never probes the internet itself.
//
// 2026-11-19 (Datadog Network Path's Explorer): the paths (device × target) → a path's detail: [Path View | Analysis]
// over the runs picked on the health bar (the latency / reachability strip of every run). Path View = the multipath
// graph of the traceroutes (lib/netPathGraph.ts — search, hide unknown hops, group by AS / segment, collapse);
// Analysis = end-to-end numbers, their series, the hop-to-hop latency, the hop table (against the previous range), the
// runs. The probe (aud-netpath/2) keeps every traceroute probe by probe and end-to-end probes (TCP 443 by default).

import { useEffect, useMemo, useState } from "react";
import type { NetPathResponse, NetPathRun } from "@aud/types";
import { apiUrl, fetchJsonWithBearer } from "@/lib/api";
import { useApiQuery } from "@/lib/useApiQuery";
import { useApiToken } from "@/lib/useApiToken";
import { dateLocale, useI18n } from "@/lib/i18n";
import { Button, Chip, CodeBlock, EmptyState, ErrorNotice, FilterChip, LinkButton, LoadingState, Notice, PageHeader, Panel, SignInNotice, Tabs, TextInput } from "@/components/ui";
import { NETPATH_PROBE_PS1 } from "@/lib/netPathProbe";
import { TARGET_PRESETS, mtrCommand, pathSeries, probeCommand, probeLookupCommand, probeRepeatCommand, targetOf, type PathSeries } from "@/lib/netPathView";
import { linkKind, runPoints } from "@/lib/netPathGraph";
import { AnalysisView } from "./AnalysisView";
import { HealthBar } from "./HealthBar";
import { ms } from "./LatencyProfile";
import { PathGraph } from "./PathGraph";
import s from "./styles.module.css";

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
  const [pickKey, setPickKey] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ tone: "success" | "danger"; text: string } | null>(null);
  const ser = series.find((x) => x.key === pickKey) ?? series[0] ?? null;

  const remove = async (id: string) => {
    try { await fetchJsonWithBearer(apiUrl("/api/netpath/runs", { id }), await getToken(), { method: "DELETE" }); q.reload(); }
    catch (e: unknown) { setMsg({ tone: "danger", text: t("np.err.other", { e: String(e) }) }); }
  };

  return (
    <div className={s.page}>
      <PageHeader />
      {q.error ? <ErrorNotice error={q.error} /> : null}
      {d && !d.signedIn ? <SignInNotice /> : null}
      {d && d.signedIn && !d.durable ? <Notice tone="warning" title={t("np.notDurable")}>{t("np.notDurableHint")}</Notice> : null}
      {msg ? <Notice tone={msg.tone}>{msg.text}</Notice> : null}

      {!d ? <LoadingState /> : !series.length ? (
        <>
          <EmptyState title={t("np.none")}>{t("np.noneHint")}</EmptyState>
          <MeasurePanel signedIn={!!d.signedIn} onUploaded={(runs) => { setPickKey(`${runs[0]!.target}|${runs[0]!.device}`); q.reload(); }} />
        </>
      ) : (
        <>
          <Panel title={t("np.targets.title")} sub={t("np.targets.sub", { n: series.length })} flush>
            <div className={s.tableWrap}>
              <table className={s.table}>
                <thead><tr>
                  <th>{t("np.col.target")}</th><th>{t("np.col.device")}</th><th>{t("np.col.last")}</th>
                  <th className={s.num}>{t("np.col.reach")}</th><th className={s.num}>{t("np.col.latency")}</th><th className={s.num}>{t("np.col.loss")}</th>
                  <th className={s.num}>{t("np.an.jitter")}</th><th className={s.num}>{t("np.col.hops")}</th><th className={s.num}>{t("np.col.runs")}</th>
                </tr></thead>
                <tbody>
                  {series.map((x) => {
                    const pts = runPoints(x.runs);
                    const p = pts[pts.length - 1]!;
                    const on = ser?.key === x.key;
                    const reach = pts.filter((y) => y.reachable).length;
                    return (
                      <tr key={x.key} aria-selected={on} className={on ? s.on : undefined}>
                        <td><LinkButton onClick={() => setPickKey(x.key)}>{x.target}</LinkButton>{x.runs[0]!.targetIp ? <span className={s.sub}>{x.runs[0]!.targetIp}</span> : null}</td>
                        <td>{x.device}</td>
                        <td><span className={s.sub}>{new Date(p.at).toLocaleString(lc)}</span></td>
                        <td className={s.num}>{reach === pts.length ? `${reach}/${pts.length}` : <Chip level="danger">{`${reach}/${pts.length}`}</Chip>}</td>
                        <td className={s.num}>{p.reachable ? ms(p.latency) : <Chip level="danger">{t("np.unreached")}</Chip>}</td>
                        <td className={s.num}>{p.lossPct === null ? "—" : p.lossPct > 0 ? `▲ ${p.lossPct}%` : "0%"}</td>
                        <td className={s.num}>{ms(p.jitter)}</td>
                        <td className={s.num}>{p.hops}</td>
                        <td className={s.num}>{x.runs.length}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Panel>

          {ser ? <PathDetail key={ser.key} ser={ser} canDelete={!!d.canDelete} onDelete={(id) => void remove(id)} /> : null}

          <MeasurePanel signedIn={!!d.signedIn} onUploaded={(runs) => { setPickKey(`${runs[0]!.target}|${runs[0]!.device}`); q.reload(); }} />
        </>
      )}
    </div>
  );
}

type View = "path" | "analysis";

/** One device × target: the head, [Path View | Analysis] over the runs picked on the health bar */
function PathDetail({ ser, canDelete, onDelete }: { ser: PathSeries; canDelete: boolean; onDelete: (id: string) => void }) {
  const { t } = useI18n();
  const [view, setView] = useState<View>("path");
  const points = useMemo(() => runPoints(ser.runs), [ser.runs]);
  const last = points[points.length - 1]!.at;
  const [sel, setSel] = useState<[number, number]>([last, last]);
  // a new upload of this series: follow the newest run if the newest was picked
  useEffect(() => { setSel((cur) => (points.some((p) => p.at === cur[0]) && points.some((p) => p.at === cur[1]) ? cur : [last, last])); }, [points, last]);
  const picked = useMemo(() => ser.runs.filter((r) => { const at = Date.parse(r.startedAt); return at >= sel[0] && at <= sel[1]; }), [ser.runs, sel]);
  const link = ser.runs[0]!.link;
  const lk = linkKind(link?.type);
  return (
    <Panel title={ser.target} sub={t("np.detail.sub2", { d: ser.device, n: picked.length, m: ser.runs.length })}
      actions={<span className={s.pathActions}>
        {lk ? <Chip level="neutral" glyph={false} title={t("np.link.hint")}>{t("np.an.link", { k: t(`np.link.${lk}`), m: link?.mbps ?? "—" })}</Chip> : null}
        <Button size="sm" onClick={() => setSel([points[0]!.at, last])} disabled={points.length < 2}>{t("np.hb.all")}</Button>
        <Button size="sm" onClick={() => setSel([last, last])}>{t("np.hb.latest")}</Button>
      </span>}>
      <Tabs<View> label={t("np.detail.views")} value={view} onChange={setView} idPrefix="np"
        items={[
          { id: "path", label: <span className={s.tabTwo}><strong>{t("np.view.path")}</strong><span>{t("np.view.pathSub")}</span></span> },
          { id: "analysis", label: <span className={s.tabTwo}><strong>{t("np.view.analysis")}</strong><span>{t("np.view.analysisSub")}</span></span> },
        ]} />
      <div className={s.viewBody} role="tabpanel" id={`np-panel-${view}`} aria-labelledby={`np-${view}`}>
        {view === "path"
          ? <PathGraph key={picked.map((r) => r.id).join(",")} runs={picked} target={ser.target} device={ser.device} />
          : <AnalysisView all={ser.runs} picked={picked} points={points} sel={sel} canDelete={canDelete} onDelete={onDelete} onPick={(a, b) => setSel([a, b])} />}
      </div>
      <HealthBar points={points} sel={sel} onSel={(a, b) => setSel([a, b])} />
    </Panel>
  );
}

/** 1 target → 2 run on the device → 3 upload (one run, or the lines of a repeated run) */
function MeasurePanel({ signedIn, onUploaded }: { signedIn: boolean; onUploaded: (runs: NetPathRun[]) => void }) {
  const { t } = useI18n();
  const getToken = useApiToken();
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
  const presets = [...TARGET_PRESETS.map((p) => ({ id: p.id as string, host: p.host as string })), ...(selfHost ? [{ id: "self", host: selfHost }] : [])];
  const upload = async () => {
    setBusy(true);
    try {
      const r = await fetchJsonWithBearer<{ runs: NetPathRun[] }>(apiUrl("/api/netpath/runs"), await getToken(), { method: "POST", body: JSON.stringify({ text, ...(device.trim() ? { device: device.trim() } : {}) }) });
      setText("");
      setMsg({ tone: "success", text: r.runs.length > 1 ? t("np.uploadedMany", { n: r.runs.length, t: r.runs[0]!.target }) : t("np.uploaded", { n: r.runs[0]!.hops.length, t: r.runs[0]!.target }) });
      onUploaded(r.runs);
    } catch (e: unknown) {
      const code = (e as { code?: string })?.code ?? "";
      setMsg({ tone: "danger", text: t(["netpath_not_json", "netpath_unknown_format", "netpath_too_large", "netpath_invalid"].includes(code) ? `np.err.${code}` : "np.err.other", { e: code || String(e) }) });
    } finally { setBusy(false); }
  };
  return (
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
          <p className={s.muted}>{t("np.measure.winHint3")}</p>
          <div className={s.row}>
            <Button onClick={downloadScript}>{t("np.download")}</Button>
            <span className={s.muted}>{t("np.downloadNote")}</span>
          </div>
          <CodeBlock label={t("np.measure.run2")} code={probeCommand(host)} copyLabel={t("np.copy")} copiedLabel={t("np.copied")} />
          <CodeBlock label={t("np.measure.repeat")} code={probeRepeatCommand(host)} copyLabel={t("np.copy")} copiedLabel={t("np.copied")} />
          <details className={s.script}>
            <summary>{t("np.measure.lookup")}</summary>
            <p className={s.muted}>{t("np.measure.lookupHint")}</p>
            <CodeBlock label="-Lookup" code={probeLookupCommand(host)} copyLabel={t("np.copy")} copiedLabel={t("np.copied")} />
          </details>
          <details className={s.script}>
            <summary>{t("np.showScript")}</summary>
            <CodeBlock label="netpath-probe.ps1" code={NETPATH_PROBE_PS1} maxHeight={260} copyLabel={t("np.copy")} copiedLabel={t("np.copied")} />
          </details>
          <h4>{t("np.measure.mtr")}</h4>
          <CodeBlock label="mtr" code={mtrCommand(host)} copyLabel={t("np.copy")} copiedLabel={t("np.copied")} />
        </li>
        <li className={s.step}>
          <h3><span className={s.stepNo} aria-hidden="true">3</span>{t("np.upload.title")}</h3>
          <p className={s.muted}>{t("np.upload.help2")}</p>
          <TextInput label={t("np.upload.text")} rows={5} value={text} onChange={setText} maxLength={900 * 1024} placeholder={t("np.upload.ph")} />
          <div className={s.row}>
            <TextInput label={t("np.upload.device")} value={device} onChange={setDevice} maxLength={64} placeholder={t("np.upload.devicePh")} width={240} />
            <Button variant="primary" onClick={() => void upload()} disabled={busy || !text.trim() || !signedIn}>{busy ? t("np.upload.busy") : t("np.upload.go")}</Button>
          </div>
          {msg ? <Notice tone={msg.tone}>{msg.text}</Notice> : null}
        </li>
      </ol>
      <p className={s.readHow}>{t("np.limits2")}</p>
    </Panel>
  );
}
