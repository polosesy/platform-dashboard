"use client";

import { useState } from "react";
import type { HealthStatus } from "@aud/types";
import { useI18n } from "@/lib/i18n";
import { LIVE_EDGE_LOOK, cometTailPath, liveStroke, type LiveEdgeStyleKey } from "@/lib/liveStyle";
import { rgba } from "@/lib/palette";
import { nodeColor } from "../utils/designTokens";
import styles from "../styles.module.css";

const RINGS: HealthStatus[] = ["ok", "warning", "critical", "unknown"];

/**
 * What the colours mean — only the line kinds on screen (same table as the canvas), the status rings,
 * and the fault-impact outline when it is showing.
 */
export function Legend({ lines, impact, ghost, traffic }: { lines: LiveEdgeStyleKey[]; impact: boolean; ghost: boolean; traffic: boolean }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  return (
    <div className={styles.legend}>
      <button type="button" className={styles.legendToggle} aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        {t("ld.legend.title")} {open ? "−" : "+"}
      </button>
      {open && (
        <div className={styles.legendBody} data-testid="legend">
          {lines.length > 0 && (
            <ul className={styles.legendList}>
              {lines.map((k) => (
                <li key={k} data-key={k}>
                  <svg width={30} height={10} aria-hidden="true">
                    <line x1={1} y1={5} x2={29} y2={5} stroke={liveStroke(k)} strokeWidth={Math.min(LIVE_EDGE_LOOK[k].width + 0.4, 2.4)} strokeDasharray={LIVE_EDGE_LOOK[k].dash} />
                  </svg>
                  {t(`ld.legend.line.${k}`)}
                </li>
              ))}
            </ul>
          )}
          {traffic && (
            <ul className={styles.legendList}>
              <li data-key="traffic">
                <svg width={30} height={10} aria-hidden="true">
                  <g transform="translate(24 5)">
                    <path d={cometTailPath(3, 14)} style={{ fill: "url(#ld-ptail-accent)" }} />
                    <circle r={3} style={{ fill: "rgb(var(--accent-rgb))", stroke: "rgba(var(--paper-rgb), 0.92)", strokeWidth: 1.25 }} />
                  </g>
                </svg>
                {t("ld.legend.traffic")}
              </li>
            </ul>
          )}
          <ul className={styles.legendList}>
            {RINGS.map((h) => (
              <li key={h}>
                <svg width={14} height={14} aria-hidden="true"><circle cx={7} cy={7} r={5} fill="none" stroke={nodeColor(h).ringStroke} strokeWidth={2.4} /></svg>
                {t(`ld.legend.ring.${h}`)}
              </li>
            ))}
            {impact && (
              <li>
                <svg width={14} height={14} aria-hidden="true"><rect x={1.5} y={1.5} width={11} height={11} rx={3} fill="none" stroke={rgba("danger")} strokeWidth={2} /></svg>
                {t("ld.legend.impact")}
              </li>
            )}
            {ghost && (
              <li>
                <svg width={14} height={14} aria-hidden="true"><rect x={1.5} y={1.5} width={11} height={11} rx={3} fill="none" stroke={rgba("ink", 0.35)} strokeDasharray="2 2" /></svg>
                {t("ld.legend.ghost")}
              </li>
            )}
          </ul>
          <p className={styles.legendNote}>{t("ld.legend.note")}</p>
        </div>
      )}
    </div>
  );
}
