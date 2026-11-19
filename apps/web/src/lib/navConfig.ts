// ──────────────────────────────────────────────────────────────
// Navigation — single source for the top bar and the drawer.
// Pure data (no hooks, no "use client"), unit-tested in apps/api/test/navConfig.test.ts.
//
// Groups follow the scope a page works on: Azure resources, network (VNet and Pod
// layers side by side), cluster, monitoring, security, cost. No product name in a category (2026-11-19 — an integrated
// platform: "클러스터" and "모니터링", not "AKS …"). Monitoring = one item per view (it was one page with seven tabs:
// 2 clicks to every view but the first, no URL per view, a duplicate of 네트워크 › Pod 트래픽) in three sections — the
// cluster's state, the applications, logs and collection (Datadog: Infrastructure · APM · Logs).
// A group with one item renders as a direct link; two or more render as a dropdown.
// Security is ordered by the question a person comes with (Wiz: Issues first, then domains) — what to fix first
// (overview, issues) · vulnerabilities · configuration and exposure (cloud CSPM, cluster KSPM) · identity and threats ·
// audit (compliance). Each domain shows Azure and the cluster side by side; where the data comes from is not a menu
// level. Settings (Azure connections) close the bar. Items may carry a `section` (i18n key) shown as a heading.
// ──────────────────────────────────────────────────────────────

export type NavIcon =
  | "home" | "cloud" | "waypoints" | "helm" | "lock" | "coins"
  | "dashboard" | "heartPulse" | "activity" | "sitemap" | "arrows" | "share"
  | "boxes" | "gauge" | "shieldCheck" | "clipboardCheck" | "wallet" | "globe"
  | "listChecks" | "fingerprint" | "siren" | "scale" | "radar" | "settings" | "plug" | "key" | "megaphone" | "bell" | "inbox" | "book" | "graph"
  | "server" | "flame" | "scroll" | "pipeline" | "monitor" | "triangle" | "nodes"
  | "pulse" | "route" | "waterfall" | "link" | "bug" | "rocket" | "target" | "sliders";

export type NavItem = { href: string; labelKey: string; descKey: string; icon: NavIcon; section?: string };
export type NavGroup = { key: string; labelKey: string; icon: NavIcon; items: NavItem[] };

const item = (href: string, key: string, icon: NavIcon, section?: string): NavItem => ({
  href, labelKey: `nav.item.${key}`, descKey: `nav.desc.${key}`, icon, ...(section ? { section } : {}),
});

