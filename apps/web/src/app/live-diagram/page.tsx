"use client";

import "reactflow/dist/style.css";

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import Link from "next/link";
import type { LiveAlert, AzureSubscriptionOption, AzureSubscriptionsResponse, AzureConnectionOption, AzureConnectionsResponse, DiagramSpec, LiveDiagramSnapshot, EdgeNetworkDetail, AksNodeCondition, PrivateLinkUsageResponse } from "@aud/types";
import { useApiQuery } from "@/lib/useApiQuery";
import { apiBaseUrl, apiUrl, authStateOf, fetchJsonWithBearer } from "@/lib/api";
import { useApiToken } from "@/lib/useApiToken";
import { dateLocale, useI18n } from "@/lib/i18n";
import { DEFAULT_EDGE_LAYERS, EDGE_LAYERS, edgeLayer, isInferredEdge, scopeCoverage, scopeImpacts, scopeSpec, type EdgeLayer } from "@/lib/liveScope";
import { useDiagramSpec } from "./hooks/useDiagramSpec";
import { useLiveSnapshot, type UpdateMode } from "./hooks/useLiveSnapshot";
import { LiveCanvas } from "./components/LiveCanvas";
import { AlertSidebar } from "./components/AlertSidebar";
import { ResourceDetailPanel } from "./components/ResourceDetailPanel";
import { EdgeDetailPanel } from "./components/EdgeDetailPanel";
import { formatAzureRegion } from "./utils/regionFormat";
import { LIVE_EDGE_LOOK, liveStroke, type LiveEdgeStyleKey } from "@/lib/liveStyle";
import { peeringPairOf, siteOfEdge } from "@/lib/livePeering";
import styles from "./styles.module.css";
import { Button, EmptyState, Notice, PageHeader, Select, Toggle } from "@/components/ui";

/** Built-in example diagram (sample resources and values) */
const SAMPLE_DIAGRAM_ID = "prod-infra";
/** Hover focus on/off, remembered per browser */
const FOCUS_KEY = "aud.liveDiagram.hoverFocus";
/** Last diagram generated from Azure, restored on the next visit */
const LAST_DIAGRAM_KEY = "aud.liveDiagram.last";

// ── Multi-select dropdown (Region / VNet filter) ──
type MultiSelectDropdownProps = {
  label: string;
  allLabel: string;
  options: { id: string; label: string; badge?: string }[];
  selected: Set<string>;
  onChange: (next: Set<string>) => void;
  disabled?: boolean;
  searchable?: boolean;
};

