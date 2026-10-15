"use client";

import { Fragment } from "react";
import { NodeToolbar, Position } from "reactflow";
import { useI18n } from "@/lib/i18n";
import type { NamePart } from "@/lib/liveNames";
import { CopyButton } from "./detail/primitives";
import styles from "../styles.module.css";

/** Full name with the short name's words marked (`data-kept`), breakable after each separator */
export function NameParts({ parts }: { parts: readonly NamePart[] }) {
  return (
    <>
      {parts.map((p, i) => (
        <Fragment key={i}>
          <span data-kept={p.kept || undefined}>{p.text}</span>
          {p.sep ? <wbr /> : null}
        </Fragment>
      ))}
    </>
  );
}

/**
 * Full-name tag above a selected card or subnet header. React Flow's NodeToolbar draws it outside the zoom
 * transform, so it reads at 12 px at every zoom level and sits above lines and labels. Mounted only while shown
 * (a hidden NodeToolbar still re-renders on every pan).
 */
export function FullNameTag({ fullName, original, parts, ghostOf, offset = 4 }: {
  /** What is shown (GUIDs masked) */
  fullName: string;
  /** What the copy button copies (unmasked, same as the panel) */
  original: string;
  /** Parts when the shown name is the original (no masking) */
  parts?: readonly NamePart[];
  ghostOf?: string;
  offset?: number;
}) {
  const { t } = useI18n();
  return (
    <NodeToolbar isVisible position={Position.Top} align="start" offset={offset} className="nopan nodrag nowheel">
      <div className={styles.nameTag} role="note" aria-label={t("ld.fullName")}>
        <span className={styles.nameTagText}>
          {parts && fullName === original ? <NameParts parts={parts} /> : fullName}
          {ghostOf ? <span className={styles.nameTagGhost}> · ↗ {ghostOf}</span> : null}
        </span>
        <CopyButton value={original} />
      </div>
    </NodeToolbar>
  );
}
