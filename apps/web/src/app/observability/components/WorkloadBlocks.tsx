"use client";

// AKS 모니터링 › 클러스터 · 워크로드 — the parts that make the heatmap and its table the viewer's own (lib/workloadBlocks.ts):
//   BlockEditor  = the chosen blocks in order (move left / right, take out), a starting set, add a block, back to automatic.
//                  A block is a column of the table and a value a heatmap tile can show.
//   KindChips    = what kind of application a workload is — confirmed by its metrics, or guessed ('?') from the image name
//   RuntimeGuide = per kind: whether this cluster has it, what it is recognised by, the library / exporter, the four steps
//                  (feature · configuration · permissions · check) with code to copy, and the workloads of no recognised kind
// A value without series is '—' (the kind does not apply, or it is not exposed) — never 0.

import type { AppMetricsResponse, AppRuntimeKind } from "@aud/types";
import { useI18n } from "@/lib/i18n";
import { useState } from "react";
import { Button, Chip, CodeBlock, Panel, Segmented, Select, TextInput } from "@/components/ui";
import {
  ALL_BLOCKS, BLOCK_RUNTIME, MAX_BLOCKS, PRESETS, PRESET_IDS, RUNTIME_GUIDE, RUNTIME_ORDER, SCRAPE_SNIPPET, addBlock, shortVersion,
  MAX_SETS, SET_NAME_MAX, kindsOf, moveBlock, presetOf, removeBlock, sameBlocks, setName, unidentified, type BlockId, type BlockSet, type PresetId,
} from "@/lib/workloadBlocks";
import styles from "../styles.module.css";

type T = (k: string, v?: Record<string, string | number>) => string;
type AppColumn = AppMetricsResponse["columns"][number];
export const blockLabel = (t: T, b: BlockId, short = true): string =>
  b === "kind" ? t(short ? "ob.bl.kind" : "ob.bl.kindLong") : b.startsWith("h:") ? t(`ob.hm.${short ? "short" : "metric"}.${b.slice(2)}`) : t(`ob.bl.col.${b.slice(2)}`);
/** The group a block is listed under: Kubernetes · a runtime · any runtime */
export const blockGroup = (t: T, b: BlockId): string => {
  const r = BLOCK_RUNTIME[b];
  return b === "kind" || (b.startsWith("h:") && !r) ? t("ob.bl.group.k8s") : r === "any" ? t("ob.bl.group.any") : t(`ob.bl.rt.${r}`);
};

