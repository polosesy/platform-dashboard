"use client";

import type { DiagramNodeSpec, LiveSpec } from "@aud/types";
import { dateLocale, useI18n } from "@/lib/i18n";
import { mergeSpecFacts } from "@/lib/liveLifecycle";
import { maskGuids } from "@/lib/mask";
import { KV, Section } from "./primitives";
import styles from "../../styles.module.css";

type Fact = { k: string; v: string | number | boolean };

const UNIT: Record<string, string> = {
  storageGb: "ld.spec.unit.gb", osDiskGb: "ld.spec.unit.gb", dailyCapGb: "ld.spec.unit.gb",
  backupDays: "ld.spec.unit.days", softDeleteDays: "ld.spec.unit.days", retentionDays: "ld.spec.unit.days",
  idleTimeout: "ld.spec.unit.minutes",
};

/**
 * The resource's specification (API services/resourceSpec.ts): SKU / tier / size, version, capacity, high
 * availability, access settings — as Azure reports them (names and versions are not translated). Missing = not shown.
 */
export function SpecSection({ node, live }: { node: DiagramNodeSpec; live?: LiveSpec }) {
  const { t, locale } = useI18n();
  let stored: Fact[] = [];
  try { stored = JSON.parse(node.metadata?.spec ?? "[]") as Fact[]; } catch { /* none */ }
  // Values read on this poll replace the ones stored when the diagram was generated (size, instances, tier, …)
  const facts = mergeSpecFacts(stored, live);
  if (!facts.length) return null;
  const asOf = live ? new Date(live.asOf).toLocaleTimeString(dateLocale(locale), { hour: "2-digit", minute: "2-digit" }) : null;
  const value = (f: Fact) => {
    if (typeof f.v === "boolean") return t(f.v ? "ld.spec.yes" : "ld.spec.no");
    if (typeof f.v === "number" && UNIT[f.k]) return t(UNIT[f.k]!, { n: f.v.toLocaleString() });
    if (typeof f.v === "number") return f.v.toLocaleString();
    return maskGuids(f.v);
  };
  return (
    <Section id="spec" title={t("ld.spec.title")}>
      {facts.map((f) => (
        <KV key={f.k} label={t(`ld.spec.${f.k}`)}>
          {value(f)}
          {f.k === "instances" && live?.instancesTarget != null ? ` · ${t("ld.spec.target", { n: live.instancesTarget })}` : ""}
          {f.k === "instances" && live?.instanceStates ? ` · ${Object.entries(live.instanceStates).map(([k, n]) => `${k} ${n}`).join(", ")}` : ""}
        </KV>
      ))}
      {asOf ? <div className={styles.dpMuted}>{t("ld.spec.asOf", { time: asOf })}</div> : null}
    </Section>
  );
}
