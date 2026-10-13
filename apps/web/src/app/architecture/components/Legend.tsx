"use client";

import { ARCH_EDGE_KINDS } from "@/lib/archModel";
import { useI18n } from "@/lib/i18n";
import { EDGE_STYLE } from "../utils/toFlow";
import s from "../styles.module.css";

/** Boundaries, line kinds and badges — line samples come from the same style table as the canvas. */
export function Legend({ open, onToggle, showContext = false }: { open: boolean; onToggle: () => void; showContext?: boolean }) {
  const { t } = useI18n();
  return (
    <div className={s.legend}>
      <button type="button" className={s.legendToggle} aria-expanded={open} onClick={onToggle}>
        {t("arch.legend")} {open ? "−" : "+"}
      </button>
      {open ? (
        <div className={s.legendBody}>
          <div className={s.legendGroup}>
            <span className={`${s.legendBox} ${s.lb_region}`} />{t("arch.box.region")}
            <span className={`${s.legendBox} ${s.lb_vnet}`} />VNet
            <span className={`${s.legendBox} ${s.lb_subnet}`} />{t("arch.box.subnet")}
            {showContext ? <><span className={`${s.legendBox} ${s.lb_context}`} />{t("arch.filter.contextLegend")}</> : null}
          </div>
          <ul className={s.legendLines}>
            {[...ARCH_EDGE_KINDS, "traffic" as const].map((k) => {
              const st = EDGE_STYLE[k];
              return (
                <li key={k}>
                  <svg width="34" height="10" aria-hidden="true">
                    <line x1="1" y1="5" x2="33" y2="5" stroke={st.stroke} strokeWidth={Math.min(st.width, 2.4)} strokeDasharray={st.dash} />
                  </svg>
                  {t(`arch.layer.${k}`)}
                </li>
              );
            })}
          </ul>
          <p className={s.legendNote}>{t("arch.legendNote")}</p>
        </div>
      ) : null}
    </div>
  );
}
