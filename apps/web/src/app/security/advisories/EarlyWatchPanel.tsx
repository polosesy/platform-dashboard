"use client";

// 긴급 취약점 › 선제 감시 (API /api/security/early-watch — services/earlyWatch.ts): what the background watcher found
// on the vendors' own pages, when this dashboard first saw it, the selected cluster's Java workloads against the
// announced versions, and the team's watched CVE IDs (RESERVED → PUBLISHED on CVE.org). New things also go to the
// alert center and its channels.

import { useState } from "react";
import type { AppMetricsResponse, EarlyWatchResponse, OracleCycle } from "@aud/types";
import { ApiError, apiUrl, fetchJsonWithBearer } from "@/lib/api";
import { useApiQuery } from "@/lib/useApiQuery";
import { useApiToken } from "@/lib/useApiToken";
import { dateLocale, useI18n } from "@/lib/i18n";
import { exposureCounts, javaExposure, untilParts, type JavaVerdict } from "@/lib/earlyWatchView";
import { Badge, Button, Chip, ErrorNotice, LinkButton, Panel, TextInput } from "@/components/ui";
import s from "./earlyWatch.module.css";

const VERDICT_TONE: Record<JavaVerdict, "high" | "medium" | "success" | "neutral"> = { affected: "high", unknown: "medium", lineNotListed: "medium", newer: "success" };
const STATE_LEVEL = { ok: "ok", failed: "danger", disabled: "unknown", unchecked: "unknown" } as const;

