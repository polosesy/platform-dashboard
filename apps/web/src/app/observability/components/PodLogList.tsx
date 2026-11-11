"use client";

// AKS 모니터링 › 로그 — the pod's lines as a list in the platform's log grammar (the workload panel's stream: glyph +
// colour by level, time, one-line summary; open a row for the rest). A row's detail is Grafana's log details:
//   the whole message · Indexed labels · Structured metadata · the line's own fields · trace ID
//   맥락 보기 — the lines before and after it in the same pod (API /api/observability/log-context, Loki lines only)
// Lines from kubelet / Container Insights have no labels or exact timestamp: the detail says so instead of guessing.

import { useState } from "react";
import type { LogContextResponse, PodLogEntry } from "@aud/types";
import { ApiError, apiUrl, fetchJsonWithBearer } from "@/lib/api";
import { useApiToken } from "@/lib/useApiToken";
import { dateLocale, useI18n } from "@/lib/i18n";
import { Button, Chip, CopyButton, EmptyState, Notice } from "@/components/ui";
import { LEVEL_GLYPH, firstLine, hasContext, labelRows, levelOf, lineKey, lineText } from "@/lib/podLogView";
import styles from "../styles.module.css";

const CONTEXT_LINES = 20;
const CONTEXT_MORE = 50;

type ContextState = { loading: boolean; lines: number; data?: LogContextResponse; error?: string };

