"use client";

import { useEffect, useRef, type ReactNode } from "react";
import type { EvidenceKind } from "@aud/types";
import { useI18n } from "@/lib/i18n";
import { domId } from "./model";
import { useInsightLabels } from "./useInsightLabels";
import styles from "./insights.module.css";

export function EvidenceChip({ ev, text }: { ev: EvidenceKind; text?: string }) {
  const { EVK } = useInsightLabels();
  return (
    <span className={styles.evc} data-ev={ev}>
      {ev === "unk" ? "? " : ""}
      {text ?? EVK[ev]}
    </span>
  );
}

export function Pill({ tone, children, title }: { tone: "crit" | "warn" | "ok" | "unk" | "ev"; children: ReactNode; title?: string }) {
  return (
    <span className={styles.pill} data-tone={tone} title={title}>
      {children}
    </span>
  );
}

/** `evText` names what was observed when it isn't Hubble (e.g. an access log) — the chip keeps the grade's colour */
export type InspectorRow = { k: string; v?: string; node?: ReactNode; ev?: EvidenceKind; evText?: string; src?: string; mono?: boolean; off?: boolean; key?: boolean };
export type InspectorSection = { h: string; rows?: InspectorRow[]; body?: ReactNode; grid?: boolean };

export type InspectorModel = {
  id: string;
  kicker: string;
  title: string;
  sub?: string;
  chips?: ReactNode;
  callouts?: Array<{ tone?: "info" | "ok" | "warn"; content: ReactNode }>;
  sections: Array<InspectorSection | null | false>;
  links?: Array<{ label: string; onClick: () => void }>;
};

export function FactRows({ rows, grid }: { rows: InspectorRow[]; grid?: boolean }) {
  return (
    <dl className={`${styles.facts} ${grid ? styles.fgrid : ""}`}>
      {rows.map((r, i) => (
        <div key={`${r.k}-${i}`} className={styles.fr} data-off={r.off || undefined} data-key={r.key || undefined}>
          <dt>{r.k}</dt>
          <dd>
            {r.node ?? <span className={r.mono ? styles.mono : undefined}>{r.v}</span>}
            {r.ev && <EvidenceChip ev={r.ev} text={r.evText} />}
            {r.src && <span className={styles.src}>{r.src}</span>}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * The single detail card used by the attack graph, the heatmap and both network maps.
 * Focus moves to the title when a different subject opens; Escape and ✕ call `onClose`.
 */
export function Inspector({ model, onClose, cols, autoFocus = true }: { model: InspectorModel; onClose?: () => void; cols?: boolean; autoFocus?: boolean }) {
  const { t } = useI18n();
  const titleRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (autoFocus) titleRef.current?.focus({ preventScroll: true });
  }, [model.id, autoFocus]);
  const tid = `${domId(model.id)}-t`;
  return (
    <article
      className={styles.dcard}
      aria-labelledby={tid}
      onKeyDown={(e) => {
        if (e.key === "Escape" && onClose) {
          e.stopPropagation();
          onClose();
        }
      }}
    >
      <header className={styles.dcH}>
        <div>
          <div className={styles.dcK}>{model.kicker}</div>
          <h4 id={tid} ref={titleRef} tabIndex={-1}>
            {model.title}
          </h4>
          {model.sub && <div className={styles.dcSub}>{model.sub}</div>}
          {model.chips && <div className={styles.dcChips}>{model.chips}</div>}
        </div>
        {onClose && (
          <button className={styles.dcX} onClick={onClose} aria-label={t("ins.closeDetail")}>
            ✕
          </button>
        )}
      </header>
      {model.callouts?.map((c, i) => (
        <div key={i} className={styles.callout} data-tone={c.tone}>
          {c.content}
        </div>
      ))}
      <div className={styles.dcBody} data-cols={cols || undefined}>
        {model.sections.filter((s): s is InspectorSection => !!s).map((s) => (
          <section key={s.h} className={styles.dcS}>
            <h5>{s.h}</h5>
            {s.body ?? (s.rows && <FactRows rows={s.rows} grid={s.grid} />)}
          </section>
        ))}
      </div>
      {!!model.links?.length && (
        <footer className={styles.dcLinks}>
          {model.links.map((l) => (
            <button key={l.label} className={styles.linkish} onClick={l.onClick}>
              {l.label} →
            </button>
          ))}
        </footer>
      )}
    </article>
  );
}
