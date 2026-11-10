"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef } from "react";
import { NAV_GROUPS, isItemActive, sectionBefore } from "@/lib/navConfig";
import { useI18n } from "@/lib/i18n";
import { NavIcon } from "./navIcons";
import { Segmented } from "@/components/ui";
import { useDisplayPrefs } from "@/lib/displayPrefs";
import styles from "./Sidebar.module.css";

export type SidebarProps = {
  open: boolean;
  /** Wide screens: always shown on the left (no backdrop, no close button) */
  docked?: boolean;
  onClose: () => void;
};

/** The menu — docked on the left on wide screens, a drawer on narrow ones; NAV_GROUPS, every section expanded. */
export function Sidebar({ open, docked = false, onClose }: SidebarProps) {
  const pathname = usePathname();
  const { t, locale, setLocale } = useI18n();
  const closeRef = useRef<HTMLButtonElement>(null);
  const prefs = useDisplayPrefs();

  // Move focus into the drawer when it opens (DOM only — no state change)
  useEffect(() => {
    if (open && !docked) closeRef.current?.focus();
  }, [open, docked]);
  const shown = open || docked;

  return (
    <>
      {docked ? null : <div className={`${styles.backdrop} ${open ? styles.backdropVisible : ""}`} onClick={onClose} aria-hidden="true" />}

      <aside
        id="nav-drawer"
        className={`${styles.sidebar} ${open ? styles.sidebarOpen : ""} ${docked ? styles.sidebarDocked : ""}`}
        inert={!shown}
        aria-hidden={!shown}
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
          {docked ? null : (
            <button ref={closeRef} className={styles.closeBtn} onClick={onClose} type="button" aria-label={t("nav.closeMenu")}>
              &times;
            </button>
          )}
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
                        onClick={docked ? undefined : onClose}
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
            <h2 id="nav-sec-settings" className={styles.sectionLabel}>{t("nav.display")}</h2>
            <div className={styles.settingRow}>
              <span className={styles.settingLabel}>{t("settings.language")}</span>
              <Segmented label={t("settings.language")} value={locale} onChange={setLocale}
                items={[{ id: "ko", label: t("settings.korean") }, { id: "en", label: t("settings.english") }]} />
            </div>
            {/* Display: theme (dark is opt-in) and density — this browser only */}
            <div className={styles.settingRow}>
              <span className={styles.settingLabel}>{t("settings.theme")}</span>
              <Segmented label={t("settings.theme")} value={prefs.theme} onChange={prefs.setTheme}
                items={[{ id: "light", label: t("settings.theme.light") }, { id: "dark", label: t("settings.theme.dark") }, { id: "system", label: t("settings.theme.system") }]} />
            </div>
            <div className={styles.settingRow}>
              <span className={styles.settingLabel}>{t("settings.density")}</span>
              <Segmented label={t("settings.density")} value={prefs.density} onChange={prefs.setDensity}
                items={[{ id: "comfortable", label: t("settings.density.comfortable") }, { id: "compact", label: t("settings.density.compact") }]} />
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
