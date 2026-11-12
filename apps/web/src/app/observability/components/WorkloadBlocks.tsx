"use client";

// AKS 모니터링 › 클러스터 · 워크로드 › 조립식 표 — the workload table built from blocks (lib/workloadBlocks.ts):
//   블록(열) = 종류 · the heatmap's signals (Kubernetes, Java / Spring) · other runtimes' representative metrics
//   (Node.js · Python · Go · .NET · NGINX · Redis · PostgreSQL — API /api/observability/app-metrics)
//   조립 = a starting set (preset) → add a block, move it left / right, take it out; remembered in this browser
//   가이드 = per kind: how it is recognised here, how many workloads are, the library / exporter, the configuration to
//   expose the metrics, how they get collected and what the platform needs to read them — and the workloads of no
//   recognised kind
// A cell without series is '—' (the kind does not apply, or it is not exposed); a hint from the image name is marked.

import { useEffect, useMemo, useState } from "react";
import type { AppMetricsResponse, AppRuntimeKind, WorkloadHeatmapResponse } from "@aud/types";
import { apiUrl, fetchJsonWithBearer } from "@/lib/api";
import { useApiQuery } from "@/lib/useApiQuery";
import { useI18n } from "@/lib/i18n";
import { Button, Chip, CodeBlock, EmptyState, ErrorNotice, LoadingState, Notice, Panel, SearchInput, Segmented, Select } from "@/components/ui";
import { answersAt, atParam, heatWindowFor, type TimeRange } from "@/lib/timeRange";
import { useRangeRefresh } from "@/lib/useTimeRange";
import { GLYPH, formatCell, heatKey } from "@/lib/workloadHeatView";
import {
  ALL_BLOCKS, BLOCKS_STORAGE_KEY, BLOCK_RUNTIME, MAX_BLOCKS, PRESETS, PRESET_IDS, RUNTIME_GUIDE, RUNTIME_ORDER, SCRAPE_SNIPPET, addBlock, formatAppValue,
  kindsOf, moveBlock, parseBlocks, presetOf, removeBlock, unidentified, type BlockId, type PresetId,
} from "@/lib/workloadBlocks";
import styles from "../styles.module.css";

type T = (k: string, v?: Record<string, string | number>) => string;
const blockLabel = (t: T, b: BlockId, short = true): string =>
  b === "kind" ? t("ob.bl.kind") : b.startsWith("h:") ? t(`ob.hm.${short ? "short" : "metric"}.${b.slice(2)}`) : t(`ob.bl.col.${b.slice(2)}`);

