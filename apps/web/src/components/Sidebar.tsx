"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import styles from "./Sidebar.module.css";

export type SidebarProps = {
  open: boolean;
  onClose: () => void;
};

const sections = [
  {
    label: "Dashboard",
    items: [{ href: "/", label: "Overview", icon: "grid" }],
  },
  {
    label: "Visualization",
    items: [
      { href: "/architecture", label: "Architecture Map", icon: "sitemap" },
      { href: "/live-diagram", label: "Live Diagram", icon: "pulse" },
    ],
  },
  {
    label: "Monitoring",
    items: [
      { href: "/health", label: "Resource Health", icon: "heart" },
      { href: "/network", label: "Network Flow", icon: "network" },
    ],
  },
  {
    label: "Operations",
    items: [
      { href: "/cost", label: "Cost Management", icon: "dollar" },
      { href: "/security", label: "Security", icon: "shield" },
      { href: "/argocd", label: "ArgoCD", icon: "git" },
    ],
  },
];

const iconMap: Record<string, string> = {
  grid: "\u25A6",
  sitemap: "\u2B13",
  pulse: "\u2248",
  heart: "\u2665",
  network: "\u2B82",
  dollar: "\u0024",
  shield: "\u26E8",
  git: "\u2B60",
};

export function Sidebar({ open, onClose }: SidebarProps) {
  const pathname = usePathname();

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
        </nav>

        <div className={styles.sidebarFooter}>
          <div className={styles.footerLabel}>Azure Unified Dashboard</div>
          <div className={styles.footerMeta}>SaaS Visualization Platform</div>
        </div>
      </aside>
    </>
  );
}