export function BlockEditor({ blocks, custom, dirty, sets, columns, guideOpen, onChange, onReset, onSave, onDeleteSet, onGuide }: {
  blocks: BlockId[];
  /** false = the automatic set (nothing chosen) */
  custom: boolean;
  /** The blocks differ from what is saved — shown, and "저장" keeps them */
  dirty: boolean;
  /** The viewer's named sets (this browser) */
  sets: BlockSet[];
  columns: Map<string, AppColumn>;
  guideOpen: boolean;
  onChange: (next: BlockId[]) => void;
  onReset: () => void;
  /** Keep the blocks as they are now; with a name, also as a named set */
  onSave: (name: string) => void;
  onDeleteSet: (name: string) => void;
  /** Open the guide (a kind) or close it (null) — a block whose metric is not in this cluster opens its kind's */
  onGuide: (kind: AppRuntimeKind | null) => void;
}) {
  const { t } = useI18n();
  const [name, setNameText] = useState("");
  const preset = custom ? presetOf(blocks) : null;
  const named = custom ? sets.find((x) => sameBlocks(x.blocks, blocks)) : undefined;
  const addable = ALL_BLOCKS.filter((b) => !blocks.includes(b));
  const clean = setName(name);
  const full = !!clean && sets.length >= MAX_SETS && !sets.some((x) => x.name === clean);
  return (
    <section className={styles.blEditor} aria-label={t("ob.bl.title")}>
      <div className={styles.blEditorHead}>
        <span className={styles.blEditorTitle}>{t("ob.bl.title")}</span>
        <span className={styles.blMuted}>{t("ob.bl.sub", { n: blocks.length, max: MAX_BLOCKS })}</span>
        <Chip level={dirty ? "warn" : "ok"}>{t(dirty ? "ob.bl.unsaved" : "ob.bl.saved")}</Chip>
        <span className={styles.blEditorActions}>
          <Select label={t("ob.bl.preset")} hideLabel value={!custom ? "auto" : named ? `s:${named.name}` : (preset ?? "custom")}
            onChange={(v) => {
              if (v === "auto") onReset();
              else if (v.startsWith("s:")) { const hit = sets.find((x) => x.name === v.slice(2)); if (hit) onChange(hit.blocks); }
              else if (v !== "custom") onChange(PRESETS[v as PresetId]);
            }}
            options={[
              { value: "auto", label: t("ob.bl.preset.auto") },
              ...(custom && !preset && !named ? [{ value: "custom", label: t("ob.bl.preset.custom") }] : []),
              ...sets.map((x) => ({ value: `s:${x.name}`, label: x.name, group: t("ob.bl.sets") })),
              ...PRESET_IDS.map((p) => ({ value: p, label: t(`ob.bl.preset.${p}`), group: t("ob.bl.preset") })),
            ]} />
          <Select label={t("ob.bl.add")} hideLabel value="" disabled={addable.length === 0 || blocks.length >= MAX_BLOCKS} onChange={(v) => { if (v) onChange(addBlock(blocks, v as BlockId)); }}
            options={[{ value: "", label: t("ob.bl.add") }, ...addable.map((b) => ({ value: b, label: blockLabel(t, b, false), group: blockGroup(t, b) }))]} />
          <Button size="sm" ariaPressed={guideOpen} onClick={() => onGuide(guideOpen ? null : "nodejs")}>{t("ob.bl.guideOpen")}</Button>
        </span>
      </div>
      <ol className={styles.blBlocks} aria-label={t("ob.bl.blocks")}>
        {blocks.map((b, i) => {
          const c = b.startsWith("a:") ? columns.get(b.slice(2)) : undefined;
          const rt = BLOCK_RUNTIME[b];
          const absent = c?.state === "absent";
          return (
            <li key={b} className={styles.blBlock} data-state={absent ? "absent" : c?.state === "queryFailed" ? "failed" : undefined}
              title={absent ? t("ob.bl.absentHint") : c?.state === "queryFailed" ? t("ob.bl.failedHint") : blockLabel(t, b, false)}>
              <Button size="sm" variant="ghost" disabled={i === 0} ariaLabel={t("ob.bl.left", { name: blockLabel(t, b) })} onClick={() => onChange(moveBlock(blocks, b, -1))}>◀</Button>
              <span className={styles.blBlockName}>{blockLabel(t, b)}</span>
              {absent && rt && rt !== "any" ? <Button size="sm" variant="ghost" ariaLabel={t("ob.bl.howTo", { name: blockLabel(t, b) })} onClick={() => onGuide(rt)}>?</Button> : null}
              <Button size="sm" variant="ghost" disabled={i === blocks.length - 1} ariaLabel={t("ob.bl.right", { name: blockLabel(t, b) })} onClick={() => onChange(moveBlock(blocks, b, 1))}>▶</Button>
              <Button size="sm" variant="ghost" disabled={blocks.length <= 1} ariaLabel={t("ob.bl.remove", { name: blockLabel(t, b) })} onClick={() => onChange(removeBlock(blocks, b))}>✕</Button>
            </li>
          );
        })}
      </ol>
      {/* Keep it: "저장" keeps the blocks as they are (this browser); a name also keeps them as a set to come back to */}
      <div className={styles.blSave}>
        <TextInput label={t("ob.bl.setName")} hideLabel value={name} onChange={setNameText} placeholder={t("ob.bl.setNamePh")} maxLength={SET_NAME_MAX} width={220} disabled={!custom} />
        <Button size="sm" variant="primary" disabled={full || (!dirty && (!clean || !custom))} title={full ? t("ob.bl.setsFull", { max: MAX_SETS }) : undefined}
          onClick={() => { onSave(custom ? clean : ""); setNameText(""); }}>
          {t(clean && custom ? "ob.bl.saveAs" : "ob.bl.save")}
        </Button>
        <Button size="sm" disabled={!custom} onClick={onReset}>{t("ob.bl.reset")}</Button>
        {named ? <Button size="sm" onClick={() => onDeleteSet(named.name)}>{t("ob.bl.deleteSet", { name: named.name })}</Button> : null}
        <span className={styles.blMuted}>{t("ob.bl.saveHint", { n: sets.length, max: MAX_SETS })}</span>
      </div>
      <p className={styles.blEditorFoot}>{t("ob.bl.foot")}</p>
    </section>
  );
}

/** The kinds of one workload — each with what said so (metrics · telemetry · manifest · image scan · official image); none = said, never guessed */
export function KindChips({ app, loaded }: { app: AppMetricsResponse["workloads"][number] | undefined; loaded: boolean }) {
  const { t } = useI18n();
  if (!loaded) return <span className={styles.blMuted}>…</span>;
  const ks = kindsOf(app);
  if (ks.length === 0) return <span className={styles.blMuted} title={t("ob.bl.kindUnknownHint")}>{t("ob.bl.kindUnknown")}</span>;
  return (
    <span className={styles.blKinds}>
      {ks.map((k) => (
        <Chip key={k.kind} level={k.basis === "metrics" ? "info" : "neutral"} glyph={false}
          title={[t(`ob.bl.basis.${k.basis}`, { metric: RUNTIME_GUIDE[k.kind].detect, evidence: k.evidence ?? "" }), k.version ? t("ob.bl.version", { v: k.version }) : ""].filter(Boolean).join(" · ")}>
          {t(`ob.bl.rt.${k.kind}`)}{shortVersion(k.kind, k.version) ? ` ${shortVersion(k.kind, k.version)}` : ""}
        </Chip>
      ))}
    </span>
  );
}

