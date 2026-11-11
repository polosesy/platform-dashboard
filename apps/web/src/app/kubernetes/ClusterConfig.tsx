"use client";

// AKS 클러스터 › 클러스터 구성 — what Azure says the cluster is set to (API services/aksClusterConfig.ts, ARM only —
// it answers for a private cluster the Kubernetes API of which the platform cannot reach):
//   버전 · 업그레이드   current version, the versions ARM offers, channels, tier, planned-maintenance windows
//   노드 풀             size · count · autoscaler bounds · OS · zones · version (a pool behind the control plane is marked)
//   네트워크            plugin · dataplane · policy · CIDRs · outbound · API server
//   로그인 · 추가 기능   Entra · Azure RBAC · local accounts · OIDC · workload identity; add-ons on / off / '—' (not in the answer)
// A value ARM did not send is '—' (never a guessed default); the parts that could not be read are named once.

import type { ReactNode } from "react";
import type { AksClusterConfigResponse } from "@aud/types";
import { Cell, Chip, Notice, Panel } from "@/components/ui";
import { dateLocale, useI18n } from "@/lib/i18n";
import { nodeTotals, poolsBehind, upgradeState } from "@/lib/aksConfigView";
import { scheduleText } from "@/lib/nodeMaintView";
import styles from "./styles.module.css";

const DASH = "—";

function Row({ k, children }: { k: string; children: ReactNode }) {
  return (
    <>
      <dt>{k}</dt>
      <dd>{children}</dd>
    </>
  );
}

