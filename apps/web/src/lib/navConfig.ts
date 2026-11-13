// ──────────────────────────────────────────────────────────────
// Navigation — single source for the top bar and the drawer.
// Pure data (no hooks, no "use client"), unit-tested in apps/api/test/navConfig.test.ts.
//
// Groups follow the scope a page works on: Azure resources, network (VNet and Pod
// layers side by side), Kubernetes, security, cost.
// A group with one item renders as a direct link; two or more render as a dropdown.
// Security follows the Wiz/CNAPP axes that have data: posture overview, findings (CSPM),
// identity (CIEM), threats, compliance — and cluster security (KSPM). Settings (Azure connections) close the bar. The integrated view that joins
// Azure and cluster evidence comes first, under its own section. Items may carry a
// `section` (i18n key) that is shown as a heading where the section changes.
// ──────────────────────────────────────────────────────────────

export type NavIcon =
  | "home" | "cloud" | "waypoints" | "helm" | "lock" | "coins"
  | "dashboard" | "heartPulse" | "activity" | "sitemap" | "arrows" | "share"
  | "boxes" | "gauge" | "shieldCheck" | "clipboardCheck" | "wallet" | "globe"
  | "listChecks" | "fingerprint" | "siren" | "scale" | "radar" | "settings" | "plug" | "key" | "megaphone" | "bell" | "inbox" | "book";

export type NavItem = { href: string; labelKey: string; descKey: string; icon: NavIcon; section?: string };
export type NavGroup = { key: string; labelKey: string; icon: NavIcon; items: NavItem[] };

const item = (href: string, key: string, icon: NavIcon, section?: string): NavItem => ({
  href, labelKey: `nav.item.${key}`, descKey: `nav.desc.${key}`, icon, ...(section ? { section } : {}),
});

export const NAV_GROUPS: NavGroup[] = [
  { key: "overview", labelKey: "nav.group.overview", icon: "home", items: [item("/", "overview", "dashboard")] },
  {
    key: "azure", labelKey: "nav.group.azure", icon: "cloud", items: [
      // Widest scope first: whole subscription → one VNet live → per-resource health
      item("/architecture", "architecture", "sitemap"),
      item("/live-diagram", "liveDiagram", "activity"),
      item("/health", "health", "heartPulse"),
    ],
  },
  {
    key: "network", labelKey: "nav.group.network", icon: "waypoints", items: [
      item("/network", "vnetTraffic", "arrows"),
      item("/hubble", "podTraffic", "share"),
    ],
  },
  {
    key: "kubernetes", labelKey: "nav.group.kubernetes", icon: "helm", items: [
      item("/kubernetes", "aksClusters", "boxes"),
      item("/observability", "aksMonitoring", "gauge"),
    ],
  },
  {
    key: "security", labelKey: "nav.group.security", icon: "lock", items: [
      item("/security/risk", "securityRisk", "radar", "nav.section.crossRisk"),
      // Urgent vulnerability news (CISA KEV · NVD · Node.js · PHP) checked against this platform's runtime, images and Defender
      item("/security/advisories", "securityAdvisories", "megaphone", "nav.section.crossRisk"),
      item("/security", "securityOverview", "shieldCheck", "nav.section.azureSecurity"),
      item("/security/findings", "securityFindings", "listChecks", "nav.section.azureSecurity"),
      item("/security/identity", "securityIdentity", "fingerprint", "nav.section.azureSecurity"),
      item("/security/threats", "securityThreats", "siren", "nav.section.azureSecurity"),
      item("/security/compliance", "securityCompliance", "scale", "nav.section.azureSecurity"),
      item("/policies", "clusterSecurity", "clipboardCheck", "nav.section.clusterSecurity"),
    ],
  },
  { key: "cost", labelKey: "nav.group.cost", icon: "coins", items: [item("/cost", "costManagement", "wallet")] },
  // Alerts received from Azure Monitor and Grafana (the dashboard is the receiver — no messenger webhook needed)
  // …and what the team learned answering them: cases (how it was fixed) and runbooks (what to do) — docs/architecture/ops-knowledge.md
  { key: "notify", labelKey: "nav.group.notify", icon: "inbox", items: [item("/notifications", "notifications", "bell"), item("/runbooks", "runbooks", "book")] },
  // How the platform reaches Azure (connections, permission check) — last, like other platforms' settings
  { key: "settings", labelKey: "nav.group.settings", icon: "settings", items: [
    item("/settings/connections", "connections", "plug"),
    // Which feature needs which minimum read permission, by package (featureCatalog) — static, shareable
    item("/settings/features", "features", "key"),
  ] },
];

