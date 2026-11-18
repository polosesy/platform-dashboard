"use client";

// 네트워크 › 네트워크 경로 — a user's device → a SaaS endpoint, hop by hop (Datadog Network Path + End User Device
// Monitoring, done honestly): the DEVICE measures with the probe script (Windows) or `mtr --json` (macOS / Linux) and
// the result is uploaded here; the API keeps runs (services/netPath.ts), this page shows per hop latency and loss, the
// device's history per target, and says how loss is read (lib/netPathView.ts). A browser cannot trace hops and the
// dashboard never probes the internet itself — said on the page.

import { useMemo, useState } from "react";
import type { NetPathResponse, NetPathRun } from "@aud/types";
import { apiUrl, fetchJsonWithBearer } from "@/lib/api";
import { useApiQuery } from "@/lib/useApiQuery";
import { useApiToken } from "@/lib/useApiToken";
import { dateLocale, useI18n } from "@/lib/i18n";
import { Button, Chip, CodeBlock, EmptyState, ErrorNotice, LinkButton, LoadingState, Notice, PageHeader, Panel, SignInNotice, TextInput, Toggle } from "@/components/ui";
import { NETPATH_PROBE_PS1 } from "@/lib/netPathProbe";
import { pathSeries, pathView, samePath, type HopView } from "@/lib/netPathView";
import s from "./styles.module.css";

