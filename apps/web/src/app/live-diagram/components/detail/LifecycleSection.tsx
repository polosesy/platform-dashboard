"use client";

import type { LiveLifecycle } from "@aud/types";
import { useI18n } from "@/lib/i18n";
import { maskGuids } from "@/lib/mask";
import { Group, KV, Section, TwoLine, useRelativeTime } from "./primitives";
import styles from "../../styles.module.css";

/**
 * 작업 상태: what the resource is doing right now (its own state word, read on this poll) and why — only what a
 * record says (API services/lifecycle.ts): a change record (who: user / app / Azure platform; what: before → after)
 * or an active planned-maintenance event that lists this resource. No record yet = "cause not recorded yet".
 */
export function LifecycleSection({ lifecycle }: { lifecycle: LiveLifecycle | undefined }) {
  const { t } = useI18n();
  const ago = useRelativeTime();
  if (!lifecycle) return null;
  const lc = lifecycle;
  const c = lc.change;
  return (
    <Section id="lifecycle" title={t("ld.lc.title")}>
      <KV label={t("ld.lc.stateLabel")}>{t(lc.state === "ready" ? "ld.lc.state.ready" : `ld.lc.state.${lc.state}`)}{lc.raw ? ` (${lc.raw})` : ""}</KV>
      {lc.cause ? <KV label={t("ld.lc.causeLabel")}>{t(`ld.lc.cause.${lc.cause}`)}</KV> : null}
      {c ? (
        <Group title={t("ld.lc.changeTitle", { when: ago(c.at) })}>
          <KV label={t("ld.lc.byLabel")}>{t(`ld.lc.by.${c.by}`)}{c.changeType ? ` · ${t(`ld.lc.changeType.${c.changeType}`)}` : ""}</KV>
          {c.items.map((it) => (
            <TwoLine key={it.path} mono main={it.path} sub={`${maskGuids(it.from ?? "—")} → ${maskGuids(it.to ?? "—")}`} />
          ))}
          {c.count > c.items.length ? <div className={styles.dpMuted}>{t("ld.lc.moreChanges", { n: c.count - c.items.length })}</div> : null}
        </Group>
      ) : null}
      <div className={styles.dpMuted}>{t(lc.cause === "unknown" ? "ld.lc.noteUnknown" : "ld.lc.note")}</div>
    </Section>
  );
}