function MultiSelectDropdown({ label, allLabel, options, selected, onChange, disabled, searchable }: MultiSelectDropdownProps) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const wrapRef = useRef<HTMLDivElement>(null);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const toggle = useCallback((id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onChange(next);
  }, [selected, onChange]);

  const btnLabel = selected.size === 0
    ? allLabel
    : selected.size === 1
      ? (options.find((o) => selected.has(o.id))?.label ?? `1 ${label}`)
      : `${selected.size} ${label}`;

  const visibleOptions = searchable && search
    ? options.filter((o) => o.label.toLowerCase().includes(search.toLowerCase()))
    : options;

  return (
    <div style={{ position: "relative" }} ref={wrapRef}>
      <button
        type="button"
        className={styles.multiSelectBtn}
        aria-expanded={open}
        onClick={() => !disabled && setOpen((v) => !v)}
        disabled={disabled}
      >
        <span className={styles.multiSelectBtnLabel}>{btnLabel}</span>
        {selected.size > 0 && (
          <span className={styles.multiSelectBtnCount}>{selected.size}</span>
        )}
        <span style={{ opacity: 0.5, fontSize: 10, flexShrink: 0 }}>{open ? "▲" : "▼"}</span>
      </button>
      {open && (
        <div className={styles.multiSelectDropdown}>
          {searchable && (
            <input
              type="text"
              className={styles.multiSelectSearch}
              placeholder={t("ld.searchIn", { label })}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onClick={(e) => e.stopPropagation()}
              autoFocus
            />
          )}
          {visibleOptions.map((opt) => (
            <label key={opt.id} className={styles.multiSelectOption}>
              <input
                type="checkbox"
                checked={selected.has(opt.id)}
                onChange={() => toggle(opt.id)}
              />
              <span className={styles.multiSelectOptionLabel}>{opt.label}</span>
              {opt.badge && <span className={styles.multiSelectOptionBadge}>{opt.badge}</span>}
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

// ── "연결선 ▾" layer menu: one checkbox per edge layer, with its count and a line swatch ──

/** Line style shown as the swatch of each layer (the canvas and legend use the same table) */
const LAYER_SWATCH: Record<EdgeLayer, LiveEdgeStyleKey> = {
  config: "config",
  privateLink: "privateLink",
  privateLinkUsage: "privateLinkUsage",
  ingress: "ingress",
  egress: "egress",
  hybrid: "hybrid",
  peering: "peering",
  publicIp: "publicIp",
  inferred: "inferred",
};

function LayerMenu({ layers, counts, onChange }: { layers: ReadonlySet<EdgeLayer>; counts: Record<EdgeLayer, number>; onChange: (next: Set<EdgeLayer>) => void }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const shown = EDGE_LAYERS.filter((l) => layers.has(l)).reduce((n, l) => n + counts[l], 0);
  const total = EDGE_LAYERS.reduce((n, l) => n + counts[l], 0);

  return (
    <div style={{ position: "relative" }} ref={wrapRef}>
      <button type="button" className={styles.multiSelectBtn} aria-expanded={open} onClick={() => setOpen((v) => !v)} data-testid="layer-menu">
        <span className={styles.multiSelectBtnLabel}>{t("ld.layer.menu")}</span>
        <span className={styles.multiSelectBtnCount}>{shown}/{total}</span>
        <span style={{ opacity: 0.5, fontSize: 10, flexShrink: 0 }}>{open ? "▲" : "▼"}</span>
      </button>
      {open && (
        <div className={styles.multiSelectDropdown}>
          {EDGE_LAYERS.map((layer) => {
            const look = LIVE_EDGE_LOOK[LAYER_SWATCH[layer]];
            return (
              <label key={layer} className={styles.multiSelectOption} title={t(`ld.layer.${layer}.hint`)} data-layer={layer}>
                <input
                  type="checkbox"
                  checked={layers.has(layer)}
                  onChange={() => {
                    const next = new Set(layers);
                    if (next.has(layer)) next.delete(layer);
                    else next.add(layer);
                    onChange(next);
                  }}
                />
                <svg width={22} height={8} aria-hidden="true" className={styles.layerSwatch}>
                  <line x1={1} y1={4} x2={21} y2={4} stroke={liveStroke(LAYER_SWATCH[layer])} strokeWidth={Math.min(look.width + 0.4, 2.4)} strokeDasharray={look.dash} />
                </svg>
                <span className={styles.multiSelectOptionLabel}>{t(`ld.layer.${layer}`)}</span>
                <span className={styles.multiSelectOptionBadge}>{counts[layer]}</span>
              </label>
            );
          })}
        </div>
      )}
    </div>
  );
}

function buildConnectedEdges(
  spec: DiagramSpec,
  snapshot: LiveDiagramSnapshot | null,
  nodeId: string,
) {
  const result: Array<{
    edgeSpec: DiagramSpec["edges"][number];
    liveEdge?: LiveDiagramSnapshot["edges"][number];
    peerLabel: string;
    direction: "inbound" | "outbound";
  }> = [];

  for (const edge of spec.edges) {
    if (edge.source !== nodeId && edge.target !== nodeId) continue;
    const isOutbound = edge.source === nodeId;
    const peerId = isOutbound ? edge.target : edge.source;
    const peerNode = spec.nodes.find((n) => n.id === peerId);
    const liveEdge = snapshot?.edges.find((e) => e.id === edge.id);
    result.push({
      edgeSpec: edge,
      liveEdge,
      peerLabel: peerNode?.label ?? peerId,
      direction: isOutbound ? "outbound" : "inbound",
    });
  }

  return result;
}

function readLastDiagram(): string {
  try {
    return window.localStorage.getItem(LAST_DIAGRAM_KEY) ?? "";
  } catch {
    return "";
  }
}

function writeLastDiagram(id: string | null) {
  try {
    if (id) window.localStorage.setItem(LAST_DIAGRAM_KEY, id);
    else window.localStorage.removeItem(LAST_DIAGRAM_KEY);
  } catch {
    /* storage unavailable — the page still works, it just starts empty next time */
  }
}

export default function LiveDiagramPage() {
  const { t, locale } = useI18n();
  const getApiToken = useApiToken();
  // "" until the user generates a diagram (or the last generated one is restored) — never sample data by default
  const [diagramId, setDiagramId] = useState("");
  const [mode, setMode] = useState<UpdateMode>("polling");
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [edgeDetail, setEdgeDetail] = useState<EdgeNetworkDetail | null>(null);
  const [edgeDetailLoading, setEdgeDetailLoading] = useState(false);

  const [selectedVmssInstance, setSelectedVmssInstance] = useState<{
    computerName: string; powerState: string; provisioningState?: string; privateIp?: string; nodePoolName?: string; nodeImageVersion?: string; conditions?: AksNodeCondition[]; parentVmssId: string; label: string;
  } | null>(null);

  useEffect(() => {
    const last = readLastDiagram();
    if (last) setDiagramId(last);
  }, []);

  const [focusPeeringKey, setFocusPeeringKey] = useState<string | null | undefined>(undefined);
  // WAF: the cards whose policy sub-cards are open, and the WAF panel in view (key null = overview)
  const [wafOpen, setWafOpen] = useState<ReadonlySet<string>>(() => new Set());
  const [selectedWaf, setSelectedWaf] = useState<{ nodeId: string; key: string | null } | null>(null);
  const handleNodeSelect = useCallback((nodeId: string | null) => {
    setSelectedNodeId(nodeId);
    setSelectedVmssInstance(null);
    setSelectedWaf(null);
    setFocusPeeringKey(undefined);
    if (nodeId) setSelectedEdgeId(null);
  }, []);
  const handleWafSelect = useCallback((nodeId: string, key: string | null) => {
    setSelectedWaf({ nodeId, key });
    setWafOpen((prev) => (prev.has(nodeId) ? prev : new Set([...prev, nodeId])));
    setSelectedNodeId(null);
    setSelectedVmssInstance(null);
    setSelectedEdgeId(null);
  }, []);
  // The badge: opening shows the sub-cards and the WAF overview; closing leaves the panel as it is
  const wafOpenRef = useRef(wafOpen);
  wafOpenRef.current = wafOpen;
  const handleWafToggle = useCallback((nodeId: string) => {
    if (wafOpenRef.current.has(nodeId)) {
      setWafOpen((prev) => { const next = new Set(prev); next.delete(nodeId); return next; });
      return;
    }
    setWafOpen((prev) => new Set([...prev, nodeId]));
    setSelectedWaf({ nodeId, key: null });
    setSelectedNodeId(null);
    setSelectedVmssInstance(null);
    setSelectedEdgeId(null);
  }, []);

  // A peering chip on a VNet header: open the VNet's panel with that peering expanded (null = the list)
  const handlePeeringSelect = useCallback((vnetId: string, key: string | null) => {
    setSelectedNodeId(vnetId);
    setSelectedVmssInstance(null);
    setSelectedWaf(null);
    setSelectedEdgeId(null);
    setFocusPeeringKey(key);
  }, []);

  const handleVmssInstanceSelect = useCallback((data: { computerName: string; powerState: string; provisioningState?: string; privateIp?: string; nodePoolName?: string; nodeImageVersion?: string; conditions?: AksNodeCondition[]; parentVmssId: string; label: string }) => {
    setSelectedVmssInstance(data);
    setSelectedNodeId(null);
    setSelectedEdgeId(null);
    setSelectedWaf(null);
  }, []);

  const handleEdgeSelect = useCallback((edgeId: string | null) => {
    setSelectedEdgeId(edgeId);
    if (edgeId) { setSelectedNodeId(null); setSelectedWaf(null); }
  }, []);

  // Toolbar: edge layers, measured traffic, fault impact
  const [layers, setLayers] = useState<Set<EdgeLayer>>(() => new Set(DEFAULT_EDGE_LAYERS));
  const [trafficOn, setTrafficOn] = useState(false);
  const [impactOn, setImpactOn] = useState(true);
  // Hover focus (dim what is not linked) — remembered per browser; off keeps the whole picture visible
  const [hoverFocus, setHoverFocusState] = useState(true);
  useEffect(() => {
    try {
      if (window.localStorage.getItem(FOCUS_KEY) === "0") setHoverFocusState(false);
    } catch { /* storage unavailable — default on */ }
  }, []);
  const setHoverFocus = useCallback((on: boolean) => {
    setHoverFocusState(on);
    try { window.localStorage.setItem(FOCUS_KEY, on ? "1" : "0"); } catch { /* not remembered */ }
  }, []);

  // Connection & Subscription context (a connection = one customer tenant the platform reads)
  const [tenants, setTenants] = useState<AzureConnectionOption[]>([]);
  const [tenantId, setTenantId] = useState("");
  const [subscriptions, setSubscriptions] = useState<AzureSubscriptionOption[]>([]);
  const [subscriptionId, setSubscriptionId] = useState("");
  const [generating, setGenerating] = useState(false);
  const [generateError, setGenerateError] = useState<string | null>(null);

  // VNet / Region filter state (multi-select)
  const [selectedVnets, setSelectedVnets] = useState<Set<string>>(new Set());
  const [selectedRegions, setSelectedRegions] = useState<Set<string>>(new Set());

  // Resource search
  const [searchQuery, setSearchQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [focusNodeId, setFocusNodeId] = useState<string | null>(null);
  const searchRef = useRef<HTMLDivElement>(null);

  // Fetch connections on mount
  useEffect(() => {
    let cancelled = false;
    getApiToken()
      .catch(() => null)
      .then((token) =>
        fetchJsonWithBearer<AzureConnectionsResponse>(
          `${apiBaseUrl()}/api/azure/connections`,
          token,
        ),
      )
      .then((resp) => {
        if (cancelled) return;
        const list = resp.connections ?? [];
        setTenants(list);
        setTenantId((prev) => prev || list[0]?.key || "");
      })
      .catch(() => {
        if (cancelled) return;
        setTenants([]);
      });
    return () => { cancelled = true; };
  }, [getApiToken]);

  // Fetch subscriptions (re-fetch when tenantId changes)
  useEffect(() => {
    let cancelled = false;
    getApiToken()
      .catch(() => null)
      .then((token) =>
        fetchJsonWithBearer<AzureSubscriptionsResponse>(
          // The subscriptions of the chosen connection (registry key)
          apiUrl("/api/azure/subscriptions", { connection: tenantId || undefined }),
          token,
        ),
      )
      .then((resp) => {
        if (cancelled) return;
        const subs = resp.subscriptions ?? [];
        setSubscriptions(subs);
        // keep the choice only if it belongs to the chosen tenant
        setSubscriptionId((prev) => (subs.some((s) => s.subscriptionId === prev) ? prev : subs[0]?.subscriptionId || ""));
      })
      .catch(() => {
        if (cancelled) return;
        setSubscriptions([]);
      });
    return () => { cancelled = true; };
  }, [getApiToken, tenantId]);

  const handleGenerate = useCallback(async () => {
    setGenerating(true);
    setGenerateError(null);
    try {
      const token = await getApiToken().catch(() => null);
      const resp = await fetchJsonWithBearer<{ ok: boolean; diagram: DiagramSpec; _source?: string }>(
        `${apiBaseUrl()}/api/live/diagrams/generate`,
        token,
        {
          method: "POST",
          body: JSON.stringify(subscriptionId ? { subscriptionId } : {}),
        },
      );
      if (resp.ok && resp.diagram?.id) {
        setDiagramId(resp.diagram.id);
        writeLastDiagram(resp.diagram.id);
      }
    } catch (e: unknown) {
      const auth = authStateOf(e);
      setGenerateError(auth ? t(`auth.state.${auth}`) : e instanceof Error ? e.message : "Generation failed");
    } finally {
      setGenerating(false);
    }
  }, [getApiToken, subscriptionId, t]);

  const { spec, error: specError, loading: specLoading } = useDiagramSpec(diagramId);
  const { snapshot, error: snapError, connected, refresh } = useLiveSnapshot(diagramId, mode);

  // A restored diagram the API no longer holds (it keeps generated diagrams in memory) → back to the empty state
  useEffect(() => {
    if (specError && diagramId && diagramId !== SAMPLE_DIAGRAM_ID && /404|not found/i.test(specError)) {
      writeLastDiagram(null);
      setDiagramId("");
    }
  }, [specError, diagramId]);

  const isSample = diagramId === SAMPLE_DIAGRAM_ID || snapshot?.dataSource === "mock";

  // ── VNet / Region option extraction ──
  const vnetOptions = useMemo(() => {
    if (!spec) return [];
    return spec.nodes
      .filter((n) => n.nodeType === "group" && n.icon === "vnet")
      .map((n) => ({
        id: n.id,
        label: n.label,
        badge: n.location ? formatAzureRegion(n.location) : undefined,
      }));
  }, [spec]);

  const regionOptions = useMemo(() => {
    if (!spec) return [];
    return [...new Set(spec.nodes.map((n) => n.location).filter(Boolean))] as string[];
  }, [spec]);

  // ── Auto-select primary VNet on new spec load ──
  // Fires when spec object reference changes (new Generate), not on filter changes.
  // Picks the VNet with the most descendant nodes for the best initial focused view.
  useEffect(() => {
    if (!spec) return;
    const vnets = spec.nodes.filter((n) => n.nodeType === "group" && n.icon === "vnet");
    if (vnets.length === 0) return;

    // Count all descendants per VNet (walk parentId chain up to root)
    const vnetDescendantCount = new Map<string, number>(vnets.map((v) => [v.id, 0]));
    for (const node of spec.nodes) {
      if (!node.parentId) continue;
      // Walk up to find root VNet
      let cur = node;
      while (cur.parentId) {
        const parent = spec.nodes.find((p) => p.id === cur.parentId);
        if (!parent) break;
        cur = parent;
      }
      if (cur.nodeType === "group" && cur.icon === "vnet") {
        vnetDescendantCount.set(cur.id, (vnetDescendantCount.get(cur.id) ?? 0) + 1);
      }
    }

    // Select the VNet with the most resources (fall back to first)
    let primaryId = vnets[0]!.id;
    let maxCount = vnetDescendantCount.get(primaryId) ?? 0;
    for (const vnet of vnets) {
      const count = vnetDescendantCount.get(vnet.id) ?? 0;
      if (count > maxCount) { maxCount = count; primaryId = vnet.id; }
    }
    setSelectedVnets(new Set([primaryId]));

  }, [spec]); // Re-run only when spec object changes (new Generate)

  // ── Scope: selected VNets / regions, widened once along configured links (lib/liveScope) ──
  // Guessed links widen it only while the "추정 의존성" layer is on; the menu counts always include them.
  const showGuesses = layers.has("inferred");
  const scopeWithGuesses = useMemo(
    () => (spec ? scopeSpec(spec, selectedVnets, selectedRegions, { includeInferred: true }) : spec),
    [spec, selectedVnets, selectedRegions],
  );
  const scopeConfigured = useMemo(
    () => (spec ? scopeSpec(spec, selectedVnets, selectedRegions) : spec),
    [spec, selectedVnets, selectedRegions],
  );
  const filteredSpec = showGuesses ? scopeWithGuesses : scopeConfigured;

  // Reset selected node when filter changes (node may no longer be visible)
  useEffect(() => {
    if (selectedNodeId && filteredSpec) {
      const stillVisible = filteredSpec.nodes.some((n) => n.id === selectedNodeId);
      if (!stillVisible) setSelectedNodeId(null);
    }
  }, [filteredSpec, selectedNodeId]);

  // ── Resource search results (filter nodes by label match) ──
  const searchResults = useMemo(() => {
    if (!filteredSpec || searchQuery.length < 2) return [];
    const q = searchQuery.toLowerCase();
    return filteredSpec.nodes
      .filter((n) => n.nodeType !== "group" && n.label.toLowerCase().includes(q))
      .slice(0, 12);
  }, [filteredSpec, searchQuery]);

  // Close search dropdown on outside click
  useEffect(() => {
    if (!searchOpen) return;
    const handler = (e: MouseEvent) => {
      if (searchRef.current && !searchRef.current.contains(e.target as Node)) {
        setSearchOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [searchOpen]);

  const handleSearchSelect = useCallback((nodeId: string) => {
    setSearchOpen(false);
    setSearchQuery("");
    handleNodeSelect(nodeId);
    // Use a unique trigger to force focusNode effect even if same nodeId
    setFocusNodeId(nodeId + ":" + Date.now());
  }, [handleNodeSelect]);

  // Convert region options to id/label shape for MultiSelectDropdown
  const regionOptionsMapped = useMemo(
    () => regionOptions.map((r) => ({ id: r, label: r })),
    [regionOptions],
  );

  const handleAlertClick = useCallback((alert: LiveAlert) => {
    const nodeId = alert.affectedNodeIds[0];
    if (nodeId) handleNodeSelect(nodeId);
  }, [handleNodeSelect]);

  const error = specError || snapError;

  // ── Who uses each Private Endpoint (access / flow logs) — one VNet in view, when its layer is on or a panel is
  // open; refreshed every 5 min. The response is tagged with its VNet so a switch never shows another VNet's use.
  const vnetInView = useMemo(() => {
    const v = filteredSpec?.nodes.filter((n) => n.icon === "vnet" && n.nodeType === "group" && !n.metadata?.ghostOf) ?? [];
    return v.length === 1 ? v[0]!.id : null;
  }, [filteredSpec]);
  const [pluTick, setPluTick] = useState(0);
  useEffect(() => {
    const h = setInterval(() => setPluTick((n) => n + 1), 5 * 60_000);
    return () => clearInterval(h);
  }, []);
  const wantUsage = !!spec && !!vnetInView && (layers.has("privateLinkUsage") || !!selectedNodeId);
  const usageQuery = useApiQuery<{ vnet: string; data: PrivateLinkUsageResponse }>(
    wantUsage ? `plu|${spec!.id}|${vnetInView}|${pluTick}` : null,
    async (token) => ({ vnet: vnetInView!, data: await fetchJsonWithBearer<PrivateLinkUsageResponse>(apiUrl("/api/live/private-link-usage", { diagramId: spec!.id, vnet: vnetInView! }), token) }),
    { tokenOptional: true },
  );
  const usage = wantUsage && usageQuery.data?.vnet === vnetInView ? usageQuery.data.data : null;

  // ── What is in view: counts, coverage, impacts ──
  const visibleIds = useMemo(() => new Set(filteredSpec?.nodes.map((n) => n.id) ?? []), [filteredSpec]);
  const nodeLabelById = useMemo(() => new Map(spec?.nodes.map((n) => [n.id, n.label]) ?? []), [spec]);
  const nodeLabel = useCallback((id: string) => nodeLabelById.get(id) ?? id, [nodeLabelById]);
  const coverage = useMemo(() => (filteredSpec ? scopeCoverage(filteredSpec, snapshot) : null), [filteredSpec, snapshot]);
  const layerCounts = useMemo(() => {
    const counts = Object.fromEntries(EDGE_LAYERS.map((l) => [l, 0])) as Record<EdgeLayer, number>;
    if (!scopeConfigured || !scopeWithGuesses) return counts;
    const byId = new Map(scopeConfigured.nodes.map((n) => [n.id, n]));
    for (const e of scopeConfigured.edges) counts[edgeLayer(e, byId)]++;
    // Guesses reach nodes the configured view does not have — count them in the wider scope
    counts.inferred = scopeWithGuesses.edges.filter((e) => isInferredEdge(e)).length;
    counts.privateLinkUsage = usage?.usages.length ?? 0;
    return counts;
  }, [scopeConfigured, scopeWithGuesses, usage]);
  // One list for the toolbar count, the canvas and the panels (an impact outside this view never dims it)
  const visibleImpacts = useMemo(() => scopeImpacts(snapshot?.faultImpacts, visibleIds), [snapshot?.faultImpacts, visibleIds]);
  const shownImpacts = useMemo(() => (impactOn ? visibleImpacts : []), [impactOn, visibleImpacts]);
  const visibleAlerts = useMemo(
    () => (snapshot?.alerts ?? []).filter((a) => a.affectedNodeIds.length === 0 || a.affectedNodeIds.some((id) => visibleIds.has(id))),
    [snapshot?.alerts, visibleIds],
  );
  const resourceCount = filteredSpec?.nodes.filter((n) => n.nodeType !== "group").length ?? 0;
  const sources = snapshot?.coverage?.sources;
  const coverageTitle = sources
    ? [
        `${t("ld.coverage.metrics")}: ${t(`ld.coverage.state.${sources.metrics}`)}`,
        `${t("ld.coverage.traffic")}: ${t(`ld.coverage.state.${sources.traffic}`)}`,
        `${t("live.alerts")}: ${t(`ld.coverage.state.${sources.alerts}`)}`,
      ].join("\n")
    : undefined;
  const hasMeasuredTraffic = (coverage?.edgesWithTraffic ?? 0) > 0;

  // Build connected edges for the selected node's detail panel
  const connectedEdges = useMemo(() => {
    if (!selectedNodeId || !filteredSpec) return [];
    return buildConnectedEdges(filteredSpec, snapshot, selectedNodeId);
  }, [selectedNodeId, filteredSpec, snapshot]);

  // Edge detail fetch + 1-minute auto-refresh
  useEffect(() => {
    if (!selectedEdgeId || !filteredSpec) { setEdgeDetail(null); return; }
    // Peering and S2S lines are described from the diagram itself (EdgeDetailPanel peering/site) — no NSG/UDR/flows
    const kind = filteredSpec.edges.find((e) => e.id === selectedEdgeId)?.edgeKind;
    if (kind === "peering" || kind === "hybrid") { setEdgeDetail(null); setEdgeDetailLoading(false); return; }
    let cancelled = false;

    async function load() {
      setEdgeDetailLoading(true);
      try {
        const token = await getApiToken().catch(() => null);
        const data = await fetchJsonWithBearer<EdgeNetworkDetail>(
          apiUrl("/api/live/edge-detail", { diagramId, edgeId: selectedEdgeId }),
          token,
        );
        if (!cancelled) setEdgeDetail(data);
      } catch { /* ignore */ }
      finally { if (!cancelled) setEdgeDetailLoading(false); }
    }

    void load();
    const timer = setInterval(() => { void load(); }, 60_000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [selectedEdgeId, filteredSpec, diagramId, getApiToken]);

  return (
    <div className={styles.page}>
      <PageHeader
        meta={
          diagramId ? (
            <>
              <span className={styles.statusDot} style={{ background: connected ? "var(--success)" : "var(--danger)" }} aria-hidden="true" />
              <span>{connected ? t("live.connected") : t("live.disconnected")}</span>
              <span>· {spec ? spec.name : specLoading ? t("live.loading") : t("live.noDiagram")}</span>
              {snapshot ? <span>· {t("live.updated")} {new Date(snapshot.generatedAt).toLocaleTimeString(dateLocale(locale))}</span> : null}
              <span>· <Link href="/architecture">{t("live.scopeHint")}</Link></span>
            </>
          ) : (
            <span><Link href="/architecture">{t("live.scopeHint")}</Link></span>
          )
        }
        actions={
          <>
            <Select
              label={t("live.updateMode")}
              hideLabel
              value={mode}
              onChange={(v) => setMode(v as UpdateMode)}
              options={[{ value: "polling", label: t("live.polling") }, { value: "sse", label: t("live.sse") }]}
            />
            <Button onClick={refresh} disabled={!diagramId}>{t("live.refresh")}</Button>
          </>
        }
      />

      {/* Tenant & Subscription Selector Bar */}
      <div className={styles.selectorBar}>
        <div className={styles.selectorGroup}>
          <span className={styles.selectorLabel}>{t("live.tenant")}</span>
          {(() => {
            // Name · tenant name (…last 4 of the directory id); the full id only for admins, in the tooltip
            const cur = tenants.find((tn) => tn.key === tenantId);
            const hint = cur ? t("live.tenantHint", { name: cur.displayName, tenant: cur.tenantName ?? "—", id: cur.tenantId ?? `…${cur.tenantIdTail}` }) : undefined;
            return (
              <select
                className={styles.select}
                value={tenantId}
                onChange={(e) => setTenantId(e.target.value)}
                disabled={tenants.length === 0}
                aria-label={t("live.tenant")}
                title={hint}
              >
                {tenants.length === 0 ? <option value="">{t("live.selectTenant")}</option> : null}
                {tenants.map((tn) => (
                  <option key={tn.key} value={tn.key}>
                    {tn.tenantName
                      ? t("live.tenantOption", { name: tn.displayName, tenant: tn.tenantName, tail: tn.tenantIdTail })
                      : t("live.tenantOptionNoName", { name: tn.displayName, tail: tn.tenantIdTail })}
                  </option>
                ))}
              </select>
            );
          })()}
        </div>
        <div className={styles.selectorDivider} />
        <div className={styles.selectorGroup}>
          <span className={styles.selectorLabel}>{t("live.subscription")}</span>
          <select
            className={styles.select}
            value={subscriptionId}
            onChange={(e) => setSubscriptionId(e.target.value)}
            disabled={subscriptions.length === 0}
            aria-label={t("live.subscription")}
          >
            {subscriptions.length === 0 ? <option value="">{t("live.subscription")}</option> : null}
            {subscriptions.map((s) => (
              <option key={s.subscriptionId} value={s.subscriptionId}>
                {s.name ?? s.subscriptionId}
              </option>
            ))}
          </select>
        </div>
        <div className={styles.selectorDivider} />
        <button
          className={styles.generateBtn}
          onClick={handleGenerate}
          disabled={generating}
          type="button"
        >
          {generating ? t("live.generating") : t("live.generateFromAzure")}
        </button>
        {spec && (
          <>
            <div className={styles.selectorDivider} />
            <div className={styles.selectorGroup}>
              <span className={styles.selectorLabel}>{t("live.region")}</span>
              <MultiSelectDropdown
                label={t("live.region")}
                allLabel={t("live.allRegions")}
                options={regionOptionsMapped}
                selected={selectedRegions}
                onChange={setSelectedRegions}
                disabled={regionOptions.length === 0}
              />
            </div>
            <div className={styles.selectorDivider} />
            <div className={styles.selectorGroup}>
              <span className={styles.selectorLabel}>{t("live.vnet")}</span>
              <MultiSelectDropdown
                label={t("live.vnet")}
                allLabel={t("live.allVnets")}
                options={vnetOptions}
                selected={selectedVnets}
                onChange={setSelectedVnets}
                disabled={vnetOptions.length === 0}
                searchable
              />
            </div>
          </>
        )}
      </div>

      {isSample && diagramId && (
        <Notice tone="warning" title={t("common.sampleData")}>{t("ld.sample.hint")}</Notice>
      )}

      {(error || generateError) && (
        <div className={styles.error}>{error || generateError}</div>
      )}

      {!diagramId && (
        <EmptyState title={t("ld.empty.title")}>
          <p className={styles.emptyHint}>{t("ld.empty.hint")}</p>
          <div className={styles.emptyActions}>
            <Button onClick={handleGenerate} disabled={generating}>
              {generating ? t("live.generating") : t("live.generateFromAzure")}
            </Button>
            <Button onClick={() => setDiagramId(SAMPLE_DIAGRAM_ID)}>{t("ld.empty.sample")}</Button>
          </div>
        </EmptyState>
      )}

      {/* Toolbar: search · coverage · layers · traffic · impact */}
      {filteredSpec && (
        <div className={styles.controlBar}>
          <div className={styles.resourceSearch} ref={searchRef}>
            <input
              className={styles.resourceSearchInput}
              type="text"
              placeholder={t("live.searchResource")}
              value={searchQuery}
              onChange={(e) => { setSearchQuery(e.target.value); setSearchOpen(true); }}
              onFocus={() => setSearchOpen(true)}
            />
            {searchOpen && searchResults.length > 0 && (
              <div className={styles.resourceSearchDropdown}>
                {searchResults.map((n) => (
                  <button
                    key={n.id}
                    type="button"
                    className={styles.resourceSearchItem}
                    onClick={() => handleSearchSelect(n.id)}
                  >
                    <span className={styles.resourceSearchName}>{n.label}</span>
                    {n.resourceKind && (
                      <span className={styles.resourceSearchKind}>{n.resourceKind}</span>
                    )}
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className={styles.statsBar} title={coverageTitle} data-testid="coverage">
            <div className={styles.stat}>
              {t("ld.coverage.resources")} <span className={styles.statVal}>{resourceCount}</span>
            </div>
            <div className={styles.stat}>
              {t("ld.coverage.metrics")} <span className={styles.statVal}>{coverage?.nodesWithMetrics ?? 0}/{coverage?.nodesWithBindings ?? 0}</span>
            </div>
            <div className={styles.stat}>
              {t("ld.coverage.traffic")} <span className={styles.statVal}>{coverage?.edgesWithTraffic ?? 0}/{coverage?.configuredEdges ?? 0}</span>
            </div>
            <div className={styles.stat}>
              {t("live.alerts")} <span className={styles.statVal}>{visibleAlerts.length}</span>
            </div>
          </div>

          <div className={styles.overlayToggles}>
            <LayerMenu layers={layers} counts={layerCounts} onChange={setLayers} />
            <Toggle checked={hoverFocus} onChange={setHoverFocus} title={t("ld.focus.hint")}>
              {t("ld.focus.label")}
            </Toggle>
            <Toggle
              checked={trafficOn && hasMeasuredTraffic}
              onChange={setTrafficOn}
              disabled={!hasMeasuredTraffic}
              title={hasMeasuredTraffic ? t("ld.traffic.hint") : t("ld.traffic.none")}
            >
              {t("ld.traffic.label")}
            </Toggle>
            <Toggle
              checked={impactOn && visibleImpacts.length > 0}
              onChange={setImpactOn}
              disabled={visibleImpacts.length === 0}
              title={visibleImpacts.length > 0 ? t("ld.impact.hint") : t("ld.impact.none")}
            >
              {t("ld.impact.label", { n: visibleImpacts.length })}
            </Toggle>
          </div>
        </div>
      )}

      {/* Canvas + Sidebars */}
      {filteredSpec && (
        <div className={styles.canvasGrid}>
          <LiveCanvas
            spec={filteredSpec}
            snapshot={snapshot}
            onNodeSelect={handleNodeSelect}
            onEdgeSelect={handleEdgeSelect}
            layers={layers}
            trafficOn={trafficOn && hasMeasuredTraffic}
            impacts={shownImpacts}
            usage={usage}
            hoverFocus={hoverFocus}
            selectedNodeId={selectedNodeId}
            focusNodeId={focusNodeId}
            onVmssInstanceSelect={handleVmssInstanceSelect}
            onPeeringSelect={handlePeeringSelect}
            wafOpen={wafOpen}
            onWafToggle={handleWafToggle}
            onWafSelect={handleWafSelect}
          />

          {/* Right sidebar: edge detail, node detail, or alerts (list / timeline) */}
          <div className={styles.sidebarStack}>
            {selectedEdgeId ? (
              <EdgeDetailPanel
                detail={edgeDetail}
                loading={edgeDetailLoading}
                edgeSpec={filteredSpec.edges.find((e) => e.id === selectedEdgeId) ?? null}
                liveEdge={snapshot?.edges.find((e) => e.id === selectedEdgeId)}
                sample={isSample}
                targetPower={snapshot?.nodes.find((n) => n.id === filteredSpec.edges.find((e) => e.id === selectedEdgeId)?.target)?.powerState}
                peering={peeringPairOf(spec, filteredSpec.edges.find((e) => e.id === selectedEdgeId))}
                site={siteOfEdge(spec, filteredSpec.edges.find((e) => e.id === selectedEdgeId))}
                onClose={() => handleEdgeSelect(null)}
              />
            ) : (selectedNodeId || selectedVmssInstance || selectedWaf) ? (
              <ResourceDetailPanel
                nodeSpec={selectedNodeId ? (filteredSpec.nodes.find((n) => n.id === selectedNodeId) ?? null) : null}
                liveNode={selectedNodeId ? (snapshot?.nodes.find((n) => n.id === selectedNodeId) ?? null) : null}
                alerts={selectedNodeId ? (snapshot?.alerts.filter((a) => a.affectedNodeIds.includes(selectedNodeId)) ?? []) : []}
                alertRules={selectedNodeId ? (snapshot?.alertRules?.filter((r) => r.affectedNodeIds.includes(selectedNodeId)) ?? []) : []}
                connectedEdges={selectedNodeId ? connectedEdges : []}
                spec={filteredSpec}
                impacts={shownImpacts}
                alertCount={visibleAlerts.length}
                generatedAt={snapshot?.generatedAt}
                metricsState={snapshot?.coverage?.sources.metrics}
                showInferred={layers.has("inferred")}
                usage={usage}
                usageLoading={wantUsage && usageQuery.loading && !usage}
                onSelectNode={(id) => { handleNodeSelect(id); setFocusNodeId(id + ":" + Date.now()); }}
                focusPeeringKey={focusPeeringKey}
                onOpenVnet={(id) => { setSelectedVnets(new Set([id])); handleNodeSelect(id); setFocusNodeId(id + ":" + Date.now()); }}
                onAddVnet={(id) => { setSelectedVnets((prev) => (prev.size ? new Set([...prev, id]) : prev)); handleNodeSelect(id); setFocusNodeId(id + ":" + Date.now()); }}
                onBack={() => { handleNodeSelect(null); setSelectedVmssInstance(null); }}
                onClose={() => { handleNodeSelect(null); setSelectedVmssInstance(null); setSelectedWaf(null); }}
                vmssInstance={selectedVmssInstance}
                waf={selectedWaf}
                onWafSelect={handleWafSelect}
                wafLiveNode={selectedWaf ? (snapshot?.nodes.find((n) => n.id === selectedWaf.nodeId) ?? null) : null}
              />
            ) : (
              <AlertSidebar
                alerts={visibleAlerts}
                onAlertClick={handleAlertClick}
                impacts={shownImpacts}
                nodeLabel={nodeLabel}
                onNodeClick={(id) => { handleNodeSelect(id); setFocusNodeId(id + ":" + Date.now()); }}
              />
            )}
          </div>
        </div>
      )}
    </div>
  );
}