export const NAV_GROUPS: NavGroup[] = [
  { key: "overview", labelKey: "nav.group.overview", icon: "home", items: [item("/", "overview", "dashboard")] },
  {
    // 2026-11-19: three levels — top category › category (a section, folds) › screen. 인프라 = what runs: the Azure
    // resources (widest scope first: whole subscription → one VNet live → per-resource health), the network, the cluster
    key: "infra", labelKey: "nav.group.infra", icon: "cloud", items: [
      item("/architecture", "architecture", "sitemap", "nav.group.azure"),
      item("/live-diagram", "liveDiagram", "activity", "nav.group.azure"),
      item("/health", "health", "heartPulse", "nav.group.azure"),
      item("/network", "vnetTraffic", "arrows", "nav.group.network"),
      item("/hubble", "podTraffic", "share", "nav.group.network"),
      item("/network-path", "networkPath", "globe", "nav.group.network"),
      item("/kubernetes", "aksClusters", "boxes", "nav.group.kubernetes"),
    ],
  },
  {
    key: "monitoring", labelKey: "nav.group.monitoring", icon: "monitor", items: [
      item("/observability", "aksMonitoring", "gauge", "nav.section.monState"),
      item("/observability/signals", "monSignals", "triangle", "nav.section.monState"),
      item("/observability/nodes", "monNodes", "server", "nav.section.monState"),
      // the APM views (2026-11-19 — were a row of buttons inside one page)
      item("/observability/services", "monServices", "nodes", "nav.section.monApp"),
      item("/observability/services/red", "apmRed", "pulse", "nav.section.monApp"),
      item("/observability/services/endpoints", "apmEndpoints", "route", "nav.section.monApp"),
      item("/observability/services/traces", "apmTraces", "waterfall", "nav.section.monApp"),
      item("/observability/services/deps", "apmDeps", "link", "nav.section.monApp"),
      item("/observability/services/errors", "apmErrors", "bug", "nav.section.monApp"),
      item("/observability/services/rollouts", "apmRollouts", "rocket", "nav.section.monApp"),
      item("/observability/services/slo", "apmSlo", "target", "nav.section.monApp"),
      item("/observability/profiles", "monProfiles", "flame", "nav.section.monApp"),
      item("/observability/logs", "monLogs", "scroll", "nav.section.monData"),
      item("/observability/collection", "monCollection", "pipeline", "nav.section.monData"),
    ],
  },
  {
    key: "security", labelKey: "nav.group.security", icon: "lock", items: [
      // By the question a person comes with (Wiz: Issues → domains), not by where the data comes from — 2026-11-17.
      // Each domain holds the Azure and the cluster view side by side.
      item("/security", "securityOverview", "shieldCheck", "nav.section.secPriority"),
      item("/security/risk", "securityRisk", "radar", "nav.section.secPriority"),
      // Wiz's Security Graph: ask the graph with conditions — before, a tab inside AKS 보안 점검 (security-roadmap 5.3 ①)
      item("/security/explore", "securityExplore", "graph", "nav.section.secPriority"),
      item("/security/advisories", "securityAdvisories", "megaphone", "nav.section.secVulns"),
      item("/security/findings", "securityFindings", "listChecks", "nav.section.secPosture"),
      item("/policies", "clusterSecurity", "clipboardCheck", "nav.section.secPosture"),
      item("/security/identity", "securityIdentity", "fingerprint", "nav.section.secAccess"),
      item("/security/threats", "securityThreats", "siren", "nav.section.secAccess"),
      item("/security/compliance", "securityCompliance", "scale", "nav.section.secAudit"),
    ],
  },
  // 운영 = running it: the cost, and the alerts received from Azure Monitor and Grafana (the dashboard is the receiver — no
  // messenger webhook needed) with what the team learned answering them (cases · runbooks — docs/architecture/ops-knowledge.md)
  {
    key: "ops", labelKey: "nav.group.ops", icon: "coins", items: [
      item("/cost", "costManagement", "wallet", "nav.group.cost"),
      item("/notifications", "notifications", "bell", "nav.group.notify"),
      item("/runbooks", "runbooks", "book", "nav.group.notify"),
    ],
  },
  // How the platform reaches Azure (connections, permission check) — last, like other platforms' settings
  { key: "settings", labelKey: "nav.group.settings", icon: "settings", items: [
    item("/settings/connections", "connections", "plug"),
    // Which feature needs which minimum read permission, by package (featureCatalog) — static, shareable
    item("/settings/features", "features", "key"),
    // 2026-11-19: a person's own view — directories · subscription filter, theme · menu · density, language (per browser)
    item("/settings/preferences", "preferences", "sliders"),
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
  "/observability/signals": ["cluster"],
  "/observability/nodes": ["cluster"],
  "/observability/services": ["cluster"],
  "/observability/services/red": ["cluster"],
  "/observability/services/endpoints": ["cluster"],
  "/observability/services/traces": ["cluster"],
  "/observability/services/deps": ["cluster"],
  "/observability/services/errors": ["cluster"],
  "/observability/services/rollouts": ["cluster"],
  "/observability/services/slo": ["cluster"],
  "/observability/profiles": ["cluster"],
  "/observability/logs": ["cluster"],
  "/observability/collection": ["cluster"],
  "/security/risk": ["subscription"],
  "/security/explore": ["cluster"],
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

/** The URL parameters that make one time range for a family of views (useTimeRange) */
const TIME_PARAMS = ["range", "to", "refresh"] as const;
/** Views that share one time range: the monitoring views (one frame — ObservabilityView) */
const TIME_FAMILY = "/observability";
const inFamily = (p: string) => p === TIME_FAMILY || p.startsWith(`${TIME_FAMILY}/`);

/**
 * Pure: where a menu link goes from the current page — between two monitoring views the time range comes along
 * (`?range · to · refresh`); anywhere else the plain href (other pages keep their own range, or none).
 */
export function navHref(href: string, pathname: string, search: string): string {
  if (!inFamily(href) || !inFamily(pathname)) return href;
  const from = new URLSearchParams(search);
  const keep = new URLSearchParams();
  for (const k of TIME_PARAMS) { const v = from.get(k); if (v) keep.set(k, v); }
  const q = keep.toString();
  return q ? `${href}?${q}` : href;
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

/** localStorage key: the groups and sections the viewer folded (JSON array of `group` / `group:section` keys) */
export const NAV_COLLAPSE_KEY = "aud.nav.collapsed";

/** A group's sections in order (contiguous items sharing a section); a group without sections = one unnamed section */
export type NavSection = { key: string; labelKey: string | null; items: NavItem[] };
export function sectionsOf(g: NavGroup): NavSection[] {
  const out: NavSection[] = [];
  for (const it of g.items) {
    const last = out[out.length - 1];
    if (last && last.labelKey === (it.section ?? null)) last.items.push(it);
    else out.push({ key: it.section ? `${g.key}:${it.section}` : g.key, labelKey: it.section ?? null, items: [it] });
  }
  return out;
}
/** Every foldable key: the headed groups and their named sections */
export function foldableKeys(): string[] {
  return NAV_GROUPS.filter(isCollapsible).flatMap((g) => [g.key, ...sectionsOf(g).filter((s) => s.labelKey).map((s) => s.key)]);
}

/** Groups with a heading fold; 개요 (one link, no heading) does not */
export function isCollapsible(g: NavGroup): boolean {
  return g.key !== "overview";
}

/** Pure: the folded groups from storage — only keys of foldable groups, anything unreadable = none folded */
export function parseCollapsed(raw: string | null): Set<string> {
  if (!raw) return new Set();
  try {
    const v: unknown = JSON.parse(raw);
    const known = new Set(foldableKeys());
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
  return visibleItems(g.items, folded, pathname);
}
/** Pure: the links a group or a section lists — all, or folded: the current page's only */
export function visibleItems(items: NavItem[], folded: boolean, pathname: string): NavItem[] {
  if (!folded) return items;
  const active = activeNavItem(pathname)?.href;
  return items.filter((it) => it.href === active);
}
