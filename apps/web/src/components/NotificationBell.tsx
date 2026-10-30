"use client";

// Top-bar bell of the 알림 센터: firing alerts not acknowledged yet (sev1/sev2 colour the badge), polled every 60 s on
// a visible tab. With desktop notifications turned on (this browser, DesktopToggle), a new firing sev1/sev2 raises a
// system notification — no messenger involved. Signed-out users see nothing.

import { useCallback, useEffect, useRef } from "react";
import Link from "next/link";
import type { NotificationsResponse } from "@aud/types";
import { apiUrl, fetchJsonWithBearer } from "@/lib/api";
import { useI18n } from "@/lib/i18n";
import { useApiQuery } from "@/lib/useApiQuery";
import { useMe } from "@/lib/useMe";
import { usePolling } from "@/lib/usePolling";
import { newUrgent, targetText } from "@/lib/notifyView";
import styles from "./NotificationBell.module.css";

export const DESKTOP_KEY = "aud.notify.desktop";
const SEEN_KEY = "aud.notify.seen";

const readSeen = (): Set<string> => {
  try { return new Set(JSON.parse(sessionStorage.getItem(SEEN_KEY) ?? "[]") as string[]); } catch { return new Set(); }
};
const writeSeen = (s: Set<string>) => {
  try { sessionStorage.setItem(SEEN_KEY, JSON.stringify([...s].slice(-500))); } catch { /* storage blocked */ }
};
export const desktopOn = () => {
  try { return localStorage.getItem(DESKTOP_KEY) === "1" && typeof Notification !== "undefined" && Notification.permission === "granted"; } catch { return false; }
};

export function NotificationBell() {
  const { t } = useI18n();
  const me = useMe().data;
  const signedIn = !!me && !me.anonymous && !!me.role;
  const q = useApiQuery<NotificationsResponse>(signedIn ? "notify-bell" : null, (token) => fetchJsonWithBearer(apiUrl("/api/notifications", { status: "firing", limit: 200 }), token));
  const reload = q.reload;
  usePolling(useCallback(async () => { if (signedIn) reload(); }, [reload, signedIn]), 60_000, signedIn);
  const first = useRef(true);

  useEffect(() => {
    if (!q.data) return;
    const seen = readSeen();
    const fresh = newUrgent(q.data.items, seen);
    // The first load of a session only marks what is already there — no burst of old alerts
    if (!first.current && desktopOn()) {
      for (const a of fresh.slice(0, 3)) {
        try { new Notification(`[${a.severity.toUpperCase()}] ${a.title}`, { body: [targetText(a), a.summary].filter(Boolean).join(" · ").slice(0, 200), tag: a.id }); } catch { /* not allowed here */ }
      }
    }
    first.current = false;
    for (const a of fresh) seen.add(`${a.id}@${a.startsAt}`);
    writeSeen(seen);
  }, [q.data]);

  if (!signedIn) return null;
  const n = q.data?.counts.firingUnacked ?? 0;
  const urgent = (q.data?.items ?? []).some((a) => !a.ack && (a.severity === "sev1" || a.severity === "sev2"));
  return (
    <Link href="/notifications" className={styles.bell} aria-label={t("notify.bell", { n })} title={t("notify.bell", { n })}>
      <svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15L6 16Z" /><path d="M10 20a2 2 0 0 0 4 0" />
      </svg>
      {n > 0 ? <span className={styles.count} data-urgent={urgent || undefined}>{n > 99 ? "99+" : n}</span> : null}
    </Link>
  );
}
