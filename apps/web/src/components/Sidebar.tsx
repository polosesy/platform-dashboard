"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef } from "react";
import { NAV_GROUPS, isItemActive, sectionBefore } from "@/lib/navConfig";
import { useI18n } from "@/lib/i18n";
import { NavIcon } from "./navIcons";
import styles from "./Sidebar.module.css";

export type SidebarProps = {
  open: boolean;
  onClose: () => void;
};

/** Drawer navigation — the same NAV_GROUPS as the top bar, every section expanded. */
export function Sidebar({ open, onClose }: SidebarProps) {
  const pathname = usePathname();
  const { t, locale, setLocale } = useI18n();
  const closeRef = useRef<HTMLButtonElement>(null);

  // Move focus into the drawer when it opens (DOM only — no state change)
  useEffect(() => {
    if (open) closeRef.current?.focus();
  }, [open]);

  return (
    <>
      <div className={`${styles.backdrop} ${open ? styles.backdropVisible : ""}`} onClick={onClose} aria-hidden="true" />

      <aside
        id="nav-drawer"
        className={`${styles.sidebar} ${open ? styles.sidebarOpen : ""}`}
        inert={!open}
        aria-hidden={!open}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation();
            onClose();
          }
        }}
      >
        <div className={styles.sidebarHeader}>
          <div className={styles.sidebarBrand}>
            <div className={styles.sidebarMark} aria-hidden="true" />
            <span className={styles.sidebarTitle}>Azure Unified Dashboard</span>
          </div>
          <button ref={closeRef} className={styles.closeBtn} onClick={onClose} type="button" aria-label={t("nav.closeMenu")}>
            &times;
          </button>
        </div>

        <nav className={styles.sidebarNav} aria-label={t("nav.main")}>
          {NAV_GROUPS.map((g) => {
            const headed = g.key !== "overview";
            const list = (
              <ul className={styles.list} aria-labelledby={headed ? `nav-sec-${g.key}` : undefined} aria-label={headed ? undefined : t(g.labelKey)}>
                {g.items.map((it, i) => {
                  const active = isItemActive(pathname, it.href);
                  const section = sectionBefore(g.items, i);
                  return (
                    <li key={it.href}>
                      {section ? <div className={styles.subLabel} aria-hidden="true">{t(section)}</div> : null}
                      <Link
                        href={it.href}
                        className={`${styles.navItem} ${active ? styles.navItemActive : ""}`}
                        aria-current={active ? "page" : undefined}
                        title={t(it.descKey)}
                        onClick={onClose}
                      >
                        <span className={styles.navIcon}><NavIcon name={it.icon} /></span>
                        {t(it.labelKey)}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            );
            return (
              <div key={g.key} className={styles.section}>
                {headed && <h2 id={`nav-sec-${g.key}`} className={styles.sectionLabel}>{t(g.labelKey)}</h2>}
                {list}
              </div>
            );
          })}

          <div className={styles.section}>
            <h2 id="nav-sec-settings" className={styles.sectionLabel}>{t("nav.settings")}</h2>
            <div className={styles.settingRow}>
              <span className={styles.navIcon}><NavIcon name="globe" /></span>
              <span className={styles.settingLabel}>{t("settings.language")}</span>
              <div className={styles.langSwitch} role="group" aria-label={t("settings.language")}>
                <button type="button" className={`${styles.langBtn} ${locale === "ko" ? styles.langBtnActive : ""}`} aria-pressed={locale === "ko"} onClick={() => setLocale("ko")}>
                  {t("settings.korean")}
                </button>
                <button type="button" className={`${styles.langBtn} ${locale === "en" ? styles.langBtnActive : ""}`} aria-pressed={locale === "en"} onClick={() => setLocale("en")}>
                  {t("settings.english")}
                </button>
              </div>
            </div>
          </div>
        </nav>

        <div className={styles.sidebarFooter}>
          <div className={styles.footerLabel}>Azure Unified Dashboard</div>
          <div className={styles.footerMeta}>{t("nav.brandMeta")}</div>
        </div>
      </aside>
    </>
  );
}
