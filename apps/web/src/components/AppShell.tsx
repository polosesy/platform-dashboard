"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import styles from "./AppShell.module.css";
import { TopNav } from "./TopNav";
import { Sidebar } from "./Sidebar";
import { CommandPalette } from "./CommandPalette";
import { ScopeBar } from "./ScopeBar";
import { DOCK_QUERY, useMediaQuery } from "@/lib/useMediaQuery";
import { NAV_EXEMPT_ROUTES } from "@/lib/navConfig";

/**
 * The page frame (design draft ⑦): on wide screens (≥ 1100 px) the menu is docked on the left and the top bar keeps
 * search (Ctrl+K), notifications and the account; on narrow screens the same menu is a drawer behind the ☰ button.
 * The sign-in page has no frame.
 */
export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const docked = useMediaQuery(DOCK_QUERY);
  // The drawer stays open only on the path it was opened on — navigating closes it
  const [openedAt, setOpenedAt] = useState<string | null>(null);
  const sidebarOpen = !docked && openedAt === pathname;
  const menuBtnRef = useRef<HTMLButtonElement>(null);
  const [palette, setPalette] = useState(false);

  // Ctrl+K / ⌘K anywhere opens quick open (Esc closes it — inside the dialog)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPalette((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if ((NAV_EXEMPT_ROUTES as readonly string[]).includes(pathname)) return <>{children}</>;

  const toggleSidebar = () => setOpenedAt(sidebarOpen ? null : pathname);
  const closeSidebar = () => {
    setOpenedAt(null);
    menuBtnRef.current?.focus();
  };

  return (
    <div className={styles.shell} data-docked={docked || undefined}>
      <Sidebar open={sidebarOpen} docked={docked} onClose={closeSidebar} />
      <div className={styles.frame}>
        <TopNav onMenuClick={toggleSidebar} menuOpen={sidebarOpen} menuBtnRef={menuBtnRef} docked={docked} onSearch={() => setPalette(true)} />
        <main className={styles.main}>
          <div className={styles.container}>
            <ScopeBar />
            {children}
          </div>
        </main>
      </div>
      <CommandPalette open={palette} onClose={() => setPalette(false)} />
    </div>
  );
}
