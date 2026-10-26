"use client";

// The heatmap panel's log stream (Loki, last hour) as a log explorer: a toolbar (ERROR only / all, count, Grafana),
// exception chips that filter, then one row per distinct message — level glyph, time, pod suffix, the message on
// two lines, "×n" when it repeated. A row opens to the full first line, the application's stack frames (framework
// frames folded behind a button), causes, the trace link and copy. One scroll: the panel's, not a nested box.
// The view model is lib/logView.ts; lines arrive redacted from the API (services/logRedaction.ts).

import { useMemo, useState } from "react";
import type { WorkloadHeatmapResponse, WorkloadLogsResponse } from "@aud/types";
import { dateLocale, useI18n } from "@/lib/i18n";
import { Button, EmptyState, Segmented } from "@/components/ui";
import { filterByException, frameLabel, groupLogLines, shortPod, visibleFrames, type LogGroup } from "@/lib/logView";
import styles from "../styles.module.css";

const LEVEL_GLYPH: Record<LogGroup["level"], string> = { error: "■", warn: "▲", info: "●", unknown: "○" };

export function WorkloadLogStream({ data, workload, errorsOnly, onErrorsOnly, grafana, traceUrl, logsUrl }: {
  data: WorkloadLogsResponse;
  workload: string;
  errorsOnly: boolean;
  onErrorsOnly: (v: boolean) => void;
  grafana: WorkloadHeatmapResponse["grafana"];
  traceUrl: (traceId: string) => string | null;
  logsUrl: string | null;
}) {
  const { t, locale } = useI18n();
  const [cls, setCls] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [allFrames, setAllFrames] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const groups = useMemo(() => groupLogLines(data.lines), [data.lines]);
  const shown = filterByException(groups, cls);
  const today = new Date().toDateString();
  const time = (iso: string) => {
    const d = new Date(iso);
    return d.toDateString() === today
      ? d.toLocaleTimeString(dateLocale(locale), { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false })
      : d.toLocaleString(dateLocale(locale), { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
  };
  const copy = (g: LogGroup) => {
    void navigator.clipboard?.writeText(g.latest.text).then(() => { setCopied(g.key); window.setTimeout(() => setCopied(null), 1500); }).catch(() => undefined);
  };

  return (
    <div className={styles.lgWrap}>
      <div className={styles.lgBar}>
        <Segmented label={t("ob.hm.logs")} value={errorsOnly ? "e" : "a"} onChange={(v) => { setCls(null); onErrorsOnly(v === "e"); }}
          items={[{ id: "e", label: t("ob.hm.logsErrors") }, { id: "a", label: t("ob.hm.logsAll") }]} />
        <span className={styles.lgCount}>
          {t("ob.lg.count", { n: data.lines.length, g: groups.length })}{data.truncated ? ` ${t("ob.hm.truncated")}` : ""}
        </span>
        {grafana && logsUrl && <a className={styles.lgOpen} target="_blank" rel="noreferrer" href={logsUrl}>{t("ob.lg.grafana")} ↗</a>}
      </div>

      {data.exceptions.length > 0 && (
        <div className={styles.lgChips} role="group" aria-label={t("ob.lg.exceptions")}>
          {data.exceptions.map((x) => (
            <button key={x.cls} type="button" className={styles.lgChip} aria-pressed={cls === x.cls}
              title={x.cls} onClick={() => setCls(cls === x.cls ? null : x.cls)}>
              <span className={styles.lgChipName}>{x.cls.split(".").pop()}</span> <strong>{x.count}</strong>
            </button>
          ))}
        </div>
      )}

      {shown.length === 0 ? <EmptyState title={t(errorsOnly ? "ob.hm.noErrors" : "ob.hm.noLines")} /> : (
        <ol className={styles.lgList}>
          {shown.map((g) => {
            const isOpen = open === g.key;
            const frames = allFrames === g.key ? { shown: g.parsed.frames, folded: 0 } : visibleFrames(g.parsed.frames);
            const trace = g.latest.traceId ? traceUrl(g.latest.traceId) : null;
            return (
              <li key={g.key} className={styles.lgItem} data-level={g.level}>
                <button type="button" className={styles.lgRow} aria-expanded={isOpen} onClick={() => setOpen(isOpen ? null : g.key)}>
                  <span className={styles.lgGlyph} aria-hidden="true">{LEVEL_GLYPH[g.level]}</span>
                  <span className={styles.lgMeta}>
                    <time dateTime={g.last}>{time(g.last)}</time>
                    {g.latest.pod ? <span title={g.pods.join("\n")}> · {shortPod(g.latest.pod, workload)}{g.pods.length > 1 ? ` +${g.pods.length - 1}` : ""}</span> : null}
                    {g.count > 1 ? <span className={styles.lgTimes} title={t("ob.lg.repeat", { n: g.count, first: time(g.first), last: time(g.last) })}>×{g.count}</span> : null}
                  </span>
                  <span className={styles.lgSummary}>{g.parsed.summary}</span>
                </button>
                {isOpen && (
                  <div className={styles.lgDetail}>
                    {g.count > 1 && <p className={styles.lgNote}>{t("ob.lg.repeat", { n: g.count, first: time(g.first), last: time(g.last) })}</p>}
                    <pre className={styles.lgPre}>{[g.parsed.head, ...g.parsed.body].join("\n")}</pre>
                    {g.parsed.frames.length > 0 && (
                      <>
                        <ol className={styles.lgFrames} aria-label={t("ob.lg.stack")}>
                          {frames.shown.map((f, i) => {
                            const fl = frameLabel(f.text);
                            return (
                              <li key={i} data-app={f.app || undefined} title={fl.pkg ? `${fl.pkg}.${fl.call}` : f.text}>
                                <span className={styles.lgFrameCall}>{fl.call}</span> <span className={styles.lgFrameWhere}>{fl.where}</span>
                              </li>
                            );
                          })}
                        </ol>
                        {frames.folded > 0 && (
                          <Button size="sm" variant="ghost" onClick={() => setAllFrames(g.key)}>{t("ob.lg.moreFrames", { n: frames.folded })}</Button>
                        )}
                      </>
                    )}
                    {g.parsed.causes.length > 0 && <pre className={styles.lgPre}>{g.parsed.causes.join("\n")}</pre>}
                    <div className={styles.lgActions}>
                      <Button size="sm" variant="ghost" onClick={() => copy(g)}>{copied === g.key ? t("ob.lg.copied") : t("ob.lg.copy")}</Button>
                      {trace && <a className={styles.lgOpen} href={trace} target="_blank" rel="noreferrer">trace ↗</a>}
                    </div>
                  </div>
                )}
              </li>
            );
          })}
        </ol>
      )}
      <p className={styles.lgFoot}>{t("ob.lg.basis", { r: data.redactions })}</p>
    </div>
  );
}
