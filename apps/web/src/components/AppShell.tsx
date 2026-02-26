"use client";

import { useState, useCallback } from "react";
import styles from "./AppShell.module.css";
import { TopNav } from "./TopNav";
import { Sidebar } from "./Sidebar";

export function AppShell({ children }: { children: React.ReactNode }) {
  const [sidebarOpen, setSidebarOpen] = useState(false);

  const openSidebar = useCallback(() => setSidebarOpen(true), []);
  const closeSidebar = useCallback(() => setSidebarOpen(false), []);

  return (
    <div className={styles.shell}>
      <TopNav onMenuClick={openSidebar} />
      <Sidebar open={sidebarOpen} onClose={closeSidebar} />
      <main className={styles.main}>
        <div className={styles.container}>{children}</div>
      </main>
    </div>
  );
}
