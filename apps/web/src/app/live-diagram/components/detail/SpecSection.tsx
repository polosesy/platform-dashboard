"use client";

import type { DiagramNodeSpec } from "@aud/types";
import { useI18n } from "@/lib/i18n";
import { maskGuids } from "@/lib/mask";
import { KV, Section } from "./primitives";

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
export function SpecSection({ node }: { node: DiagramNodeSpec }) {
  const { t } = useI18n();
  let facts: Fact[] = [];
  try { facts = JSON.parse(node.metadata?.spec ?? "[]") as Fact[]; } catch { /* none */ }
  if (!facts.length) return null;
  const value = (f: Fact) => {
    if (typeof f.v === "boolean") return t(f.v ? "ld.spec.yes" : "ld.spec.no");
    if (typeof f.v === "number" && UNIT[f.k]) return t(UNIT[f.k]!, { n: f.v.toLocaleString() });
    if (typeof f.v === "number") return f.v.toLocaleString();
    return maskGuids(f.v);
  };
  return (
    <Section id="spec" title={t("ld.spec.title")}>
      {facts.map((f) => <KV key={f.k} label={t(`ld.spec.${f.k}`)}>{value(f)}</KV>)}
    </Section>
  );
}
