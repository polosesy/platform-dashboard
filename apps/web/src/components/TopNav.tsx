"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import { NAV_GROUPS, activeGroupKey, isItemActive, sectionBefore, type NavGroup } from "@/lib/navConfig";
import { useI18n } from "@/lib/i18n";
import { AuthControls } from "./AuthControls";
import { NavIcon } from "./navIcons";
import styles from "./TopNav.module.css";

type TopNavProps = {
  onMenuClick?: () => void;
  menuOpen?: boolean;
  menuBtnRef?: RefObject<HTMLButtonElement | null>;
};

export function TopNav({ onMenuClick, menuOpen = false, menuBtnRef }: TopNavProps) {
  const pathname = usePathname();
  const { t } = useI18n();
  // A dropdown is open only for the path it was opened on — navigating closes it without an effect
  const [opened, setOpened] = useState<{ key: string; path: string } | null>(null);
  const openKey = opened && opened.path === pathname ? opened.key : null;
  const navRef = useRef<HTMLElement>(null);
  const triggers = useRef(new Map<string, HTMLButtonElement>());
  const panels = useRef(new Map<string, HTMLUListElement>());
  const activeGroup = activeGroupKey(pathname);

  const close = (focusTrigger?: string) => {
    setOpened(null);
    if (focusTrigger) triggers.current.get(focusTrigger)?.focus();
  };
  const panelLinks = (key: string) => [...(panels.current.get(key)?.querySelectorAll<HTMLAnchorElement>("a") ?? [])];
  const focusLinkLater = (key: string, which: "first" | "last") =>
    requestAnimationFrame(() => {
      const links = panelLinks(key);
      (which === "first" ? links[0] : links[links.length - 1])?.focus();
    });

  // Outside pointerdown closes the open dropdown (pointerdown also fires over canvases)
  useEffect(() => {
    if (!openKey) return;
    const onDown = (e: PointerEvent) => {
      if (!navRef.current?.contains(e.target as Node)) setOpened(null);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [openKey]);

  const onTriggerKey = (e: KeyboardEvent<HTMLButtonElement>, g: NavGroup) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setOpened({ key: g.key, path: pathname });
      focusLinkLater(g.key, e.key === "ArrowDown" ? "first" : "last");
    } else if (e.key === "Escape" && openKey === g.key) {
      e.preventDefault();
      close(g.key);
    }
  };
  const onPanelKey = (e: KeyboardEvent<HTMLUListElement>, key: string) => {
    const links = panelLinks(key);
    const i = links.indexOf(document.activeElement as HTMLAnchorElement);
    let next: HTMLAnchorElement | undefined;
    if (e.key === "ArrowDown") next = links[(i + 1) % links.length];
    else if (e.key === "ArrowUp") next = links[(i - 1 + links.length) % links.length];
    else if (e.key === "Home") next = links[0];
    else if (e.key === "End") next = links[links.length - 1];
    else if (e.key === "Escape") { e.preventDefault(); close(key); return; }
    else return;
    e.preventDefault();
    next?.focus();
  };

  return (
    <header className={styles.header}>
      <div className={styles.bar}>
        <div className={styles.brandGroup}>
          <button
            ref={menuBtnRef}
            className={styles.menuBtn}
            onClick={() => { setOpened(null); onMenuClick?.(); }}
            type="button"
            aria-label={menuOpen ? t("nav.closeMenu") : t("nav.openMenu")}
            aria-expanded={menuOpen}
            aria-controls="nav-drawer"
          >
            <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true" focusable="false">
              <path d="M2 4.5h14M2 9h14M2 13.5h14" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
          </button>

          <Link href="/" className={styles.brand}>
            <div className={styles.mark} aria-hidden="true" />
            <div>
              <div className={styles.brandName}>Azure Unified Dashboard</div>
              <div className={styles.brandMeta}>{t("nav.brandMeta")}</div>
            </div>
          </Link>
        </div>

        <nav ref={navRef} className={styles.nav} aria-label={t("nav.main")}>
          {NAV_GROUPS.map((g) => {
            const groupActive = activeGroup === g.key;
            if (g.items.length === 1) {
              const it = g.items[0]!;
              const active = isItemActive(pathname, it.href);
              return (
                <Link key={g.key} href={it.href} className={`${styles.link} ${active ? styles.linkActive : ""}`} aria-current={active ? "page" : undefined} onClick={() => setOpened(null)} title={t(it.descKey)}>
                  {t(g.labelKey)}
                </Link>
              );
            }
            const open = openKey === g.key;
            return (
              <div
                key={g.key}
                className={styles.group}
                onBlur={(e) => {
                  if (open && !e.currentTarget.contains(e.relatedTarget as Node | null)) setOpened(null);
                }}
              >
                <button
                  ref={(el) => { if (el) triggers.current.set(g.key, el); else triggers.current.delete(g.key); }}
                  type="button"
                  className={`${styles.link} ${styles.trigger} ${groupActive ? styles.linkActive : ""}`}
                  data-active={groupActive || undefined}
                  aria-expanded={open}
                  aria-controls={`nav-panel-${g.key}`}
                  onClick={() => setOpened(open ? null : { key: g.key, path: pathname })}
                  onKeyDown={(e) => onTriggerKey(e, g)}
                >
                  {t(g.labelKey)}
                  <svg className={styles.chevron} width="10" height="10" viewBox="0 0 10 10" aria-hidden="true" focusable="false">
                    <path d="M2 3.5 5 6.5 8 3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </button>
                <ul
                  ref={(el) => { if (el) panels.current.set(g.key, el); else panels.current.delete(g.key); }}
                  id={`nav-panel-${g.key}`}
                  className={styles.panel}
                  hidden={!open}
                  onKeyDown={(e) => onPanelKey(e, g.key)}
                >
                  {g.items.map((it, i) => {
                    const active = isItemActive(pathname, it.href);
                    const section = sectionBefore(g.items, i);
                    return (
                      <li key={it.href}>
                        {section ? <div className={styles.panelSection} aria-hidden="true">{t(section)}</div> : null}
                        <Link href={it.href} className={styles.panelLink} data-active={active || undefined} aria-current={active ? "page" : undefined} onClick={() => setOpened(null)}>
                          <span className={styles.panelIcon}><NavIcon name={it.icon} /></span>
                          <span>
                            <span className={styles.panelLabel}>{t(it.labelKey)}</span>
                            <span className={styles.panelDesc}>{t(it.descKey)}</span>
                          </span>
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              </div>
            );
          })}
        </nav>

        <AuthControls />
      </div>
    </header>
  );
}
