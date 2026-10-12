import type { NavIcon as NavIconName } from "@/lib/navConfig";

// Decorative 24×24 stroke icons (aria-hidden); every menu entry has a visible text label.
const PATHS: Record<NavIconName, React.ReactNode> = {
  home: <><path d="M3 10.5 12 3l9 7.5" /><path d="M5 9.5V21h14V9.5" /><path d="M10 21v-6h4v6" /></>,
  cloud: <path d="M7 18h10a4 4 0 0 0 .6-7.96A6 6 0 0 0 6.1 9.2 4.5 4.5 0 0 0 7 18Z" />,
  waypoints: <><circle cx="5" cy="6" r="2" /><circle cx="19" cy="6" r="2" /><circle cx="12" cy="18" r="2" /><path d="M7 6h10M6.2 7.7l4.6 8.6M17.8 7.7l-4.6 8.6" /></>,
  helm: <><circle cx="12" cy="12" r="7" /><circle cx="12" cy="12" r="2.5" /><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1 7 17M17 7l2.1-2.1" /></>,
  lock: <><rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></>,
  coins: <><ellipse cx="9" cy="7" rx="6" ry="3" /><path d="M3 7v4c0 1.7 2.7 3 6 3s6-1.3 6-3V7" /><path d="M9 14v3c0 1.7 2.7 3 6 3s6-1.3 6-3v-4c0-1.6-2.4-2.9-5.5-3" /></>,
  dashboard: <><rect x="3" y="3" width="8" height="8" rx="1.5" /><rect x="13" y="3" width="8" height="5" rx="1.5" /><rect x="13" y="10" width="8" height="11" rx="1.5" /><rect x="3" y="13" width="8" height="8" rx="1.5" /></>,
  heartPulse: <><path d="M19.5 12.6 12 20l-7.5-7.4A4.8 4.8 0 0 1 12 6.4a4.8 4.8 0 0 1 7.5 6.2Z" /><path d="M5 12h3l1.5-2.5L12 15l1.5-3H17" /></>,
  activity: <path d="M3 12h4l3-8 4 16 3-8h4" />,
  sitemap: <><rect x="9" y="3" width="6" height="5" rx="1" /><rect x="3" y="16" width="6" height="5" rx="1" /><rect x="15" y="16" width="6" height="5" rx="1" /><path d="M12 8v4M6 16v-2h12v2" /></>,
  arrows: <><path d="M4 8h16M16 4l4 4-4 4" /><path d="M20 16H4M8 12l-4 4 4 4" /></>,
  share: <><circle cx="18" cy="5" r="2.5" /><circle cx="6" cy="12" r="2.5" /><circle cx="18" cy="19" r="2.5" /><path d="m8.2 10.8 7.6-4.6M8.2 13.2l7.6 4.6" /></>,
  boxes: <><path d="M12 3 4 7l8 4 8-4-8-4Z" /><path d="M4 7v10l8 4 8-4V7" /><path d="M12 11v10" /></>,
  gauge: <><path d="M4.5 18a8.5 8.5 0 1 1 15 0" /><path d="m12 14 4-5" /><circle cx="12" cy="14" r="1.2" /></>,
  shieldCheck: <><path d="M12 3 5 6v5c0 4.4 3 8.3 7 10 4-1.7 7-5.6 7-10V6l-7-3Z" /><path d="m9 12 2 2 4-4" /></>,
  clipboardCheck: <><rect x="5" y="4" width="14" height="17" rx="2" /><path d="M9 4V3h6v1" /><path d="m9 13 2 2 4-4" /></>,
  wallet: <><path d="M4 7h15a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a2 2 0 0 1 2-2h11" /><path d="M16 13.5h2" /></>,
  globe: <><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3c2.5 2.7 2.5 15.3 0 18M12 3c-2.5 2.7-2.5 15.3 0 18" /></>,
  listChecks: <><path d="m3 6 1.5 1.5L7 5M3 12l1.5 1.5L7 11M3 18l1.5 1.5L7 17" /><path d="M10 6h11M10 12h11M10 18h11" /></>,
  fingerprint: <><path d="M6.5 6.5A7.5 7.5 0 0 1 19.5 12v1" /><path d="M4.5 10a7.5 7.5 0 0 0-.3 3.5" /><path d="M8 13a4 4 0 0 1 8 0c0 3-.6 5.6-1.6 7.5" /><path d="M12 13c0 3.2-.7 6-2 8M8.3 17.5c-.4 1.3-1 2.4-1.8 3.3" /></>,
  siren: <><path d="M7 18v-6a5 5 0 0 1 10 0v6" /><path d="M5 18h14v3H5z" /><path d="M12 3v2M4.2 6.2l1.4 1.4M19.8 6.2l-1.4 1.4" /></>,
  scale: <><path d="M12 3v18M7 21h10M5 7h14" /><path d="m5 7-3 7a3 3 0 0 0 6 0L5 7ZM19 7l-3 7a3 3 0 0 0 6 0l-3-7Z" /></>,
};

export function NavIcon({ name, size = 18 }: { name: NavIconName; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      {PATHS[name]}
    </svg>
  );
}