export function EarlyWatchPanel({ clusterId }: { clusterId: string }) {
  const { t, locale } = useI18n();
  const getToken = useApiToken();
  const q = useApiQuery("early-watch", (token) => fetchJsonWithBearer<EarlyWatchResponse>(apiUrl("/api/security/early-watch"), token));
  const apps = useApiQuery(clusterId ? `app-metrics:${clusterId}` : null, (token) =>
    fetchJsonWithBearer<AppMetricsResponse>(apiUrl("/api/observability/app-metrics", { clusterId }), token));
  const [draft, setDraft] = useState("");
  const [note, setNote] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const d = q.data;
  if (q.error) {
    // signed out: the rest of the page explains sign-in — this panel stays quiet
    return /signin|401/i.test(q.error) ? null : <Panel title={t("ew.title")}><ErrorNotice error={q.error} /></Panel>;
  }
  if (!d) return null;
  const when = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString(dateLocale(locale), { timeZoneName: "short" }) : "—");
  const rows = javaExposure(apps.data?.workloads ?? [], d);
  const counts = exposureCounts(rows);

  const write = async (watch: Array<{ id: string; note?: string }>) => {
    setBusy(true); setMsg(null);
    try {
      const token = await getToken().catch(() => null);
      await fetchJsonWithBearer(apiUrl("/api/security/early-watch"), token, { method: "PUT", body: JSON.stringify({ watch, baseRev: d.rev }) });
      setDraft(""); setNote("");
      await q.reload?.();
    } catch (e) {
      setMsg(e instanceof ApiError && e.status === 409 ? t("ew.watch.conflict") : e instanceof ApiError && e.status === 400 ? t("ew.watch.invalid") : t("ew.watch.failed"));
      if (e instanceof ApiError && e.status === 409) await q.reload?.();
    } finally { setBusy(false); }
  };
  const add = () => {
    const ids = draft.toUpperCase().match(/CVE-\d{4}-\d{4,7}/g) ?? [];
    if (!ids.length) { setMsg(t("ew.watch.invalid")); return; }
    const cur = d.watch.map((w) => ({ id: w.id, ...(w.note ? { note: w.note } : {}) }));
    void write([...cur, ...ids.filter((id) => !cur.some((c) => c.id === id)).map((id) => ({ id, ...(note.trim() ? { note: note.trim() } : {}) }))]);
  };
  const remove = (id: string) => void write(d.watch.filter((w) => w.id !== id).map((w) => ({ id: w.id, ...(w.note ? { note: w.note } : {}) })));
  const checkNow = async () => {
    setBusy(true); setMsg(null);
    try {
      const token = await getToken().catch(() => null);
      await fetchJsonWithBearer(apiUrl("/api/security/early-watch/check"), token, { method: "POST" });
      await q.reload?.();
    } catch (e) {
      setMsg(e instanceof ApiError && e.status === 429 ? t("ew.check.tooSoon") : t("ew.check.failed"));
    } finally { setBusy(false); }
  };

  const cycle = (c: OracleCycle, main: boolean) => {
    const u = untilParts(c.releaseAt, new Date());
    return (
      <div className={s.cycle} data-state={c.state}>
        <div className={s.cycleHead}>
          <strong>{t(`ew.oracle.kind.${c.kind}`)} {c.month}</strong>
          <Chip level={c.state === "preRelease" || c.state === "released" ? "warn" : c.state === "failed" ? "danger" : "neutral"}>{t(`ew.oracle.state.${c.state}`)}</Chip>
          <a href={c.url} target="_blank" rel="noreferrer">{t("ew.official")} ↗</a>
        </div>
        <p className={s.dim}>
          {t("ew.oracle.schedule", { pre: c.preReleaseDate, rel: when(c.releaseAt) })}
          {main ? ` · ${u.past ? t("ew.oracle.ago", { h: u.h, m: u.m }) : t("ew.oracle.in", { h: u.h, m: u.m })}` : ""}
        </p>
        {main && (c.state === "preRelease" || c.state === "released") ? (
          <p className={s.dim}>{t("ew.oracle.seen", { oracle: when(c.updatedAt), us: when(c.firstSeenAt) })}</p>
        ) : null}
        {main && c.java ? (
          <div className={s.java}>
            <span>{t("ew.java.patches", { n: c.java.patches ?? "?" })}</span>
            <span>{c.java.remoteUnauth === "all" ? t("ew.java.remoteAll") : c.java.remoteUnauth !== null ? t("ew.java.remoteN", { n: c.java.remoteUnauth }) : ""}</span>
            {c.java.maxScore !== null ? <Badge tone={c.java.maxScore >= 9 ? "high" : c.java.maxScore >= 7 ? "medium" : "low"}>CVSS v{c.java.scoreVersion ?? "?"} {c.java.maxScore}</Badge> : null}
            <span className={s.mono}>{t("ew.java.versions", { v: c.java.versions.join(", ") })}</span>
            {c.java.cves.length ? <span className={s.dim}>{t("ew.java.cves", { n: c.java.cves.length })}</span> : null}
          </div>
        ) : main && c.state !== "notYet" && c.state !== "unchecked" && c.state !== "failed" ? <p className={s.dim}>{t("ew.java.none")}</p> : null}
      </div>
    );
  };

  return (
    <Panel title={t("ew.title")} sub={d.enabled ? t("ew.sub", { m: Math.round(d.intervalSec / 60), f: Math.round(d.fastIntervalSec / 60), last: when(d.lastCheckAt), next: when(d.nextCheckAt) }) : t("ew.off")}
      actions={d.canWrite && d.enabled ? <Button size="sm" onClick={() => void checkNow()} disabled={busy}>{t("ew.check")}</Button> : undefined}
      footer={<span className={s.dim}>{d.durable ? t("ew.foot") : t("ew.footMemory")}</span>}>
      {msg ? <p className={s.bad}>{msg}</p> : null}
      <ul className={s.sources} aria-label={t("ew.sources")}>
        {d.sources.map((x) => (
          <li key={x.id} title={[x.detail ?? "", when(x.checkedAt)].filter(Boolean).join(" · ")}>
            <Chip level={STATE_LEVEL[x.state]}>{t(`ew.src.${x.id}`)}</Chip>
          </li>
        ))}
      </ul>

      <h4 className={s.h}>{t("ew.oracle.title")}</h4>
      {cycle(d.oracle.current, true)}
      {cycle(d.oracle.next, false)}

      <h4 className={s.h}>{t("ew.ours.title")}</h4>
      {!clusterId ? <p className={s.dim}>{t("ew.ours.noCluster")}</p>
        : apps.error ? <ErrorNotice error={apps.error} />
        : !apps.data ? <p className={s.dim}>{t("ew.ours.loading")}</p>
        : !rows.length ? <p className={s.dim}>{t("ew.ours.none")}</p> : (
          <>
            <p className={s.dim}>
              {t("ew.ours.summary", { n: counts.total, o: counts.oracle, j: counts.openjdk, v: counts.versions.join(", ") || "—" })}
              {counts.noVersion ? ` · ${t("ew.ours.noVersion", { n: counts.noVersion })}` : ""}
            </p>
            <div className={s.tableWrap}>
              <table className={s.table}>
                <thead>
                  <tr>
                    <th scope="col">{t("ew.ours.col.workload")}</th>
                    <th scope="col">{t("ew.ours.col.version")}</th>
                    <th scope="col">{t("ew.ours.col.oracle", { m: d.oracle.current.month })}</th>
                    <th scope="col">{t("ew.ours.col.openjdk", { d: d.openjdk?.date ?? "—" })}</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.slice(0, 100).map((r) => (
                    <tr key={`${r.namespace}/${r.workload}`}>
                      <td>{r.namespace}/{r.workload}</td>
                      <td className={s.mono} title={t(`ew.basis.${r.basis}`)}>{r.version ?? t("ew.ours.unknownVersion")}</td>
                      <td>{r.oracle ? <Badge tone={VERDICT_TONE[r.oracle]}>{t(`ew.verdict.${r.oracle}`)}</Badge> : <span className={s.dim}>{t("ew.verdict.noList")}</span>}</td>
                      <td>{r.openjdk ? <Badge tone={VERDICT_TONE[r.openjdk]}>{t(`ew.verdict.${r.openjdk}`)}</Badge> : <span className={s.dim}>{t("ew.verdict.noList")}</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className={s.dim}>{t("ew.ours.caveat")}</p>
          </>
        )}

      <h4 className={s.h}>{t("ew.openjdk.title")}</h4>
      {d.openjdk ? (
        <p className={s.dim}>
          <a href={d.openjdk.url} target="_blank" rel="noreferrer">{d.openjdk.date} ↗</a>{" "}
          {t("ew.openjdk.affected", { v: d.openjdk.affected.join(", ") || "—" })} ·{" "}
          {d.openjdk.cves.map((c) => `${c.id}${c.score !== null ? ` (${c.score})` : ""}`).join(", ") || t("ew.openjdk.noCves")}
        </p>
      ) : <p className={s.dim}>{t("ew.notRead")}</p>}

      <h4 className={s.h}>{t("ew.kisa.title")}</h4>
      {d.kisa.length ? (
        <ul className={s.list}>{d.kisa.map((k) => <li key={k.url + k.title}><a href={k.url} target="_blank" rel="noreferrer">{k.title}</a> <span className={s.dim}>· {when(k.date)} · {k.matched.join(", ")}</span></li>)}</ul>
      ) : <p className={s.dim}>{d.kisaChecked ? t("ew.kisa.none", { n: d.kisaChecked }) : t("ew.notRead")}</p>}

      <h4 className={s.h}>{t("ew.watch.title")}</h4>
      {d.watch.length ? (
        <div className={s.tableWrap}>
          <table className={s.table}>
            <thead>
              <tr>
                <th scope="col">CVE</th><th scope="col">{t("ew.watch.col.state")}</th><th scope="col">{t("ew.watch.col.record")}</th><th scope="col">{t("ew.watch.col.seen")}</th>{d.canWrite ? <th scope="col" /> : null}
              </tr>
            </thead>
            <tbody>
              {d.watch.map((w) => (
                <tr key={w.id}>
                  <td><a href={`https://www.cve.org/CVERecord?id=${w.id}`} target="_blank" rel="noreferrer" className={s.mono}>{w.id}</a>{w.note ? <div className={s.dim}>{w.note}</div> : null}</td>
                  <td><Chip level={w.state === "PUBLISHED" ? "danger" : w.state === "RESERVED" ? "warn" : "unknown"}>{t(`ew.cveState.${w.state}`)}</Chip><div className={s.dim}>{when(w.checkedAt)}</div></td>
                  <td>{w.title ?? "—"}{w.cvss ? <div><Badge tone={w.cvss.score >= 9 ? "high" : w.cvss.score >= 7 ? "medium" : "low"}>CVSS {w.cvss.version} {w.cvss.score}</Badge></div> : null}{w.cna ? <div className={s.dim}>CNA {w.cna}</div> : null}</td>
                  <td>{when(w.publishedSeenAt)}</td>
                  {d.canWrite ? <td><LinkButton tone="muted" onClick={() => remove(w.id)} disabled={busy}>{t("ew.watch.remove")}</LinkButton></td> : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : <p className={s.dim}>{t("ew.watch.empty")}</p>}
      {d.canWrite ? (
        <div className={s.form}>
          <TextInput label={t("ew.watch.add")} value={draft} onChange={setDraft} placeholder="CVE-2026-114938" width={260} />
          <TextInput label={t("ew.watch.note")} value={note} onChange={setNote} maxLength={120} width={260} />
          <Button onClick={add} disabled={busy || !draft.trim()}>{t("ew.watch.save")}</Button>
        </div>
      ) : <p className={s.dim}>{t("ew.watch.readOnly")}</p>}

      <h4 className={s.h}>{t("ew.events.title")}</h4>
      {d.events.length ? (
        <ul className={s.list}>
          {d.events.slice(0, 12).map((e) => (
            <li key={e.key}>
              <span className={s.mono}>{when(e.firstSeenAt)}</span> <a href={e.url} target="_blank" rel="noreferrer">{e.title}</a>{" "}
              <span className={s.dim}>· {e.notified ? t("ew.events.sent") : t("ew.events.quiet")}</span>
            </li>
          ))}
        </ul>
      ) : <p className={s.dim}>{t("ew.events.none")}</p>}
    </Panel>
  );
}