export function PodLogList({ clusterId, namespace, logs, empty }: { clusterId: string; namespace: string; logs: PodLogEntry[]; empty: string }) {
  const { t, locale } = useI18n();
  const getToken = useApiToken();
  const [open, setOpen] = useState<string | null>(null);
  const [context, setContext] = useState<Record<string, ContextState>>({});
  const time = (iso: string) => {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? "" : d.toLocaleTimeString(dateLocale(locale), { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
  };
  const full = (iso: string) => {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? iso : `${d.toLocaleString(dateLocale(locale), { hour12: false })}.${String(d.getMilliseconds()).padStart(3, "0")}`;
  };

  const loadContext = async (key: string, l: PodLogEntry, lines: number) => {
    setContext((c) => ({ ...c, [key]: { ...c[key], loading: true, lines } }));
    try {
      const token = await getToken().catch(() => null);
      const data = await fetchJsonWithBearer<LogContextResponse>(apiUrl("/api/observability/log-context", {
        clusterId, namespace, podName: l.podName, container: l.containerName || undefined, ts: l.tsNs, lines: String(lines),
      }), token);
      setContext((c) => ({ ...c, [key]: { loading: false, lines, data } }));
    } catch (e) {
      setContext((c) => ({ ...c, [key]: { loading: false, lines, error: e instanceof ApiError && e.code ? e.code : e instanceof Error ? e.message : String(e) } }));
    }
  };

  if (logs.length === 0) return <EmptyState title={empty} />;

  return (
    <ol className={styles.lgList}>
      {logs.map((l, i) => {
        const key = lineKey(l, i);
        const isOpen = open === key;
        const level = levelOf(l);
        const cx = context[key];
        const indexed = labelRows(l.labels), meta = labelRows(l.metadata);
        return (
          <li key={key} className={styles.lgItem} data-level={level}>
            <button type="button" className={styles.lgRow} aria-expanded={isOpen} onClick={() => setOpen(isOpen ? null : key)}>
              <span className={styles.lgGlyph} aria-hidden="true">{LEVEL_GLYPH[level]}</span>
              <span className={styles.lgMeta}>
                <time dateTime={l.timestamp}>{time(l.timestamp)}</time>
                {l.containerName ? <span> · {l.containerName}</span> : null}
                {l.stream !== "unknown" ? <span> · {l.stream}</span> : null}
              </span>
              <span className={styles.lgSummary}>{firstLine(l.logMessage)}</span>
            </button>
            {isOpen && (
              <div className={styles.lgDetail}>
                <pre className={styles.lgPre}>{l.logMessage}</pre>

                <div className={styles.plGroups}>
                  <section>
                    <h4 className={styles.plGroupTitle}>{t("ob.pl.fields")}</h4>
                    <dl className={styles.plFields}>
                      <dt>{t("ob.pl.time")}</dt><dd>{full(l.timestamp)}</dd>
                      <dt>{t("ob.pl.level")}</dt><dd>{t(`ob.pl.level.${level}`)}</dd>
                      <dt>pod</dt><dd>{l.podName}</dd>
                      {l.containerName ? <><dt>container</dt><dd>{l.containerName}</dd></> : null}
                      {l.stream !== "unknown" ? <><dt>stream</dt><dd>{l.stream}</dd></> : null}
                      {l.traceId ? <><dt>trace ID</dt><dd>{l.traceId}</dd></> : null}
                    </dl>
                  </section>
                  {indexed.length > 0 && (
                    <section>
                      <h4 className={styles.plGroupTitle} title={t("ob.pl.indexedHint")}>Indexed labels <span className={styles.plGroupN}>{indexed.length}</span></h4>
                      <dl className={styles.plFields}>
                        {indexed.map(([k, v]) => <FieldRow key={k} k={k} v={v} />)}
                      </dl>
                    </section>
                  )}
                  {meta.length > 0 && (
                    <section>
                      <h4 className={styles.plGroupTitle} title={t("ob.pl.metaHint")}>Structured metadata <span className={styles.plGroupN}>{meta.length}</span></h4>
                      <dl className={styles.plFields}>
                        {meta.map(([k, v]) => <FieldRow key={k} k={k} v={v} />)}
                      </dl>
                    </section>
                  )}
                </div>
                {!l.labels ? <p className={styles.lgNote}>{t("ob.pl.noLabels")}</p> : null}

                <div className={styles.lgActions}>
                  <CopyButton text={lineText(l)} label={t("ob.pl.copy")} copiedLabel={t("ob.lg.copied")} />
                  {hasContext(l) ? (
                    <Button size="sm" variant="ghost" disabled={cx?.loading} onClick={() => void loadContext(key, l, CONTEXT_LINES)}>
                      {cx?.data ? t("ob.pl.contextReload") : t("ob.pl.context", { n: CONTEXT_LINES })}
                    </Button>
                  ) : null}
                </div>

                {cx?.error ? <Notice tone="warning">{t("ob.pl.contextFailed", { code: cx.error })}</Notice> : null}
                {cx?.data && cx.data.state !== "ok" ? <Notice tone="warning" title={t(`ob.li.state.${cx.data.state}`)}>{cx.data.message ?? t(`ob.li.stateHint.${cx.data.state}`)}</Notice> : null}
                {cx?.data && cx.data.state === "ok" ? (
                  <section className={styles.plContext} aria-label={t("ob.pl.contextTitle")}>
                    <h4 className={styles.plGroupTitle}>
                      {t("ob.pl.contextTitle")} <span className={styles.plGroupN}>{t("ob.pl.contextCount", { b: cx.data.before.length, a: cx.data.after.length })}</span>
                    </h4>
                    <ol className={styles.plContextList}>
                      {cx.data.before.map((x, j) => <ContextLine key={`b${j}`} l={x} time={time} />)}
                      <li className={styles.plContextHere} data-level={level} aria-current="true">
                        <time>{time(l.timestamp)}</time><span aria-hidden="true">{LEVEL_GLYPH[level]}</span><span>{firstLine(l.logMessage, 2000)}</span>
                      </li>
                      {cx.data.after.map((x, j) => <ContextLine key={`a${j}`} l={x} time={time} />)}
                    </ol>
                    <div className={styles.lgActions}>
                      {cx.lines < CONTEXT_MORE && (cx.data.before.length >= cx.lines || cx.data.after.length >= cx.lines) ? (
                        <Button size="sm" variant="ghost" disabled={cx.loading} onClick={() => void loadContext(key, l, CONTEXT_MORE)}>{t("ob.pl.contextMore", { n: CONTEXT_MORE })}</Button>
                      ) : null}
                      {cx.data.before.length === 0 && cx.data.after.length === 0 ? <span className={styles.lgNote}>{t("ob.pl.contextNone")}</span> : null}
                      {cx.data.redactions > 0 ? <Chip level="info" glyph={false}>{t("ob.pl.redacted", { n: cx.data.redactions })}</Chip> : null}
                    </div>
                  </section>
                ) : null}
              </div>
            )}
          </li>
        );
      })}
    </ol>
  );
}

function FieldRow({ k, v }: { k: string; v: string }) {
  return (
    <>
      <dt>{k}</dt>
      <dd>{v}</dd>
    </>
  );
}

function ContextLine({ l, time }: { l: PodLogEntry; time: (iso: string) => string }) {
  const level = levelOf(l);
  return (
    <li data-level={level}>
      <time>{time(l.timestamp)}</time><span aria-hidden="true">{LEVEL_GLYPH[level]}</span><span>{firstLine(l.logMessage, 2000)}</span>
    </li>
  );
}
