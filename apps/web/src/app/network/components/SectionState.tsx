"use client";

import type { ReactNode } from "react";
import type { NetFlowsResponse } from "@aud/types";
import { Button, EmptyState, Notice, SampleDataNotice } from "@/components/ui";
import { useI18n } from "@/lib/i18n";

/**
 * Honest states around a section: sample data (anonymous), no workspace, no permission, no table, nothing in range —
 * never zeros dressed as measurements. Talkers / Internet keep their own switch visible when empty.
 */
export function SectionState({ flows, interval, onCoverage, children }: { flows: NetFlowsResponse; interval: number | null; onCoverage: () => void; children: ReactNode }) {
  const { t } = useI18n();
  const ok = flows.state === "ok";
  const keepSwitch = flows.section === "talkers" || flows.section === "internet";
  const coverageButton = <Button size="sm" onClick={onCoverage}>{t("net.checkCoverage")}</Button>;
  return (
    <>
      {flows.source === "mock" ? <SampleDataNotice note={flows.note ?? "mock"} /> : null}
      {flows.gaps.length ? (
        <Notice tone="warning">{flows.gaps.map((g) => t("net.unmeasured", { part: t(`net.part.${g.part}`) })).join(" · ")}</Notice>
      ) : null}
      {flows.state === "noAccess" ? <Notice tone="warning">{t("net.state.noAccess")}</Notice> : null}
      {flows.state === "disabled" ? <EmptyState title={t("net.state.disabled")} /> : null}
      {flows.state === "noTable" ? <EmptyState title={t("net.state.noTable")}>{coverageButton}</EmptyState> : null}
      {flows.state === "empty" && !keepSwitch ? (
        <EmptyState title={t("net.state.empty")}>
          {interval ? <p>{t("net.intervalHint", { min: interval })}</p> : null}
          {coverageButton}
        </EmptyState>
      ) : null}
      {ok || (keepSwitch && flows.state === "empty") ? children : null}
      {flows.state === "empty" && keepSwitch ? (
        <EmptyState title={t("net.state.empty")}>{coverageButton}</EmptyState>
      ) : null}
    </>
  );
}
