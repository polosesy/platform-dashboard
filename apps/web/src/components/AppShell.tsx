"use client";

import { useRef, useState } from "react";
import { usePathname } from "next/navigation";
import styles from "./AppShell.module.css";
import { TopNav } from "./TopNav";
import { Sidebar } from "./Sidebar";

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  // The drawer stays open only on the path it was opened on — navigating closes it
  const [openedAt, setOpenedAt] = useState<string | null>(null);
  const sidebarOpen = openedAt === pathname;
  const menuBtnRef = useRef<HTMLButtonElement>(null);

  const toggleSidebar = () => setOpenedAt(sidebarOpen ? null : pathname);
  const closeSidebar = () => {
    setOpenedAt(null);
    menuBtnRef.current?.focus();
  };

  return (
    <div className={styles.shell}>
      <TopNav onMenuClick={toggleSidebar} menuOpen={sidebarOpen} menuBtnRef={menuBtnRef} />
      <Sidebar open={sidebarOpen} onClose={closeSidebar} />
      <main className={styles.main}>
        <div className={styles.container}>{children}</div>
      </main>
    </div>
  );
}
