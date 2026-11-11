"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { NAV_COLLAPSE_KEY, NAV_GROUPS, isCollapsible, isItemActive, parseCollapsed, sectionBefore, shownItems } from "@/lib/navConfig";
import { useI18n } from "@/lib/i18n";
import { NavIcon } from "./navIcons";
import { LinkButton, Segmented } from "@/components/ui";
import { useDisplayPrefs } from "@/lib/displayPrefs";
import styles from "./Sidebar.module.css";

export type SidebarProps = {
  open: boolean;
  /** Wide screens: always shown on the left (no backdrop, no close button) */
  docked?: boolean;
  onClose: () => void;
};

/**
 * The menu — docked on the left on wide screens, a drawer on narrow ones; NAV_GROUPS. A group's heading folds its links
 * (this browser remembers which — localStorage `aud.nav.collapsed`); a folded group still shows the current page's
 * link, so the menu always says where you are. '모두 접기 / 모두 펼치기' at the top.
 */
export function Sidebar({ open, docked = false, onClose }: SidebarProps) {
  const pathname = usePathname();
  const { t, locale, setLocale } = useI18n();
  const closeRef = useRef<HTMLButtonElement>(null);
  const prefs = useDisplayPrefs();
  // Folded groups: everything open on the server render, the remembered folds right after (no storage = all open)
  const [folded, setFolded] = useState<Set<string>>(() => new Set());
  useEffect(() => {
    try { setFolded(parseCollapsed(window.localStorage.getItem(NAV_COLLAPSE_KEY))); } catch { /* storage blocked: all open */ }
  }, []);
  const remember = (next: Set<string>) => {
    setFolded(next);
    try { window.localStorage.setItem(NAV_COLLAPSE_KEY, JSON.stringify([...next])); } catch { /* not remembered */ }
  };
  const foldable = NAV_GROUPS.filter(isCollapsible).map((g) => g.key);
  const allFolded = foldable.every((k) => folded.has(k));
  const toggle = (key: string) => {
    const next = new Set(folded);
    if (next.has(key)) next.delete(key); else next.add(key);
    remember(next);
  };

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
          <div className={styles.navTools}>
            <LinkButton tone="muted" onClick={() => remember(allFolded ? new Set() : new Set(foldable))}>
              {t(allFolded ? "nav.expandAll" : "nav.collapseAll")}
            </LinkButton>
          </div>
          {NAV_GROUPS.map((g) => {
            const headed = isCollapsible(g);
            const isFolded = headed && folded.has(g.key);
            const items = shownItems(g, isFolded, pathname);
            const list = (
              <ul id={`nav-list-${g.key}`} className={styles.list} aria-labelledby={headed ? `nav-sec-${g.key}` : undefined} aria-label={headed ? undefined : t(g.labelKey)}>
                {items.map((it, i) => {
                  const active = isItemActive(pathname, it.href);
                  const section = isFolded ? null : sectionBefore(g.items, i);
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
                {headed && (
                  <h2 className={styles.sectionLabel}>
                    <button id={`nav-sec-${g.key}`} type="button" className={styles.sectionToggle} aria-expanded={!isFolded} aria-controls={`nav-list-${g.key}`}
                      title={t(isFolded ? "nav.expandGroup" : "nav.collapseGroup", { group: t(g.labelKey) })} onClick={() => toggle(g.key)}>
                      <span className={styles.sectionName}>{t(g.labelKey)}</span>
                      {isFolded ? <span className={styles.sectionCount}>{g.items.length}</span> : null}
                      <span className={styles.chevron} data-open={!isFolded || undefined} aria-hidden="true">▾</span>
                    </button>
                  </h2>
                )}
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
