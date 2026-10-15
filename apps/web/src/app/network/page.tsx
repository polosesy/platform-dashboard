"use client";

import { Suspense, useState } from "react";
import type { NetCoverageResponse, NetDir, NetFlowsResponse, NetTalkerDim } from "@aud/types";
import { apiUrl, fetchJsonWithBearer } from "@/lib/api";
import { useApiQuery } from "@/lib/useApiQuery";
import { useQueryParam } from "@/lib/useQueryParam";
import { useSubscriptions } from "@/lib/useSubscriptions";
import { useI18n } from "@/lib/i18n";
import { SubscriptionSelect } from "@/components/SubscriptionSelect";
import { ErrorNotice, LoadingState, PageHeader, Select, Tabs } from "@/components/ui";
import { NET_TABS, RANGES, TOPS, type NetTab } from "./tabs";
import { CoverageStrip } from "./components/CoverageStrip";
import { CoverageTable } from "./components/CoverageTable";
import { SectionState } from "./components/SectionState";
import { OverviewSection } from "./components/OverviewSection";
import { TalkersSection } from "./components/TalkersSection";
import { BlockedSection } from "./components/BlockedSection";
import { InternetSection } from "./components/InternetSection";
import styles from "./styles.module.css";

/**
 * VNet traffic — a time-ranged audit of VNet flow logs (Traffic Analytics): what moved, what was blocked, what came
 * from or went to the Internet, and whether the logs are even collected. No topology (the live diagram and the
 * infrastructure diagram own that). Signed-in users never see sample numbers: no data reads as a state.
 */
export default function NetworkPage() {
  return (
    <Suspense fallback={<LoadingState />}>
      <NetworkInner />
    </Suspense>
  );
}

function NetworkInner() {
  const { t } = useI18n();
  const [tab, setTab] = useQueryParam<NetTab>("tab", NET_TABS, "overview");
  const { subscriptions, subscriptionId, setSubscriptionId, loaded } = useSubscriptions();
  const [vnet, setVnet] = useState("");
  const [range, setRange] = useState(1440);
  const [top, setTop] = useState(20);
  const [dim, setDim] = useState<NetTalkerDim>("subnet");
  const [dir, setDir] = useState<NetDir>("in");

  const coverage = useApiQuery<NetCoverageResponse>(
    loaded ? `netcov:${subscriptionId}` : null,
    (token) => fetchJsonWithBearer(apiUrl("/api/network/coverage", { subscriptionId: subscriptionId || undefined }), token),
    { tokenOptional: true },
  );
  const section = tab === "coverage" ? null : tab;
  const variant = section === "talkers" ? dim : section === "internet" ? dir : "-";
  const flows = useApiQuery<NetFlowsResponse>(
    loaded && section ? `netflows:${subscriptionId}:${vnet}:${range}:${section}:${variant}:${top}` : null,
    (token) => fetchJsonWithBearer(apiUrl("/api/network/flows", {
      subscriptionId: subscriptionId || undefined, vnet: vnet || undefined, section: section ?? undefined, range, top,
      dim: section === "talkers" ? dim : undefined, dir: section === "internet" ? dir : undefined,
    }), token),
    { tokenOptional: true },
  );
  // A response for another key is never shown (useApiQuery keeps the last one while loading)
  const data = flows.data && flows.data.section === section ? flows.data : undefined;
  const cov = coverage.data;
  const vnetOptions = [{ value: "", label: t("net.vnetAll") }, ...(cov?.vnets ?? []).map((v) => ({ value: v.key, label: v.name }))];
  const interval = Math.max(0, ...(cov?.vnets ?? []).map((v) => v.intervalMin ?? 0)) || null;

  return (
    <div className={styles.page}>
      <PageHeader
        actions={
          <>
            {subscriptions.length ? <SubscriptionSelect subscriptions={subscriptions} value={subscriptionId} onChange={(v) => { setSubscriptionId(v); setVnet(""); }} /> : null}
            <Select label={t("net.vnet")} value={vnet} onChange={setVnet} options={vnetOptions} />
            <Select label={t("net.range")} value={String(range)} onChange={(v) => setRange(Number(v))} options={RANGES.map((r) => ({ value: String(r.min), label: r.label }))} />
            {section && section !== "overview" ? (
              <Select label={t("net.top")} value={String(top)} onChange={(v) => setTop(Number(v))} options={TOPS.map((n) => ({ value: String(n), label: String(n) }))} />
            ) : null}
          </>
        }
      />

      <CoverageStrip coverage={cov} onOpen={() => setTab("coverage")} />

      <Tabs
        label={t("nav.item.vnetTraffic")}
        idPrefix="net-tab"
        value={tab}
        onChange={setTab}
        items={NET_TABS.map((id) => ({ id, label: t(`net.tab.${id}`) }))}
      />

      {tab === "coverage" ? (
        <>
          <ErrorNotice error={coverage.error} />
          {cov ? <CoverageTable coverage={cov} /> : coverage.loading ? <LoadingState /> : null}
        </>
      ) : (
        <>
          <ErrorNotice error={flows.error} />
          {!data ? (
            flows.loading ? <LoadingState /> : null
          ) : (
            <SectionState flows={data} interval={interval} onCoverage={() => setTab("coverage")}>
              {data.overview ? <OverviewSection overview={data.overview} binMinutes={data.binMinutes ?? 60} lastRow={cov?.workspace.lastRow ?? null} /> : null}
              {data.talkers ? <TalkersSection talkers={data.talkers} dim={dim} onDim={setDim} /> : null}
              {data.blocked ? <BlockedSection rows={data.blocked} /> : null}
              {data.internet ? <InternetSection internet={data.internet} dir={dir} onDir={setDir} /> : null}
            </SectionState>
          )}
        </>
      )}
    </div>
  );
}