/**
 * What a screen is looked at through — the scope bar at the top of the page (components/ScopeBar) shows these, and the
 * screen reads the shared choice (lib/scopeStore). Screens not listed have no scope bar (they choose inside, or need none).
 */
export const PAGE_SCOPE: Record<string, ReadonlyArray<"subscription" | "cluster">> = {
  "/architecture": ["subscription"],
  "/health": ["subscription"],
  "/network": ["subscription"],
  "/hubble": ["cluster"],
  "/kubernetes": ["cluster"],
  "/observability": ["cluster"],
  "/security/risk": ["subscription"],
  "/security/advisories": ["cluster"],
  "/security": ["subscription"],
  "/security/findings": ["subscription"],
  "/security/identity": ["subscription"],
  "/security/threats": ["subscription"],
  "/security/compliance": ["subscription"],
  "/policies": ["cluster"],
  "/cost": ["subscription"],
};

/** Pages outside the menu (and outside the app frame): the sign-in page */
export const NAV_EXEMPT_ROUTES = ["/login"] as const;

/** "/" matches only itself; any other href matches itself and its sub-paths. */
function matches(pathname: string, href: string): boolean {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
}

const ALL_ITEMS = NAV_GROUPS.flatMap((g) => g.items.map((item) => ({ item, group: g.key })));

/** The single menu item for `pathname` — the longest matching href wins (/security/x beats /security). */
export function activeNavItem(pathname: string): NavItem | null {
  let best: NavItem | null = null;
  for (const { item } of ALL_ITEMS) {
    if (matches(pathname, item.href) && (!best || item.href.length > best.href.length)) best = item;
  }
  return best;
}

export function isItemActive(pathname: string, href: string): boolean {
  return activeNavItem(pathname)?.href === href;
}

/** Section heading to show before item `i` of a group (when the section changes), else null. */
export function sectionBefore(items: NavItem[], i: number): string | null {
  const s = items[i]?.section;
  return s && s !== items[i - 1]?.section ? s : null;
}

export function activeGroupKey(pathname: string): string | null {
  const href = activeNavItem(pathname)?.href;
  return href ? ALL_ITEMS.find((x) => x.item.href === href)!.group : null;
}

// ── Folding the menu's groups (this browser only) ──

/** localStorage key: the group keys the viewer folded (JSON array) */
export const NAV_COLLAPSE_KEY = "aud.nav.collapsed";

/** Groups with a heading fold; 개요 (one link, no heading) does not */
export function isCollapsible(g: NavGroup): boolean {
  return g.key !== "overview";
}

/** Pure: the folded groups from storage — only keys of foldable groups, anything unreadable = none folded */
export function parseCollapsed(raw: string | null): Set<string> {
  if (!raw) return new Set();
  try {
    const v: unknown = JSON.parse(raw);
    const known = new Set(NAV_GROUPS.filter(isCollapsible).map((g) => g.key));
    return new Set(Array.isArray(v) ? v.filter((k): k is string => typeof k === "string" && known.has(k)) : []);
  } catch {
    return new Set();
  }
}

/**
 * Pure: the links a group shows — all when open; folded, only the current page's link (the menu always says where
 * you are) or none
 */
export function shownItems(g: NavGroup, folded: boolean, pathname: string): NavItem[] {
  if (!folded) return g.items;
  const active = activeNavItem(pathname)?.href;
  return g.items.filter((it) => it.href === active);
}
