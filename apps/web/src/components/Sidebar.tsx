"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useI18n } from "@/lib/i18n";
import styles from "./Sidebar.module.css";

export type SidebarProps = {
  open: boolean;
  onClose: () => void;
};

const iconMap: Record<string, string> = {
  grid: "\u25A6",
  sitemap: "\u2B13",
  pulse: "\u2248",
  heart: "\u2665",
  network: "\u2B82",
  dollar: "\u0024",
  shield: "\u26E8",
  git: "\u2B60",
  globe: "\u2B24",
};

export function Sidebar({ open, onClose }: SidebarProps) {
  const pathname = usePathname();
  const { t, locale, setLocale } = useI18n();

  const sections = [
    {
      label: t("nav.dashboard"),
      items: [{ href: "/", label: t("common.overview"), icon: "grid" }],
    },
    {
      label: t("nav.visualization"),
      items: [
        { href: "/architecture", label: t("common.architecture"), icon: "sitemap" },
        { href: "/live-diagram", label: t("common.liveDiagram"), icon: "pulse" },
      ],
    },
    {
      label: t("nav.monitoring"),
      items: [
        { href: "/health", label: t("nav.resourceHealth"), icon: "heart" },
        { href: "/network", label: t("nav.networkFlow"), icon: "network" },
      ],
    },
    {
      label: t("nav.operations"),
      items: [
        { href: "/cost", label: t("nav.costManagement"), icon: "dollar" },
        { href: "/security", label: t("common.security"), icon: "shield" },
        { href: "/argocd", label: t("common.argocd"), icon: "git" },
      ],
    },
  ];

  return (
    <>
      {/* Backdrop overlay */}
      <div
        className={`${styles.backdrop} ${open ? styles.backdropVisible : ""}`}
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Sidebar panel */}
      <aside
        className={`${styles.sidebar} ${open ? styles.sidebarOpen : ""}`}
        aria-label="Main navigation"
      >
        <div className={styles.sidebarHeader}>
          <div className={styles.sidebarBrand}>
            <div className={styles.sidebarMark} aria-hidden="true" />
            <span className={styles.sidebarTitle}>Azure Dashboard</span>
          </div>
          <button
            className={styles.closeBtn}
            onClick={onClose}
            type="button"
            aria-label="Close menu"
          >
            &times;
          </button>
        </div>

        <nav className={styles.sidebarNav}>
          {sections.map((section) => (
            <div key={section.label} className={styles.section}>
              <div className={styles.sectionLabel}>{section.label}</div>
              {section.items.map((item) => {
                const active =
                  item.href === "/"
                    ? pathname === "/"
                    : pathname === item.href ||
                      pathname.startsWith(item.href + "/");
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    className={`${styles.navItem} ${active ? styles.navItemActive : ""}`}
                    onClick={onClose}
                  >
                    <span className={styles.navIcon} aria-hidden="true">
                      {iconMap[item.icon] ?? "\u25CF"}
                    </span>
                    {item.label}
                  </Link>
                );
              })}
            </div>
          ))}

          {/* Settings section with language selector */}
          <div className={styles.section}>
            <div className={styles.sectionLabel}>{t("nav.settings")}</div>
            <div className={styles.settingRow}>
              <span className={styles.navIcon} aria-hidden="true">{iconMap.globe}</span>
              <span className={styles.settingLabel}>{t("settings.language")}</span>
              <div className={styles.langSwitch}>
                <button
                  type="button"
                  className={`${styles.langBtn} ${locale === "ko" ? styles.langBtnActive : ""}`}
                  onClick={() => setLocale("ko")}
                >
                  {t("settings.korean")}
                </button>
                <button
                  type="button"
                  className={`${styles.langBtn} ${locale === "en" ? styles.langBtnActive : ""}`}
                  onClick={() => setLocale("en")}
                >
                  {t("settings.english")}
                </button>
              </div>
            </div>
          </div>
        </nav>

        <div className={styles.sidebarFooter}>
          <div className={styles.footerLabel}>Azure Unified Dashboard</div>
          <div className={styles.footerMeta}>SaaS Visualization Platform</div>
        </div>
      </aside>
    </>
  );
}
