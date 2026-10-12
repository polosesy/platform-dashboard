"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import type { ArchitectureNode } from "@aud/types";
import { internetId, locationPath, type ArchDrawEdge, type ArchEdge, type ArchModel, type ArchPlaced } from "@/lib/archModel";
import { formatAzureRegion } from "@/app/live-diagram/utils/regionFormat";
import { useI18n } from "@/lib/i18n";
import s from "../styles.module.css";

export type InspectorTarget =
  | { type: "shape"; shape: ArchPlaced }
  | { type: "cleanup" }
  | null;

type Props = {
  model: ArchModel;
  target: InspectorTarget;
  drawn: ArchDrawEdge[];
  offscreen: ArchEdge[];
  onSelect: (shapeId: string) => void;
  shownAt: Map<string, string>;
};

function Row({ k, children }: { k: string; children: ReactNode }) {
  return (
    <div className={s.iRow}>
      <dt>{k}</dt>
      <dd>{children}</dd>
    </div>
  );
}

const portalUrl = (azureId?: string) => (azureId ? `https://portal.azure.com/#@/resource${azureId}` : null);

export function Inspector({ model, target, drawn, offscreen, onSelect, shownAt }: Props) {
  const { t } = useI18n();
  const kind = (k: string) => {
    const v = t(`arch.kind.${k}`);
    return v === `arch.kind.${k}` ? k : v;
  };
  const nameOf = (id: string) => {
    if (id.startsWith("internet:")) return t("arch.internet");
    const n = model.nodes.get(id.replace(/^ghost:/, ""));
    return n?.name ?? id;
  };

  if (!target) {
    return (
      <aside className={s.inspector} aria-label={t("arch.select")}>
        <p className={s.iEmpty}>{t("arch.select")}</p>
      </aside>
    );
  }

  if (target.type === "cleanup") {
    const groups: Array<[string, Array<{ name: string; detail?: string; region: string }>]> = [
      [t("arch.unusedPip", { n: "" }).trim(), model.regions.flatMap((r) => r.unusedPublicIps.map((x) => ({ ...x, region: r.key })))],
      [t("arch.unresolvedPip", { n: "" }).trim(), model.regions.flatMap((r) => r.unresolvedPublicIps.map((x) => ({ ...x, region: r.key })))],
      [t("arch.unusedNsg", { n: "" }).trim(), model.regions.flatMap((r) => r.unusedNsgs.map((x) => ({ ...x, region: r.key })))],
    ];
    return (
      <aside className={s.inspector}>
        <h2 className={s.iTitle}>{t("arch.i.cleanup")}</h2>
        <p className={s.iHint}>{t("arch.sum.cleanupHint")}</p>
        {groups.map(([title, items]) => (
          <section key={title} className={s.iSection}>
            <h3>{title} · {items.length}</h3>
            <ul className={s.iList}>
              {items.map((x, i) => (
                <li key={`${x.name}-${i}`}>
                  <span className={s.mono}>{x.name}</span>
                  <span className={s.iDim}>{formatAzureRegion(x.region)}{x.detail ? ` · ${x.detail}` : ""}</span>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </aside>
    );
  }

  const sh = target.shape;
  // Lines touching this shape, plus relationships whose other end is in a region not shown
  const links = drawn.filter((e) => e.source === sh.id || e.target === sh.id);
  const ref = sh.shape === "internet" ? null : "ref" in sh ? sh.ref : null;
  const offs = ref ? offscreen.filter((e) => e.source === ref || e.target === ref) : [];

  const linkList = (
    <section className={s.iSection}>
      <h3>{t("arch.i.links")}</h3>
      {links.length + offs.length === 0 ? (
        <p className={s.iDim}>{t("arch.i.noLinks")}</p>
      ) : (
        <ul className={s.iList}>
          {links.map((e) => {
            const other = e.source === sh.id ? e.target : e.source;
            return (
              <li key={e.id}>
                <button type="button" className={s.iLink} onClick={() => onSelect(other)}>
                  {e.source === sh.id ? "→" : "←"} {nameOf(other)}
                </button>
                <span className={s.iDim}>{t(`arch.edge.${e.kind}`)}{e.count > 1 ? ` ×${e.count}` : ""}</span>
              </li>
            );
          })}
          {offs.map((e) => {
            const other = e.source === ref ? e.target : e.source;
            const at = shownAt.get(other);
            return (
              <li key={`off-${e.id}`}>
                {at ? <button type="button" className={s.iLink} onClick={() => onSelect(at)}>{nameOf(other)}</button> : <span>{nameOf(other)}</span>}
                <span className={s.iDim}>{t(`arch.edge.${e.kind}`)}</span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );

  if (sh.shape === "internet") {
    const entries = model.edges.filter((e) => e.source === internetId(sh.region) && (e.kind === "ingress" || e.kind === "exposure"));
    return (
      <aside className={s.inspector}>
        <h2 className={s.iTitle}>{t("arch.internet")}</h2>
        <p className={s.iHint}>{t("arch.legendNote")}</p>
        <section className={s.iSection}>
          <h3>{t("arch.i.entries")} · {entries.length}</h3>
          <ul className={s.iList}>
            {entries.map((e) => (
              <li key={e.id}>
                <button type="button" className={s.iLink} onClick={() => onSelect(shownAt.get(e.target) ?? e.target)}>{nameOf(e.target)}</button>
                <span className={s.iDim}>{t(`arch.edge.${e.kind}`)} · {model.resources.get(e.target)?.publicIps.join(", ")}</span>
              </li>
            ))}
          </ul>
        </section>
      </aside>
    );
  }

  if (sh.shape === "stack") {
    return (
      <aside className={s.inspector}>
        <h2 className={s.iTitle}>{t("arch.stackOf", { kind: kind(sh.kind), n: sh.members.length })}</h2>
        <section className={s.iSection}>
          <h3>{t("arch.i.members")}</h3>
          <ul className={s.iList}>
            {sh.members.map((id) => {
              const r = model.resources.get(id)!;
              return (
                <li key={id}>
                  <span className={s.mono}>{r.node.name}</span>
                  <span className={s.iDim}>{[...r.privateIps, ...r.publicIps].join(" · ")}</span>
                </li>
              );
            })}
          </ul>
        </section>
        {linkList}
      </aside>
    );
  }

  if (sh.shape === "box" && sh.type !== "vnet" && sh.type !== "subnet") {
    const reg = sh.type === "region" ? model.regions.find((r) => `region:${r.key}` === sh.id) : undefined;
    return (
      <aside className={s.inspector}>
        <h2 className={s.iTitle}>{reg ? formatAzureRegion(reg.key) : t(`arch.${sh.type === "group" ? "paas" : "lane"}.${sh.label}`)}</h2>
        {reg ? (
          <dl className={s.iRows}>
            <Row k={t("arch.sum.vnets")}>{reg.vnets.length}</Row>
            <Row k={t("arch.unusedPip", { n: "" }).trim()}>{reg.unusedPublicIps.map((x) => x.name).join(", ") || "—"}</Row>
            <Row k={t("arch.unresolvedPip", { n: "" }).trim()}>{reg.unresolvedPublicIps.map((x) => `${x.name} (${x.detail})`).join(", ") || "—"}</Row>
            <Row k={t("arch.unusedNsg", { n: "" }).trim()}>{reg.unusedNsgs.map((x) => x.name).join(", ") || "—"}</Row>
          </dl>
        ) : null}
      </aside>
    );
  }

  // VNet (box or pill), subnet, tile or ghost
  const id = sh.shape === "box" ? sh.id : sh.ref;
  const vnet = model.vnets.get(id);
  const subnet = model.subnets.get(id);
  const res = model.resources.get(id);
  const node: ArchitectureNode | undefined = res?.node ?? vnet?.node ?? subnet?.node ?? model.nodes.get(id);
  if (!node) return null;
  const path = locationPath(model, id);
  const portal = portalUrl(node.azureId);

  return (
    <aside className={s.inspector}>
      <h2 className={s.iTitle}>{node.name}</h2>
      <p className={s.iKind}>{kind(node.kind)}</p>
      <dl className={s.iRows}>
        {node.resourceGroup ? <Row k={t("arch.i.rg")}>{node.resourceGroup}</Row> : null}
        {path ? <Row k={t("arch.i.region")}>{path.region === "global" ? t("arch.lane.global") : formatAzureRegion(path.region)}</Row> : null}
        {path?.vnet ? (
          <Row k={t("arch.i.path")}>
            {path.vnet.name}{path.subnet ? ` › ${path.subnet.name}` : ""}
          </Row>
        ) : null}
        {(vnet || subnet) && node.endpoint ? <Row k={t("arch.i.cidr")}><span className={s.mono}>{node.endpoint}</span></Row> : null}
        {vnet ? <Row k={t("arch.i.subnets")}>{vnet.subnets.map((x) => `${x.node.name}${x.node.endpoint ? ` (${x.node.endpoint})` : ""}`).join(", ") || "—"}</Row> : null}
        {subnet?.nsgs.length ? <Row k={t("arch.i.nsg")}>{subnet.nsgs.join(", ")}</Row> : null}
        {subnet?.natGateways.length ? <Row k={t("arch.i.nat")}>{subnet.natGateways.join(", ")}</Row> : null}
        {subnet?.otherNics ? <Row k={t("arch.otherNics", { n: "" }).trim()}>{subnet.otherNics} <span className={s.iDim}>— {t("arch.otherNicsHint")}</span></Row> : null}
        {subnet?.publicIps.length ? <Row k={t("arch.i.publicIp")}><span className={s.mono}>{subnet.publicIps.join(", ")}</span></Row> : null}
        {res?.privateIps.length ? <Row k={t("arch.i.privateIp")}><span className={s.mono}>{res.privateIps.join(", ")}</span></Row> : null}
        {res?.publicIps.length ? <Row k={t("arch.i.publicIp")}><span className={s.mono}>{res.publicIps.join(", ")}</span></Row> : null}
        {res && !res.privateIps.length && !res.publicIps.length && node.endpoint ? <Row k={t("arch.i.endpoint")}><span className={s.mono}>{node.endpoint}</span></Row> : null}
        {res?.nsgs.length ? <Row k={t("arch.i.nsg")}>{res.nsgs.join(", ")}</Row> : null}
        {res && res.nicCount > 0 ? <Row k={t("arch.i.nics")}>{res.nicCount}</Row> : null}
        {res?.nodePools.length ? <Row k={t("arch.i.pools")}>{res.nodePools.join(", ")}</Row> : null}
        {res?.extraSubnets.length ? <Row k={t("arch.i.extraSubnets")}>{res.extraSubnets.map((x) => model.subnets.get(x)?.node.name ?? x).join(", ")}</Row> : null}
      </dl>
      {linkList}
      <div className={s.iActions}>
        {portal ? <a href={portal} target="_blank" rel="noopener noreferrer" className={s.iAction}>{t("common.openPortal")} ↗</a> : null}
        {vnet ? <Link href="/live-diagram" className={s.iAction}>{t("arch.openLive")} →</Link> : null}
      </div>
      {node.metadata && Object.keys(node.metadata).length ? (
        <details className={s.iAdvanced}>
          <summary>{t("arch.i.advanced")}</summary>
          <pre>{JSON.stringify(node.metadata, null, 2)}</pre>
        </details>
      ) : null}
    </aside>
  );
}
