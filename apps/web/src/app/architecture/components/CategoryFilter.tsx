"use client";

import { ARCH_CATEGORIES, archCategoryOf, type ArchCategory, type ArchModel } from "@/lib/archModel";
import { useI18n } from "@/lib/i18n";
import s from "../styles.module.css";

type Props = {
  model: ArchModel;
  counts: Record<ArchCategory, number>;
  /** null = everything shown */
  value: ReadonlySet<ArchCategory> | null;
  onChange: (next: ReadonlySet<ArchCategory> | null) => void;
};

/** "표시 범위" — choose which service categories the diagram draws (hide + re-layout). */
export function CategoryFilter({ model, counts, value, onChange }: Props) {
  const { t } = useI18n();
  const selected = value ?? new Set(ARCH_CATEGORIES);
  const all = !value;

  // What each category contains in this subscription, e.g. "Key Vault 6" — shown as a tooltip
  const kindsOf = (c: ArchCategory) => {
    const byKind = new Map<string, number>();
    for (const r of model.resources.values()) if (archCategoryOf(r.node.kind) === c) byKind.set(r.node.kind, (byKind.get(r.node.kind) ?? 0) + 1);
    return [...byKind].map(([k, n]) => `${t(`arch.kind.${k}`) === `arch.kind.${k}` ? k : t(`arch.kind.${k}`)} ${n}`).join(", ");
  };
  const toggle = (c: ArchCategory) => {
    const next = new Set(selected);
    if (next.has(c)) next.delete(c);
    else next.add(c);
    if (next.size === 0) return; // the last category cannot be cleared
    onChange(next.size === ARCH_CATEGORIES.length ? null : next);
  };

  return (
    <details className={s.layers}>
      <summary aria-label={t("arch.filter.title")}>
        {t("arch.filter.title")}
        {all ? "" : ` · ${selected.size}/${ARCH_CATEGORIES.length}`}
      </summary>
      <div className={s.layerList}>
        <div className={s.filterHead}>
          <button type="button" className={s.linkBtn} onClick={() => onChange(null)} disabled={all}>
            {t("arch.filter.all")}
          </button>
        </div>
        {ARCH_CATEGORIES.map((c) => {
          const on = selected.has(c);
          return (
            <label key={c} className={s.layerItem} title={kindsOf(c) || t("arch.filter.none")}>
              <input type="checkbox" checked={on} disabled={on && selected.size === 1} onChange={() => toggle(c)} />
              <span className={s.filterName}>{t(`arch.cat.${c}`)}</span>
              <span className={s.filterCount}>{counts[c]}</span>
            </label>
          );
        })}
        <p className={s.filterNote}>{t("arch.filter.note")}</p>
      </div>
    </details>
  );
}
