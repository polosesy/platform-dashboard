"use client";

// This browser only: raise a desktop notification for new firing sev1/sev2 alerts while the dashboard is open
// (the bell polls). Permission is asked once; nothing leaves the browser.

import { useEffect, useState } from "react";
import { Toggle } from "@/components/ui";
import { useI18n } from "@/lib/i18n";
import { DESKTOP_KEY, desktopOn } from "@/components/NotificationBell";

export function DesktopToggle() {
  const { t } = useI18n();
  const [on, setOn] = useState(false);
  const [denied, setDenied] = useState(false);
  useEffect(() => { setOn(desktopOn()); setDenied(typeof Notification !== "undefined" && Notification.permission === "denied"); }, []);
  if (typeof window !== "undefined" && typeof Notification === "undefined") return null;
  const change = async (v: boolean) => {
    if (v && Notification.permission !== "granted") {
      const p = await Notification.requestPermission().catch(() => "denied" as NotificationPermission);
      if (p !== "granted") { setDenied(true); return; }
    }
    try { localStorage.setItem(DESKTOP_KEY, v ? "1" : "0"); } catch { /* storage blocked */ }
    setOn(v);
  };
  return (
    <Toggle checked={on} onChange={(v) => void change(v)} disabled={denied} title={denied ? t("notify.desktopDenied") : t("notify.desktopHint")}>
      {t("notify.desktop")}
    </Toggle>
  );
}
