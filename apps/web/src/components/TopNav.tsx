"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { AuthenticatedTemplate, UnauthenticatedTemplate, useMsal } from "@azure/msal-react";
import styles from "./TopNav.module.css";
import { loginRequest } from "@/lib/msal";

const links = [
  { href: "/", label: "Overview" },
  { href: "/architecture", label: "Architecture" },
  { href: "/live-diagram", label: "Live Diagram" },
  { href: "/health", label: "Health" },
  { href: "/network", label: "Network" },
  { href: "/cost", label: "Cost" },
  { href: "/security", label: "Security" },
  { href: "/argocd", label: "ArgoCD" },
];

type TopNavProps = {
  onMenuClick?: () => void;
};

export function TopNav({ onMenuClick }: TopNavProps) {
  const pathname = usePathname();
  const { instance, accounts } = useMsal();
  const user = accounts[0];

  return (
    <header className={styles.header}>
      <div className={styles.bar}>
        {/* Hamburger + Brand */}
        <div className={styles.brandGroup}>
          <button
            className={styles.menuBtn}
            onClick={onMenuClick}
            type="button"
            aria-label="Open navigation menu"
          >
            <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
              <path d="M2 4.5h14M2 9h14M2 13.5h14" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
          </button>

          <Link href="/" className={styles.brand}>
            <div className={styles.mark} aria-hidden="true" />
            <div>
              <div className={styles.brandName}>Azure Unified Dashboard</div>
              <div className={styles.brandMeta}>SaaS Platform</div>
            </div>
          </Link>
        </div>

        {/* Navigation links */}
        <nav className={styles.nav}>
          {links.map((l) => {
            const active =
              l.href === "/"
                ? pathname === "/"
                : pathname === l.href || pathname.startsWith(l.href + "/");
            return (
              <Link
                key={l.href}
                href={l.href}
                className={`${styles.link} ${active ? styles.linkActive : ""}`}
              >
                {l.label}
              </Link>
            );
          })}
        </nav>

        {/* Auth / User */}
        <div className={styles.right}>
          <AuthenticatedTemplate>
            <div className={styles.user} title={user?.username}>
              <span className={styles.userDot} aria-hidden="true" />
              <span className={styles.userName}>
                {user?.name ?? user?.username ?? "Signed in"}
              </span>
            </div>
            <button
              className={styles.btnSecondary}
              onClick={() =>
                instance
                  .logoutPopup({ account: user })
                  .catch((e) => console.warn("Logout failed", e))
              }
              type="button"
            >
              Logout
            </button>
          </AuthenticatedTemplate>

          <UnauthenticatedTemplate>
            <button
              className={styles.btnPrimary}
              onClick={() =>
                instance
                  .loginPopup(loginRequest)
                  .catch((e) => console.warn("Login failed", e))
              }
              type="button"
            >
              Login
            </button>
          </UnauthenticatedTemplate>
        </div>
      </div>
    </header>
  );
}