const WIN_CMD = "powershell -ExecutionPolicy Bypass -File netpath-probe.ps1 -Target login.microsoftonline.com | Set-Clipboard";
const MTR_CMD = "mtr --json -n -c 10 login.microsoftonline.com | pbcopy   # Linux: | xclip -selection clipboard";
const ms = (v: number | null) => (v === null ? "—" : `${v < 10 ? v.toFixed(1) : Math.round(v)} ms`);
const GLYPH: Record<HopView["verdict"], string> = { ok: "●", silent: "○", icmpLimited: "◌", pathLoss: "▲", destLoss: "▲", unreached: "■" };

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
  const [hideSilent, setHideSilent] = useState(false);
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

  return (
    <div className={s.page}>
      <PageHeader />
      {q.error ? <ErrorNotice error={q.error} /> : null}
      {d && !d.signedIn ? <SignInNotice /> : null}
      {d && d.signedIn && !d.durable ? <Notice tone="warning" title={t("np.notDurable")}>{t("np.notDurableHint")}</Notice> : null}

      <Panel title={t("np.measure.title")} sub={t("np.measure.sub")}>
        <div className={s.steps}>
          <section>
            <h3>{t("np.measure.win")}</h3>
            <p className={s.muted}>{t("np.measure.winHint")}</p>
            <CodeBlock label="netpath-probe.ps1" code={NETPATH_PROBE_PS1} maxHeight={220} copyLabel={t("np.copy")} copiedLabel={t("np.copied")} />
            <CodeBlock label={t("np.measure.run")} code={WIN_CMD} copyLabel={t("np.copy")} copiedLabel={t("np.copied")} />
          </section>
          <section>
            <h3>{t("np.measure.mtr")}</h3>
            <p className={s.muted}>{t("np.measure.mtrHint")}</p>
            <CodeBlock label="mtr" code={MTR_CMD} copyLabel={t("np.copy")} copiedLabel={t("np.copied")} />
          </section>
          <section>
            <h3>{t("np.upload.title")}</h3>
            <TextInput label={t("np.upload.text")} rows={5} value={text} onChange={setText} maxLength={256 * 1024} placeholder={t("np.upload.ph")} />
            <div className={s.row}>
              <TextInput label={t("np.upload.device")} value={device} onChange={setDevice} maxLength={64} placeholder={t("np.upload.devicePh")} width={240} />
              <Button variant="primary" onClick={() => void upload()} disabled={busy || !text.trim() || !d?.signedIn}>{busy ? t("np.upload.busy") : t("np.upload.go")}</Button>
            </div>
            {msg ? <Notice tone={msg.tone}>{msg.text}</Notice> : null}
          </section>
        </div>
        <p className={s.muted}>{t("np.limits")}</p>
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

          {run ? <PathPanel run={run} hideSilent={hideSilent} onHideSilent={setHideSilent} canDelete={!!d.canDelete} onDelete={() => void remove(run.id)} /> : null}

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

/** One run's path, left → right: segments (the device's network · the way · the destination), a card per hop */
function PathPanel({ run, hideSilent, onHideSilent, canDelete, onDelete }: { run: NetPathRun; hideSilent: boolean; onHideSilent: (v: boolean) => void; canDelete: boolean; onDelete: () => void }) {
  const { t, locale } = useI18n();
  const v = pathView(run, hideSilent);
  const segs = (["local", "transit", "destination"] as const).map((k) => ({ k, hops: v.hops.filter((h) => h.segment === k) })).filter((x) => x.hops.length);
  return (
    <Panel title={t("np.path.title", { t: run.target })}
      sub={t("np.path.sub", { d: run.device, at: new Date(run.startedAt).toLocaleString(dateLocale(locale)), p: run.probes, src: run.source === "mtr" ? "mtr" : "netpath-probe" })}
      actions={<>
        <Toggle checked={hideSilent} onChange={onHideSilent}>{t("np.hideSilent", { n: v.silent })}</Toggle>
        {canDelete ? <Button size="sm" variant="ghost" onClick={onDelete}>{t("np.delete")}</Button> : null}
      </>}>
      <p className={s.summary}>
        {v.end.reached ? t("np.path.reached", { ms: ms(v.end.rttAvg), loss: v.end.lossPct ?? 0, h: v.end.hops }) : t("np.path.notReached", { h: v.end.hops })}
        {run.targetIp ? ` · ${t("np.path.ip", { ip: run.targetIp })}` : ""}
        {v.lossFrom !== null ? ` · ▲ ${t("np.path.lossFrom", { n: v.lossFrom })}` : ""}
      </p>
      <div className={s.path}>
        <div className={s.endpoint} data-kind="source"><strong>{run.device}</strong><small>{t("np.source")}</small></div>
        {segs.map((g) => (
          <section key={g.k} className={s.segment} data-seg={g.k} aria-label={t(`np.seg.${g.k}`)}>
            <h4>{t(`np.seg.${g.k}`)}</h4>
            <ol className={s.hops}>
              {g.hops.map((h) => (
                <li key={h.ttl} className={s.hop} data-verdict={h.verdict} title={t(`np.why.${h.verdict}`)}>
                  <span className={s.hopTop}><span aria-hidden="true">{GLYPH[h.verdict]}</span><b>{h.ttl}</b><span className={s.ip}>{h.ip ?? "*"}</span></span>
                  {h.ip ? (
                    <span className={s.hopCells}>
                      <span><small>{t("np.cell.rtt")}</small>{ms(h.rttAvg)}</span>
                      <span><small>{t("np.cell.loss")}</small>{h.lossPct}%</span>
                      <span><small>{t("np.cell.added")}</small>{h.addedMs === null ? "—" : `+${ms(h.addedMs)}`}</span>
                    </span>
                  ) : <span className={s.sub}>{t("np.why.silent")}</span>}
                  {h.others.length ? <span className={s.sub}>{t("np.others", { n: h.others.length })}</span> : null}
                  {h.scope ? <span className={s.scope}>{t(`np.scope.${h.scope}`)}</span> : null}
                </li>
              ))}
            </ol>
          </section>
        ))}
      </div>
      <ul className={s.legend}>
        {(["ok", "icmpLimited", "pathLoss", "silent", "unreached"] as const).map((k) => <li key={k} data-verdict={k}><span aria-hidden="true">{GLYPH[k]}</span>{t(`np.legend.${k}`)}</li>)}
      </ul>
    </Panel>
  );
}