export function ClusterConfig({ c }: { c: AksClusterConfigResponse }) {
  const { t, locale } = useI18n();
  const up = upgradeState(c.version);
  const behind = new Set(poolsBehind(c));
  const totals = nodeTotals(c.pools);
  const fmt = (iso: string) => new Date(iso).toLocaleString(dateLocale(locale), { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
  const onOff = (v: boolean | null, good?: boolean) =>
    v === null ? <span className={styles.cfgMuted}>{DASH}</span>
      : <Chip level={good === undefined ? (v ? "info" : "neutral") : v === good ? "ok" : "warn"} glyph={good === undefined ? false : undefined}>{t(v ? "k8s.cfg.on" : "k8s.cfg.off")}</Chip>;
  const n = c.network;
  const stopped = c.powerState !== null && c.powerState !== "Running";

  return (
    <>
      {c.gaps.length ? (
        <Cell span={12}><Notice tone="warning" title={t("k8s.cfg.gapsTitle")}>{c.gaps.map((g) => t(`k8s.cfg.gap.${g}`)).join(" · ")}</Notice></Cell>
      ) : null}

      <Cell span={6}>
        <Panel title={t("k8s.cfg.versionTitle")}
          actions={<>
            {stopped ? <Chip level="neutral">{c.powerState}</Chip> : null}
            <Chip level={up.state === "upToDate" ? "ok" : up.state === "unknown" ? "unknown" : up.state === "patch" ? "warn" : "info"}
              title={t(`k8s.cfg.upHint.${up.state}`)}>
              {t(`k8s.cfg.up.${up.state}`, { v: up.to ?? "" })}
            </Chip>
          </>}
          footer={<span>{t("k8s.cfg.versionFoot")}</span>}>
          <dl className={styles.cfgList}>
            <Row k={t("k8s.cfg.version")}>
              <strong>{c.version.current ?? DASH}</strong>
              {c.provisioningState && c.provisioningState !== "Succeeded" ? <> <Chip level="info" glyph={false}>{c.provisioningState}</Chip></> : null}
            </Row>
            <Row k={t("k8s.cfg.upgrades")}>
              {c.version.upgrades === null ? <span className={styles.cfgMuted}>{t("k8s.cfg.notRead")}</span>
                : c.version.upgrades.length === 0 ? t("k8s.cfg.noUpgrades")
                : c.version.upgrades.map((u) => `${u.version}${u.preview ? ` (${t("k8s.cfg.preview")})` : ""}`).join(" · ")}
            </Row>
            <Row k={t("k8s.cfg.channel")}>{c.version.upgradeChannel ?? t("nm.notSet")}</Row>
            <Row k={t("k8s.cfg.nodeOsChannel")}>{c.version.nodeOsChannel ?? t("nm.notSet")}</Row>
            <Row k={t("k8s.cfg.tier")}>{[c.version.tier, c.version.supportPlan].filter(Boolean).join(" · ") || DASH}</Row>
            <Row k={t("k8s.cfg.windows")}>
              {c.windows === null ? <span className={styles.cfgMuted}>{t("k8s.cfg.notRead")}</span>
                : c.windows.length === 0 ? t("k8s.cfg.noWindows")
                : (
                  <ul className={styles.cfgPlain}>
                    {c.windows.map((w) => {
                      const named = t(`nm.win.${w.name}`);
                      return (
                        <li key={w.name}>
                          <b>{named === `nm.win.${w.name}` ? w.name : named}</b> — {scheduleText(t, w)}
                          {w.next ? <span className={styles.cfgMuted}> · {t("nm.next", { at: fmt(w.next) })}</span> : null}
                        </li>
                      );
                    })}
                  </ul>
                )}
            </Row>
          </dl>
        </Panel>
      </Cell>

      <Cell span={6}>
        <Panel title={t("k8s.cfg.poolsTitle")} flush
          sub={totals.max === null ? t("k8s.cfg.poolsSub", { pools: c.pools.length, nodes: totals.nodes }) : t("k8s.cfg.poolsSubMax", { pools: c.pools.length, nodes: totals.nodes, max: totals.max })}
          footer={<span>{behind.size ? t("k8s.cfg.poolsBehind", { n: behind.size }) : t("k8s.cfg.poolsFoot")}</span>}>
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th scope="col">{t("k8s.cfg.pool")}</th>
                  <th scope="col">{t("k8s.cfg.vmSize")}</th>
                  <th scope="col">{t("k8s.cfg.count")}</th>
                  <th scope="col">OS</th>
                  <th scope="col">{t("k8s.cfg.zones")}</th>
                  <th scope="col">{t("k8s.cfg.version")}</th>
                </tr>
              </thead>
              <tbody>
                {c.pools.map((p) => (
                  <tr key={p.name}>
                    <td>
                      <span className={styles.objectName}>{p.name}</span>
                      <span className={styles.cfgSub}>{[p.mode, p.spot ? "Spot" : null, p.powerState && p.powerState !== "Running" ? p.powerState : null].filter(Boolean).join(" · ") || DASH}</span>
                    </td>
                    <td className={styles.mono}>{p.vmSize ?? DASH}</td>
                    <td className={styles.mono}>
                      {p.count ?? DASH}
                      <span className={styles.cfgSub}>{p.autoscale ? t("k8s.cfg.autoscale", p.autoscale) : t("k8s.cfg.fixed")}</span>
                    </td>
                    <td>{[p.osType, p.osSku].filter(Boolean).join(" · ") || DASH}</td>
                    <td className={styles.mono}>{p.zones.length ? p.zones.join(", ") : <span className={styles.cfgMuted} title={t("k8s.cfg.noZonesHint")}>{t("k8s.cfg.noZones")}</span>}</td>
                    <td className={styles.mono}>
                      {p.version ?? DASH}
                      {behind.has(p.name) ? <> <Chip level="warn" title={t("k8s.cfg.behindHint", { v: c.version.current ?? "" })}>{t("k8s.cfg.behind")}</Chip></> : null}
                    </td>
                  </tr>
                ))}
                {c.pools.length === 0 ? <tr><td colSpan={6}><div className={styles.tableHint}>{t("k8s.cfg.noPools")}</div></td></tr> : null}
              </tbody>
            </table>
          </div>
        </Panel>
      </Cell>

      <Cell span={6}>
        <Panel title={t("k8s.cfg.networkTitle")}>
          <dl className={styles.cfgList}>
            <Row k={t("k8s.cfg.plugin")}>{[n.plugin, n.pluginMode].filter(Boolean).join(" · ") || DASH}</Row>
            <Row k={t("k8s.cfg.dataplane")}>{n.dataplane ?? DASH}</Row>
            <Row k={t("k8s.cfg.netPolicy")}>{n.policy ?? t("k8s.cfg.none")}</Row>
            <Row k={t("k8s.cfg.podCidr")}><span className={styles.mono}>{n.podCidr ?? DASH}</span></Row>
            <Row k={t("k8s.cfg.serviceCidr")}><span className={styles.mono}>{n.serviceCidr ?? DASH}</span></Row>
            <Row k={t("k8s.cfg.outbound")}>{[n.outboundType, n.loadBalancerSku].filter(Boolean).join(" · ") || DASH}</Row>
            <Row k={t("k8s.cfg.apiServer")}>
              {n.privateCluster === null ? DASH : n.privateCluster ? t("k8s.access.private")
                : n.authorizedIpRanges ? t("k8s.cfg.publicRanges", { n: n.authorizedIpRanges }) : <Chip level="warn" title={t("k8s.access.publicHint")}>{t("k8s.cfg.publicOpen")}</Chip>}
            </Row>
          </dl>
        </Panel>
      </Cell>

      <Cell span={6}>
        <Panel title={t("k8s.cfg.identityTitle")} footer={<span>{t("k8s.cfg.addonsFoot")}</span>}>
          <dl className={styles.cfgList}>
            <Row k="Entra ID">{onOff(c.identity.entra, true)}</Row>
            <Row k="Azure RBAC">{onOff(c.identity.azureRbac)}</Row>
            <Row k={t("k8s.access.local")}>{onOff(c.identity.localAccounts, false)}</Row>
            <Row k={t("k8s.cfg.oidc")}>{onOff(c.identity.oidcIssuer)}</Row>
            <Row k={t("k8s.cfg.workloadIdentity")}>{onOff(c.identity.workloadIdentity)}</Row>
            <Row k={t("k8s.cfg.addons")}>
              <span className={styles.cfgTags}>
                {c.addons.map((a) => (
                  <Chip key={a.id} level={a.on ? "info" : a.on === false ? "neutral" : "unknown"} glyph={a.on ? "●" : a.on === false ? "○" : "?"}
                    title={t(a.on ? "k8s.cfg.on" : a.on === false ? "k8s.cfg.off" : "k8s.cfg.absent")}>
                    {t(`k8s.cfg.addon.${a.id}`)}
                  </Chip>
                ))}
              </span>
            </Row>
          </dl>
        </Panel>
      </Cell>
    </>
  );
}
