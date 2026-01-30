"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { AuthenticatedTemplate, UnauthenticatedTemplate, useMsal } from "@azure/msal-react";
import styles from "./TopNav.module.css";
import { loginRequest } from "@/lib/msal";

const links = [
  { href: "/", label: "Overview" },
  { href: "/architecture", label: "Architecture" },
  { href: "/network", label: "Network" },
  { href: "/argocd", label: "ArgoCD" },
];

export function TopNav() {
  const pathname = usePathname();
  const { instance, accounts } = useMsal();
  const user = accounts[0];

  return (
    <header className={styles.header}>
      <div className={styles.bar}>
        <div className={styles.brand}>
          <div className={styles.mark} aria-hidden="true" />
          <div>
            <div className={styles.brandName}>Azure Unified Dashboard</div>
            <div className={styles.brandMeta}>MVP</div>
          </div>
        </div>

        <nav className={styles.nav}>
          {links.map((l) => {
            const active = pathname === l.href;
            return (
              <Link key={l.href} href={l.href} className={`${styles.link} ${active ? styles.linkActive : ""}`}>
                {l.label}
              </Link>
            );
          })}
        </nav>

        <div className={styles.right}>
          <AuthenticatedTemplate>
            <div className={styles.user} title={user?.username}>
              <span className={styles.userDot} aria-hidden="true" />
              <span className={styles.userName}>{user?.name ?? user?.username ?? "Signed in"}</span>
            </div>
            <button
              className={styles.btnSecondary}
              onClick={() => instance.logoutPopup({ account: user }).catch((e) => console.warn("Logout failed", e))}
              type="button"
            >
              Logout
            </button>
          </AuthenticatedTemplate>

          <UnauthenticatedTemplate>
            <button
              className={styles.btnPrimary}
              onClick={() => instance.loginPopup(loginRequest).catch((e) => console.warn("Login failed", e))}
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