export function RuntimeGuide({ apps, blocks, kind, onKind, onClose }: {
  apps: AppMetricsResponse | null; blocks: BlockId[]; kind: AppRuntimeKind; onKind: (k: AppRuntimeKind) => void; onClose: () => void;
}) {
  const { t } = useI18n();
  const none = apps ? unidentified(apps.workloads) : [];
  const rt = apps?.runtimes.find((r) => r.kind === kind);
  const g = RUNTIME_GUIDE[kind];
  return (
    <Panel title={t("ob.bl.guideTitle")} sub={t("ob.bl.guideSub")}
      actions={<>
        <Segmented label={t("ob.bl.kind")} value={kind} onChange={onKind} items={RUNTIME_ORDER.map((k) => ({ id: k, label: t(`ob.bl.rt.${k}`) }))} />
        <Button size="sm" onClick={onClose}>{t("ob.bl.guideClose")}</Button>
      </>}
      footer={<span>{t("ob.bl.guideFoot")}</span>}>
      <div className={styles.blGuide}>
        <div className={styles.blGuideText}>
          <dl className={styles.blFacts}>
            <dt>{t("ob.bl.g.here")}</dt>
            <dd>
              {!apps ? "…" : !rt || rt.state === "queryFailed" ? t("ob.bl.failedHint")
                : rt.state === "absent" ? t("ob.bl.g.hereNone", { metric: g.detect })
                : t("ob.bl.g.hereN", { n: rt.workloads })}
              {rt && rt.hinted > 0 ? ` · ${t("ob.bl.g.hinted", { n: rt.hinted })}` : ""}
            </dd>
            <dt>{t("ob.bl.g.detect")}</dt>
            <dd><code className={styles.sloCode}>{g.detect}</code> — {t("ob.bl.g.detectHint")}</dd>
            <dt>{t("ob.bl.g.library")}</dt>
            <dd>{g.library}</dd>
            <dt>{t("ob.bl.g.columns")}</dt>
            <dd>
              <span className={styles.blKinds}>
                {ALL_BLOCKS.filter((b) => BLOCK_RUNTIME[b] === kind).map((b) => (
                  <Chip key={b} level={blocks.includes(b) ? "info" : "plain"} glyph={false}>{blockLabel(t, b, false)}</Chip>
                ))}
              </span>
            </dd>
            <dt>{t("ob.bl.g.needs")}</dt>
            <dd>
              <ol className={styles.blSteps}>
                <li>{t("ob.bl.g.step1", { library: g.library })}</li>
                <li>{t("ob.bl.g.step2")}</li>
                <li>{t("ob.bl.g.step3")}</li>
                <li>{t("ob.bl.g.step4")}</li>
              </ol>
            </dd>
          </dl>
        </div>
        <div className={styles.blGuideCode}>
          <CodeBlock code={g.snippet} label={t("ob.bl.g.snippet", { library: g.library })} copyLabel={t("ob.slo.copy")} copiedLabel={t("ob.slo.copied")} />
          <CodeBlock code={SCRAPE_SNIPPET} label={t("ob.bl.g.scrape")} copyLabel={t("ob.slo.copy")} copiedLabel={t("ob.slo.copied")} />
        </div>
      </div>
      {none.length > 0 && (
        <div className={styles.blNone}>
          <p className={styles.sloText}>{t("ob.bl.noneTitle", { n: none.length })}</p>
          <div className={styles.blKinds}>
            {none.slice(0, 40).map((w) => (
              <Chip key={`${w.namespace}/${w.workload}`} level={w.kinds.length ? "info" : "neutral"} glyph={false}
                title={w.kinds.length ? t("ob.bl.noneHinted", { kind: t(`ob.bl.rt.${w.kinds[0]!.kind}`), basis: t(`ob.bl.basisShort.${w.kinds[0]!.basis}`) }) : t("ob.bl.kindUnknownHint")}>
                {w.namespace}/{w.workload}
              </Chip>
            ))}
            {none.length > 40 ? <span className={styles.blMuted}>+{none.length - 40}</span> : null}
          </div>
        </div>
      )}
    </Panel>
  );
}