export function WorkloadBlocks({ clusterId, range, nonce, report }: { clusterId: string; range: TimeRange; nonce: number; report?: (id: string, loading: boolean) => void }) {
  const { t } = useI18n();
  const win = heatWindowFor(range).value;
  const at = atParam(range);
  const heatQ = useApiQuery(clusterId ? `heatmap:${clusterId}:${win}:${at ?? "now"}` : null, (token) =>
    fetchJsonWithBearer<WorkloadHeatmapResponse>(apiUrl("/api/observability/heatmap", { clusterId, window: String(win), at }), token),
  );
  const appQ = useApiQuery(clusterId ? `app-metrics:${clusterId}:${at ?? "now"}` : null, (token) =>
    fetchJsonWithBearer<AppMetricsResponse>(apiUrl("/api/observability/app-metrics", { clusterId, at }), token),
  );
  useRangeRefresh("blocksHeat", nonce, heatQ.loading, heatQ.reload, report);
  useRangeRefresh("blocksApp", nonce, appQ.loading, appQ.reload, report);
  const heat = heatQ.data?.clusterId === clusterId && answersAt(heatQ.data.at, at) ? heatQ.data : null;
  const apps = appQ.data?.clusterId === clusterId ? appQ.data : null;

  // The viewer's blocks: the basic set on the first render, the remembered set right after (no hydration mismatch)
  const [blocks, setBlocks] = useState<BlockId[]>(PRESETS.basic);
  useEffect(() => {
    try { setBlocks(parseBlocks(window.localStorage.getItem(BLOCKS_STORAGE_KEY))); } catch { /* storage blocked: the basic set */ }
  }, []);
  const remember = (next: BlockId[]) => {
    setBlocks(next);
    try { window.localStorage.setItem(BLOCKS_STORAGE_KEY, JSON.stringify(next)); } catch { /* not remembered */ }
  };
  const [query, setQuery] = useState("");
  const [ns, setNs] = useState("");
  const [guide, setGuide] = useState<AppRuntimeKind>("nodejs");

  const appByKey = useMemo(() => new Map<string, AppMetricsResponse["workloads"][number]>((apps?.workloads ?? []).map((w) => [`${w.namespace}/${w.workload}`, w])), [apps]);
  const colOf = useMemo(() => new Map((apps?.columns ?? []).map((c) => [c.id, c] as const)), [apps]);
  const namespaces = useMemo(() => [...new Set((heat?.workloads ?? []).map((w) => w.namespace))].sort(), [heat]);
  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (heat?.workloads ?? []).filter((w) => (!ns || w.namespace === ns) && (!q || heatKey(w).toLowerCase().includes(q)));
  }, [heat, ns, query]);

  if (heatQ.error) return <ErrorNotice error={heatQ.error} />;
  if (!heat) return <LoadingState />;
  if (heat.metricsState !== "ok") {
    return <Notice tone="warning" title={t(`hb.m.state.${heat.metricsState}`)}>{t(`hb.m.stateHint.${heat.metricsState}`)}{heat.message ? ` (${heat.message})` : ""}</Notice>;
  }

  const preset = presetOf(blocks);
  const addable = ALL_BLOCKS.filter((b) => !blocks.includes(b));
  const group = (b: BlockId) => {
    const r = BLOCK_RUNTIME[b];
    return b === "kind" || (b.startsWith("h:") && !r) ? t("ob.bl.group.k8s") : r === "any" ? t("ob.bl.group.any") : t(`ob.bl.rt.${r}`);
  };
  const appsFailed = !!appQ.error || (apps !== null && apps.metricsState !== "ok");
  const none = apps ? unidentified(apps.workloads) : [];
  const rt = apps?.runtimes.find((r) => r.kind === guide);

  return (
    <div className={styles.bl}>
      <Panel title={t("ob.bl.title")} sub={t("ob.bl.sub", { n: blocks.length, max: MAX_BLOCKS })} flush
        actions={<>
          <Select label={t("ob.bl.preset")} hideLabel value={preset ?? ""} onChange={(v) => { if (v) remember(PRESETS[v as PresetId]); }}
            options={[...(preset ? [] : [{ value: "", label: t("ob.bl.preset.custom") }]), ...PRESET_IDS.map((p) => ({ value: p, label: t(`ob.bl.preset.${p}`) }))]} />
          <Select label={t("ob.bl.add")} hideLabel value="" disabled={addable.length === 0 || blocks.length >= MAX_BLOCKS} onChange={(v) => { if (v) remember(addBlock(blocks, v as BlockId)); }}
            options={[{ value: "", label: t("ob.bl.add") }, ...addable.map((b) => ({ value: b, label: blockLabel(t, b, false), group: group(b) }))]} />
        </>}
        footer={<span>{t("ob.bl.foot")}</span>}>
        {/* The blocks in order: move one left / right or take it out */}
        <ol className={styles.blBlocks} aria-label={t("ob.bl.blocks")}>
          {blocks.map((b, i) => {
            const c = b.startsWith("a:") ? colOf.get(b.slice(2) as never) : undefined;
            return (
              <li key={b} className={styles.blBlock} data-state={c?.state === "absent" ? "absent" : c?.state === "queryFailed" ? "failed" : undefined}
                title={c?.state === "absent" ? t("ob.bl.absentHint") : c?.state === "queryFailed" ? t("ob.bl.failedHint") : blockLabel(t, b, false)}>
                <Button size="sm" variant="ghost" disabled={i === 0} ariaLabel={t("ob.bl.left", { name: blockLabel(t, b) })} onClick={() => remember(moveBlock(blocks, b, -1))}>◀</Button>
                <span className={styles.blBlockName}>{blockLabel(t, b)}</span>
                <Button size="sm" variant="ghost" disabled={i === blocks.length - 1} ariaLabel={t("ob.bl.right", { name: blockLabel(t, b) })} onClick={() => remember(moveBlock(blocks, b, 1))}>▶</Button>
                <Button size="sm" variant="ghost" disabled={blocks.length <= 1} ariaLabel={t("ob.bl.remove", { name: blockLabel(t, b) })} onClick={() => remember(removeBlock(blocks, b))}>✕</Button>
              </li>
            );
          })}
        </ol>
        <div className={styles.blFilters}>
          {namespaces.length > 1 ? (
            <Select label={t("hb.namespace")} hideLabel value={ns} onChange={setNs}
              options={[{ value: "", label: t("hb.allNamespaces") }, ...namespaces.map((n) => ({ value: n, label: n }))]} />
          ) : null}
          <SearchInput label={t("ob.bl.find")} value={query} onChange={setQuery} placeholder={t("ob.bl.findPh")} />
          {appsFailed ? <Chip level="warn" title={appQ.error ?? apps?.message ?? ""}>{t("ob.bl.appsFailed")}</Chip> : !apps ? <Chip level="neutral">{t("ob.bl.appsLoading")}</Chip> : null}
        </div>
        {rows.length === 0 ? <EmptyState title={t("ob.hm.empty")} /> : (
          <div className={styles.blTableWrap}>
            <table className={styles.blTable}>
              <thead>
                <tr>
                  <th scope="col">{t("ob.hm.col.workload")}</th>
                  {blocks.map((b) => <th key={b} scope="col" title={blockLabel(t, b, false)}>{blockLabel(t, b)}</th>)}
                </tr>
              </thead>
              <tbody>
                {rows.map((w) => {
                  const a = appByKey.get(heatKey(w));
                  return (
                    <tr key={heatKey(w)}>
                      <th scope="row"><span className={styles.blName}>{w.workload}</span><span className={styles.blNs}>{w.namespace}</span></th>
                      {blocks.map((b) => {
                        if (b === "kind") {
                          const ks = kindsOf(a);
                          return (
                            <td key={b}>
                              {!apps ? "…" : ks.length === 0 ? <span className={styles.blMuted} title={t("ob.bl.kindUnknownHint")}>{t("ob.bl.kindUnknown")}</span>
                                : <span className={styles.blKinds}>{ks.map((k) => (
                                  <Chip key={k.kind} level={k.basis === "metrics" ? "info" : "unknown"} glyph={k.basis === "metrics" ? false : "?"}
                                    title={t(k.basis === "metrics" ? "ob.bl.basis.metrics" : "ob.bl.basis.image", { metric: RUNTIME_GUIDE[k.kind].detect })}>
                                    {t(`ob.bl.rt.${k.kind}`)}
                                  </Chip>
                                ))}</span>}
                            </td>
                          );
                        }
                        if (b.startsWith("h:")) {
                          const m = b.slice(2) as keyof typeof w.cells;
                          const c = w.cells[m];
                          return <td key={b} data-level={c.level}><span aria-hidden="true" className={styles.blGlyph}>{GLYPH[c.level]}</span> {formatCell(m, w, t)}</td>;
                        }
                        const id = b.slice(2) as keyof NonNullable<typeof a>["values"];
                        const col = colOf.get(id as never);
                        const v = a?.values[id];
                        return <td key={b} className={styles.blNum}>{v === undefined || !col ? <span className={styles.blMuted}>—</span> : formatAppValue(col.unit, v)}</td>;
                      })}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      {/* The guide: what each kind is recognised by, what is measured here, and what to set up */}
      <Panel title={t("ob.bl.guideTitle")} sub={t("ob.bl.guideSub")}
        actions={<Segmented label={t("ob.bl.kind")} value={guide} onChange={setGuide}
          items={RUNTIME_ORDER.map((k) => ({ id: k, label: t(`ob.bl.rt.${k}`) }))} />}
        footer={<span>{t("ob.bl.guideFoot")}</span>}>
        <div className={styles.blGuide}>
          <div className={styles.blGuideText}>
            <dl className={styles.blFacts}>
              <dt>{t("ob.bl.g.here")}</dt>
              <dd>
                {!apps ? "…" : !rt || rt.state === "queryFailed" ? t("ob.bl.failedHint")
                  : rt.state === "absent" ? t("ob.bl.g.hereNone", { metric: RUNTIME_GUIDE[guide].detect })
                  : t("ob.bl.g.hereN", { n: rt.workloads })}
                {rt && rt.hinted > 0 ? ` · ${t("ob.bl.g.hinted", { n: rt.hinted })}` : ""}
              </dd>
              <dt>{t("ob.bl.g.detect")}</dt>
              <dd><code className={styles.sloCode}>{RUNTIME_GUIDE[guide].detect}</code> — {t("ob.bl.g.detectHint")}</dd>
              <dt>{t("ob.bl.g.library")}</dt>
              <dd>{RUNTIME_GUIDE[guide].library}</dd>
              <dt>{t("ob.bl.g.columns")}</dt>
              <dd>
                <span className={styles.blKinds}>
                  {ALL_BLOCKS.filter((b) => BLOCK_RUNTIME[b] === guide).map((b) => (
                    <Chip key={b} level={blocks.includes(b) ? "info" : "plain"} glyph={false}>{blockLabel(t, b, false)}</Chip>
                  ))}
                </span>
              </dd>
              <dt>{t("ob.bl.g.needs")}</dt>
              <dd>
                <ol className={styles.blSteps}>
                  <li>{t("ob.bl.g.step1", { library: RUNTIME_GUIDE[guide].library })}</li>
                  <li>{t("ob.bl.g.step2")}</li>
                  <li>{t("ob.bl.g.step3")}</li>
                  <li>{t("ob.bl.g.step4")}</li>
                </ol>
              </dd>
            </dl>
          </div>
          <div className={styles.blGuideCode}>
            <CodeBlock code={RUNTIME_GUIDE[guide].snippet} label={t("ob.bl.g.snippet", { library: RUNTIME_GUIDE[guide].library })} copyLabel={t("ob.slo.copy")} copiedLabel={t("ob.slo.copied")} />
            <CodeBlock code={SCRAPE_SNIPPET} label={t("ob.bl.g.scrape")} copyLabel={t("ob.slo.copy")} copiedLabel={t("ob.slo.copied")} />
          </div>
        </div>
        {none.length > 0 && (
          <div className={styles.blNone}>
            <p className={styles.sloText}>{t("ob.bl.noneTitle", { n: none.length })}</p>
            <div className={styles.blKinds}>
              {none.slice(0, 40).map((w) => (
                <Chip key={`${w.namespace}/${w.workload}`} level={w.kinds.length ? "unknown" : "neutral"} glyph={w.kinds.length ? "?" : false}
                  title={w.kinds.length ? t("ob.bl.noneHinted", { kind: t(`ob.bl.rt.${w.kinds[0]!.kind}`) }) : t("ob.bl.kindUnknownHint")}>
                  {w.namespace}/{w.workload}
                </Chip>
              ))}
              {none.length > 40 ? <span className={styles.blMuted}>+{none.length - 40}</span> : null}
            </div>
          </div>
        )}
      </Panel>
    </div>
  );
}
