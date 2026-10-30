"use client";

// AKS 보안 점검 › ID·권한 › 워크로드 ID — who in the cluster becomes which Azure identity, with what rights:
// workloads → ServiceAccount → federated credential → managed identity (n/20 credentials) → Azure roles, plus the
// IMDS path: a node pool whose scale set carries the identity (any pod on it can get the token without workload
// identity — configuration, never drawn to a workload as use). Workloads without workload identity are listed per
// namespace so a namespace missing from the map is explained. Findings WI-01…17 (API services/workloadIdentity.ts)
// each cite the official document. Unknown is grey and dashed, never coloured as risk. The diagram's columns follow
// the container width — no sideways scrolling.

import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { WiFinding, WiOtherWorkload, WiRoleUsage, WiSeverity, WorkloadIdentityResponse } from "@aud/types";
import { dateLocale, useI18n, type Locale } from "@/lib/i18n";
import { Button, Notice, Segmented } from "@/components/ui";
import { Inspector, Pill, type InspectorModel, type InspectorRow } from "./Inspector";
import { chainOf, ficGauge, layoutWi, namespaceCoverage, nodeSeverity, poolOfNodeId, wiGraph, type WiKind } from "./wiLayout";
import styles from "./insights.module.css";

type View = "graph" | "table";
const SEV_TONE: Record<WiSeverity, "crit" | "warn" | "ok" | "unk"> = { crit: "crit", warn: "warn", low: "unk", info: "unk" };

function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [w, setW] = useState(1000);
  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([e]) => setW(Math.floor(e!.contentRect.width)));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

/** Workloads without workload identity — per namespace, with what the configuration says they could use instead */
function OtherWorkloads({ data, showSystem }: { data: WorkloadIdentityResponse; showSystem: boolean }) {
  const { t } = useI18n();
  const cov = useMemo(() => namespaceCoverage(data, { showSystem }), [data, showSystem]);
  // Default: the namespace that uses workload identity for some workloads but not for most (the "why is it missing" case)
  const [ns, setNs] = useState<string | null>(() => cov.find((c) => c.wi > 0 && c.other > 0)?.namespace ?? null);
  const rows = data.otherWorkloads.filter((w) => (showSystem || !w.managed) && (!ns || w.namespace === ns));
  const total = data.otherWorkloads.filter((w) => showSystem || !w.managed).length;
  const idName = (id: string) => data.identities.find((i) => i.id === id)?.name ?? t("wi.unknown");
  const imdsIds = (w: WiOtherWorkload): string[] | null => {
    if (data.imds.podAccess === "restricted" && !w.hostNetwork) return [];
    return [...new Set(w.pools.flatMap((p) => data.nodePools.find((x) => x.id === p)?.identityIds ?? []))];
  };
  if (!total) return null;
  return (
    <details className={styles.wiOther} open={!!ns || undefined}>
      <summary><h4 className={styles.wiH}>{t("wi.other.title")} <span className={styles.wiCount}>{total}</span></h4></summary>
      <p className={styles.wiNote}>{t("wi.other.note")}</p>
      <div className={styles.wiNsChips} role="group" aria-label={t("wi.other.ns")}>
        <button type="button" className={styles.wiNsChip} aria-pressed={ns === null} onClick={() => setNs(null)}>{t("wi.other.all")} <b>{total}</b></button>
        {cov.filter((c) => c.other > 0).map((c) => (
          <button key={c.namespace} type="button" className={styles.wiNsChip} aria-pressed={ns === c.namespace} onClick={() => setNs(c.namespace)}
            title={t("wi.other.chipTip", { wi: c.wi, other: c.other })}>
            {c.namespace} <b>{c.other}</b>{c.wi > 0 && <span className={styles.wiMuted}> · {t("wi.other.chipWi", { n: c.wi })}</span>}
          </button>
        ))}
      </div>
      <div className={styles.wiOtherBox}>
        <table className={styles.wiTable} aria-label={t("wi.other.title")}>
          <thead><tr><th scope="col">{t("wi.col.0")}</th><th scope="col">{t("wi.col.1")}</th><th scope="col">{t("wi.other.pools")}</th><th scope="col">{t("wi.other.imds")}</th><th scope="col">{t("wi.other.secrets")}</th></tr></thead>
          <tbody>
            {rows.map((w) => {
              const ids = imdsIds(w);
              return (
                <tr key={w.id}>
                  <td>{w.name}<span className={styles.wiMuted}> · {w.namespace} · {w.kind} · {t("wi.pods", { n: w.pods })}</span></td>
                  <td>{w.serviceAccount}</td>
                  <td>{w.pools.map((p) => p.slice("pool:".length)).join(", ") || <span className={styles.wiMuted}>{w.pods ? t("wi.unknown") : t("wi.injected.noRunningPods")}</span>}</td>
                  <td>{ids === null || data.imds.pools !== "ok" ? <span className={styles.wiMuted}>{t("wi.unknown")}</span>
                    : ids.length ? <span className={styles.wiImdsIds}>{ids.map(idName).join(", ")}</span>
                      : <span className={styles.wiMuted}>{data.imds.podAccess === "restricted" ? t("wi.imds.restricted") : t("wi.other.none")}</span>}</td>
                  <td>{w.usesSecrets ? t("wi.yes") : <span className={styles.wiMuted}>{t("wi.no")}</span>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </details>
  );
}

function CopyCode({ code }: { code: string }) {
  const { t } = useI18n();
  const [done, setDone] = useState(false);
  return (
    <div className={styles.wiCode}>
      <code>{code}</code>
      <button type="button" className={styles.linkish} onClick={() => { void navigator.clipboard?.writeText(code).then(() => { setDone(true); setTimeout(() => setDone(false), 1500); }); }}>
        {done ? t("wi.copied") : t("wi.copy")}
      </button>
    </div>
  );
}

export function WorkloadIdentityPanel({ data, showSystem, onScan, scanning }: { data: WorkloadIdentityResponse; showSystem: boolean; onScan: () => void; scanning: boolean }) {
  const { t, locale } = useI18n();
  const [sel, setSel] = useState<string | null>(null);
  const [view, setView] = useState<View>("graph");
  const [boxRef, width] = useWidth<HTMLDivElement>();
  const graph = useMemo(() => wiGraph(data, { showSystem }), [data, showSystem]);
  const layout = useMemo(() => layoutWi(graph, { width: Math.max(760, width) }), [graph, width]);
  const sev = useMemo(() => nodeSeverity(data), [data]);
  const chain = useMemo(() => (sel ? chainOf(graph, sel) : null), [graph, sel]);
  const narrow = width < 760;
  const counts = (["crit", "warn", "low", "info"] as WiSeverity[]).map((s) => [s, data.findings.filter((f) => f.sev === s).length] as const);
  const findings = data.findings.filter((f) => showSystem || !f.refs.some((r) => data.serviceAccounts.find((s) => s.id === r)?.managed));

  const label = (id: string): { kind: WiKind; title: string; sub: string; extra?: string } | null => {
    const w = data.workloads.find((x) => x.id === id);
    if (w) return { kind: "workload", title: w.name, sub: `${w.namespace} · ${w.kind} · ${t("wi.pods", { n: w.pods })}`, extra: !w.useLabel ? t("wi.useLabel.missing") : w.injected === "no" ? t("wi.injected.no") : undefined };
    const s = data.serviceAccounts.find((x) => x.id === id);
    if (s) {
      const keys = [...new Set(s.k8sRbac.flatMap((b) => b.keys))];
      return { kind: "sa", title: `${s.namespace}/${s.name}`, sub: s.clientIdTail ? `client-id ${s.clientIdTail}${s.clientIdSource === "podEnv" ? ` · ${t("wi.fromPodEnv")}` : ""}` : t("wi.noClientId"), extra: keys.length ? `K8s: ${keys.slice(0, 2).join(", ")}${keys.length > 2 ? ` +${keys.length - 2}` : ""}` : s.exists === false ? t("wi.dangling") : undefined };
    }
    const poolId = poolOfNodeId(id);
    const pool = poolId ? data.nodePools.find((x) => x.id === poolId) : undefined;
    if (pool) return { kind: "pool", title: t("wi.pool.title", { name: pool.name }), sub: t("wi.pool.sub", { nodes: pool.nodes, n: pool.withoutWi }), extra: t(`wi.imds.${data.imds.podAccess ?? "unknown"}`) };
    const f = data.fics.find((x) => x.id === id);
    if (f) return { kind: "fic", title: f.name, sub: f.dangling ? t("wi.dangling") : f.subject.replace("system:serviceaccount:", "sa:"), extra: f.issuerMatch !== "exact" ? t(`wi.match.${f.issuerMatch}`) : f.subjectMatch && f.subjectMatch !== "exact" && f.subjectMatch !== "other" ? t(`wi.match.${f.subjectMatch}`) : !f.audienceOk ? t("wi.audience.off") : undefined };
    const i = data.identities.find((x) => x.id === id);
    if (i) return { kind: "identity", title: i.kind === "unresolved" ? t("wi.unresolved") : i.name ?? i.clientIdTail, sub: i.kind === "unresolved" ? `client-id ${i.clientIdTail}` : `${i.resourceGroup} · ${i.location}` };
    for (const idn of data.identities) {
      const ra = idn.roles.find((x) => x.id === id);
      if (ra) return { kind: "role", title: ra.roleName, sub: `${t(`wi.scope.${ra.scope.level}`)} · ${ra.scope.label}`, extra: ra.usage?.state === "unused" ? t("wi.usage.unusedShort", { days: ra.usage.days }) : ra.privileged ? t("wi.privileged") : undefined };
    }
    return null;
  };

  const inspector = (id: string): InspectorModel | null => {
    const lb = label(id);
    if (!lb) return null;
    const related = findings.filter((f) => f.refs.includes(id));
    const callouts = related.slice(0, 4).map((f) => ({ tone: (f.sev === "crit" || f.sev === "warn" ? "warn" : "info") as "warn" | "info", content: <span><strong>{f.rule}</strong> {f.title}</span> }));
    const kicker = t(`wi.kicker.${lb.kind}`);
    const rows: InspectorRow[] = [];
    const sections: InspectorModel["sections"] = [];
    if (lb.kind === "workload") {
      const w = data.workloads.find((x) => x.id === id)!;
      rows.push({ k: t("wi.f.namespace"), v: w.namespace }, { k: t("wi.f.kind"), v: w.kind }, { k: t("wi.f.pods"), v: String(w.pods) },
        { k: t("wi.f.useLabel"), v: w.useLabel ? t("wi.yes") : t("wi.no"), ev: "cfg" }, { k: t("wi.f.injected"), v: t(`wi.injected.${w.injected}`), ev: "cfg" });
      if (w.injectedClientIdTail) rows.push({ k: t("wi.f.injectedClient"), v: w.injectedClientIdTail, mono: true });
      sections.push({ h: t("wi.sec.facts"), rows });
    } else if (lb.kind === "sa") {
      const s = data.serviceAccounts.find((x) => x.id === id)!;
      rows.push({ k: t("wi.f.exists"), v: s.exists === null ? t("wi.unknown") : s.exists ? t("wi.yes") : t("wi.no"), ev: s.exists === null ? "unk" : "cfg" });
      if (s.clientIdTail) rows.push({ k: "client-id", v: `${s.clientIdTail} (${s.clientIdSource === "annotation" ? t("wi.fromAnnotation") : t("wi.fromPodEnv")})`, mono: true, ev: "cfg" });
      if (s.tenantIdTail) rows.push({ k: "tenant-id", v: `${s.tenantIdTail}${s.tenantMatch === false ? ` — ${t("wi.tenantMismatch")}` : ""}`, mono: true });
      sections.push({ h: t("wi.sec.facts"), rows });
      sections.push({ h: t("wi.k8sRbac"), rows: s.k8sRbac.length ? s.k8sRbac.map((b) => ({ k: `${b.kind} ${b.name}`, v: `${b.role}${b.keys.length ? ` — ${b.keys.join(", ")}` : ""}${b.via === "group" ? ` · ${t("wi.k8sRbac.viaGroup", { group: b.group ?? "" })}` : ""}`, ev: "perm" as const })) : [{ k: "", v: t("wi.k8sRbac.none") }] });
      if (s.canUseIdentity.length) sections.push({ h: t("wi.canUse"), rows: s.canUseIdentity.map((c) => ({ k: c.subject, v: `${c.binding} — ${c.keys.join(", ")}`, ev: "perm" as const })) });
      sections.push({ h: t("wi.sec.check"), body: <CopyCode code={`kubectl auth can-i --list --as=system:serviceaccount:${s.namespace}:${s.name}`} /> });
    } else if (lb.kind === "pool") {
      const pool = data.nodePools.find((x) => x.id === poolOfNodeId(id))!;
      rows.push({ k: t("wi.pool.name"), v: pool.name }, { k: t("wi.pool.nodes"), v: String(pool.nodes) },
        { k: t("wi.pool.imds"), v: t(`wi.imds.${data.imds.podAccess ?? "unknown"}`), ev: data.imds.podAccess === null ? "unk" : "cfg" },
        { k: t("wi.pool.workloads"), v: t("wi.pool.workloadsV", { n: pool.workloads, other: pool.withoutWi }) },
        { k: t("wi.pool.identities"), v: pool.identityIds.map((x) => data.identities.find((i) => i.id === x)?.name ?? "?").join(", ") || "-", ev: "cfg" });
      sections.push({ h: t("wi.sec.facts"), rows });
      if (pool.namespaces.length) sections.push({ h: t("wi.pool.byNs"), rows: pool.namespaces.map((n) => ({ k: n.namespace, v: t("wi.pool.workloadsV", { n: n.workloads, other: n.withoutWi }) })) });
      if (data.imds.allowPolicies.length) sections.push({ h: t("wi.pool.allow"), rows: data.imds.allowPolicies.map((p) => ({ k: `${p.namespace ? `${p.namespace}/` : ""}${p.name}`, v: `${p.kind}${p.selectsAll ? ` · ${t("wi.pool.selectsAll")}` : ""}`, ev: "cfg" as const })) });
      if (data.imds.restrictionBlockedBy.length) sections.push({ h: t("wi.pool.restriction"), body: <p className={styles.wiNote}>{t("wi.pool.restrictionBlocked", { addons: data.imds.restrictionBlockedBy.join(", ") })}</p> });
      sections.push({ h: t("wi.sec.note"), body: <p className={styles.wiNote}>{t("wi.pool.note")}</p> });
    } else if (lb.kind === "fic") {
      const f = data.fics.find((x) => x.id === id)!;
      rows.push({ k: "issuer", v: `${f.issuerMasked} — ${t(`wi.match.${f.issuerMatch}`)}`, mono: true, ev: "cfg" },
        { k: "subject", v: `${f.subject}${f.subjectMatch ? ` — ${t(`wi.match.${f.subjectMatch}`)}` : ""}`, mono: true, ev: "cfg" },
        { k: "audience", v: f.audiences.join(", ") || "-", mono: true, ev: "cfg" },
        { k: t("wi.f.sa"), v: f.dangling === null ? t("wi.unknown") : f.dangling ? t("wi.dangling") : f.saId?.replace("sa:", "") ?? "-", ev: f.dangling === null ? "unk" : "cfg" });
      sections.push({ h: t("wi.sec.facts"), rows }, { h: t("wi.sec.rule"), body: <p className={styles.wiNote}>{t("wi.matchRule")}</p> });
    } else if (lb.kind === "identity") {
      const i = data.identities.find((x) => x.id === id)!;
      if (i.kind === "unresolved") {
        sections.push({ h: t("wi.sec.facts"), rows: [{ k: "client-id", v: i.clientIdTail, mono: true, ev: "unk" }] },
          { h: t("wi.sec.why"), body: <p className={styles.wiNote}>{t("wi.unresolved.why")} {t("wi.systemAssigned")}</p> });
      } else {
        const g = ficGauge(i.fic.count, i.fic.limit);
        rows.push({ k: t("wi.f.rg"), v: i.resourceGroup ?? "-" }, { k: t("wi.f.subscription"), v: i.subscription ?? t("wi.unknown") }, { k: t("wi.f.location"), v: i.location ?? "-" },
          { k: "client-id", v: i.clientIdTail, mono: true }, { k: t("wi.gauge.label"), v: g.text, ev: i.fic.status === "ok" ? "cfg" : "unk" });
        if (i.fic.otherIssuers) rows.push({ k: t("wi.f.otherIssuers"), v: String(i.fic.otherIssuers) });
        if (i.pools?.length) rows.push({ k: t("wi.f.pools"), v: i.pools.map((p) => p.slice("pool:".length)).join(", "), ev: "cfg" });
        if (i.fic.status !== "ok") rows.push({ k: t("wi.f.ficStatus"), v: t(`wi.ficStatus.${i.fic.status}`), ev: "unk" });
        sections.push({ h: t("wi.sec.facts"), rows }, { h: t("wi.sec.limit"), body: <p className={styles.wiNote}>{t("wi.limitNote")}</p> });
      }
    } else {
      const idn = data.identities.find((x) => x.roles.some((r) => r.id === id))!;
      const ra = idn.roles.find((x) => x.id === id)!;
      rows.push({ k: t("wi.f.role"), v: ra.roleName, ev: "perm" }, { k: t("wi.f.scope"), v: `${t(`wi.scope.${ra.scope.level}`)} · ${ra.scope.label}${ra.scope.resourceType ? ` (${ra.scope.resourceType})` : ""}` },
        { k: t("wi.f.builtIn"), v: ra.builtIn === null ? t("wi.unknown") : ra.builtIn ? t("wi.yes") : t("wi.no") }, { k: t("wi.f.condition"), v: ra.conditional ? t("wi.yes") : t("wi.no") });
      if (ra.usage) rows.push({ k: t("wi.f.usage"), v: usageText(ra.usage, t, locale), ev: ra.usage.state === "unknown" ? "unk" : "obs", evText: ra.usage.state === "unknown" ? undefined : t("wi.usage.evLog"), src: ra.usage.source ? t(`wi.usage.src.${ra.usage.source}`) : undefined });
      sections.push({ h: t("wi.sec.facts"), rows }, { h: t("wi.sec.note"), body: <p className={styles.wiNote}>{t("wi.roles.propagation")} · {t("wi.roles.pim")}</p> });
    }
    return { id, kicker, title: lb.title, sub: lb.sub, callouts, sections };
  };

  const pick = (id: string | null) => setSel((cur) => (cur === id ? null : id));
  const keyAct = (e: KeyboardEvent, id: string) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pick(id); }
    if (e.key === "Escape") setSel(null);
  };
  const model = sel ? inspector(sel) : null;
  const scan = data.coverage.subscriptionScan;

  return (
    <section className={styles.wiRoot} aria-label={t("wi.aria")}>
      <header className={styles.wiHead}>
        <div>
          <h3 className={styles.wiTitle}>{t("wi.title")}</h3>
          <p className={styles.wiSub}>{t("wi.sub")}</p>
        </div>
        <div className={styles.wiChips}>
          <Pill tone={data.cluster.oidcIssuerEnabled === null ? "unk" : data.cluster.oidcIssuerEnabled ? "ok" : "warn"}>{t("wi.cluster.oidc")} {data.cluster.oidcIssuerEnabled === null ? "?" : data.cluster.oidcIssuerEnabled ? t("wi.cluster.on") : t("wi.cluster.off")}</Pill>
          <Pill tone={data.cluster.workloadIdentityEnabled === null ? "unk" : data.cluster.workloadIdentityEnabled ? "ok" : "warn"}>{t("wi.cluster.wi")} {data.cluster.workloadIdentityEnabled === null ? "?" : data.cluster.workloadIdentityEnabled ? t("wi.cluster.on") : t("wi.cluster.off")}</Pill>
          <Pill tone={data.imds.podAccess === null ? "unk" : data.imds.podAccess === "restricted" ? "ok" : "warn"}>{t("wi.cluster.imds")} {t(`wi.imds.${data.imds.podAccess ?? "unknown"}`)}</Pill>
          <span className={styles.wiCount}>{t("wi.summary", { sa: data.serviceAccounts.length, id: data.coverage.identitiesResolved, un: data.coverage.identitiesUnresolved })}</span>
          {counts.filter(([, n]) => n > 0).map(([s, n]) => <Pill key={s} tone={SEV_TONE[s]}>{t(`wi.sev.${s}`)} {n}</Pill>)}
        </div>
      </header>

      {data.coverage.serviceAccounts !== "ok" && <Notice tone="warning">{t("wi.coverage.saForbidden")}</Notice>}
      {data.gaps.length > 0 && (
        <Notice tone="info" title={t("wi.gaps")}>
          <ul className={styles.wiGapList}>{data.gaps.map((g) => <li key={g}>{g}</li>)}</ul>
        </Notice>
      )}
      <p className={styles.wiNote}>{t("wi.coverage.ib")} · {t("wi.coverage.exchange")} · {t("wi.roles.pim")}
        {" · "}{scan.requested ? t("wi.scan.done", { scanned: scan.scanned, total: scan.total ?? "?" }) : (
          <button type="button" className={styles.linkish} onClick={onScan} disabled={scanning}>{t("wi.scan.button", { cap: scan.cap })}</button>
        )}
      </p>

      <div className={styles.wiFindings}>
        <h4 className={styles.wiH}>{t("wi.findings.title")} <span className={styles.wiCount}>{findings.length}</span></h4>
        {findings.length === 0 ? <p className={styles.wiNote}>{t("wi.findings.none")}</p> : (
          <ul className={styles.wiFindList}>
            {findings.map((f: WiFinding) => (
              <li key={f.id} className={styles.wiFind} data-sev={f.sev}>
                <details>
                  <summary onClick={() => setSel(f.refs[0] ?? null)}>
                    <Pill tone={SEV_TONE[f.sev]}>{t(`wi.sev.${f.sev}`)}</Pill>
                    <span className={styles.wiRule}>{f.rule}</span>
                    <span className={styles.wiFindTitle}>{f.title}</span>
                  </summary>
                  <div className={styles.wiFindBody}>
                    <p>{f.detail}</p>
                    <p><strong>{t("wi.finding.fix")}</strong> {f.remediation}</p>
                    {f.code && <CopyCode code={f.code} />}
                    <a className={styles.wiDoc} href={f.docUrl} target="_blank" rel="noreferrer" title={f.docQuote}>{t("wi.finding.doc")} ↗</a>
                    <blockquote className={styles.wiQuote}>“{f.docQuote}”</blockquote>
                  </div>
                </details>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className={styles.wiBar}>
        <Segmented label={t("wi.view")} value={narrow ? "table" : view} onChange={setView}
          items={[{ id: "graph" as View, label: t("wi.view.graph") }, { id: "table" as View, label: t("wi.view.table") }]} />
        {graph.hiddenGroups > 0 && <span className={styles.wiNote}>{t("wi.more", { n: graph.hiddenGroups })}</span>}
      </div>

      {graph.nodes.length === 0 ? <p className={styles.wiNote}>{t("wi.empty")}</p> : (
        <div className={styles.wiLayout} data-open={!!model || undefined}>
          <div ref={boxRef} className={styles.wiCanvasBox}>
            {narrow || view === "table" ? (
              <table className={styles.wiTable} aria-label={t("wi.table.aria")}>
                <thead><tr>{[0, 1, 2, 3, 4].map((c) => <th key={c} scope="col">{t(`wi.col.${c}`)}</th>)}</tr></thead>
                <tbody>
                  {data.serviceAccounts.filter((s) => showSystem || !s.managed).map((s) => {
                    const idn = data.identities.find((i) => i.id === s.identityId);
                    return (
                      <tr key={s.id}>
                        <td>{data.workloads.filter((w) => w.saId === s.id).map((w) => w.name).join(", ") || "-"}</td>
                        <td><button type="button" className={styles.linkish} onClick={() => pick(s.id)}>{s.namespace}/{s.name}</button></td>
                        <td>{s.ficIds.length ? s.ficIds.map((f) => data.fics.find((x) => x.id === f)?.name).join(", ") : <span className={styles.wiMuted}>{s.identityId ? t("wi.noFic") : "-"}</span>}</td>
                        <td>{idn ? <button type="button" className={styles.linkish} onClick={() => pick(idn.id)}>{idn.kind === "unresolved" ? t("wi.unresolved") : idn.name} {idn.kind === "userAssigned" ? `(${ficGauge(idn.fic.count).text})` : ""}</button> : "-"}</td>
                        <td>{idn?.roles.map((r) => `${r.roleName} @ ${r.scope.label}${r.usage?.state === "unused" ? ` (${t("wi.usage.unusedShort", { days: r.usage.days })})` : ""}`).join(" · ") || "-"}</td>
                      </tr>
                    );
                  })}
                  {graph.nodes.filter((n) => n.kind === "pool").map((n) => {
                    const idn = data.identities.find((i) => i.id === n.group);
                    return (
                      <tr key={n.id}>
                        <td>-</td>
                        <td><button type="button" className={styles.linkish} onClick={() => pick(n.id)}>{label(n.id)?.title}</button></td>
                        <td><span className={styles.wiMuted}>{t("wi.imds.path")}</span></td>
                        <td>{idn ? <button type="button" className={styles.linkish} onClick={() => pick(idn.id)}>{idn.name ?? idn.clientIdTail}</button> : "-"}</td>
                        <td>{idn?.roles.map((r) => `${r.roleName} @ ${r.scope.label}${r.usage?.state === "unused" ? ` (${t("wi.usage.unusedShort", { days: r.usage.days })})` : ""}`).join(" · ") || "-"}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            ) : (
              <div className={styles.wiCanvas} style={{ height: layout.height }}>
                <svg className={styles.wiSvg} width={layout.width} height={layout.height} aria-hidden="true">
                  {layout.groups.map((g, i) => <rect key={g.id} className={i % 2 ? styles.laneOdd : styles.laneEven} x={0} y={g.y0} width={layout.width} height={g.y1 - g.y0} rx={8} />)}
                  {layout.edges.map((e) => (
                    <path key={e.key} d={e.d} className={styles.wiEdge} data-kind={e.kind} data-dim={(chain && !(chain.has(e.from) && chain.has(e.to))) || undefined} />
                  ))}
                </svg>
                {layout.cols.map((c, i) => <div key={i} className={styles.wiColHead} style={{ left: c.x, width: c.w }}>{t(`wi.col.${i}`)}</div>)}
                {graph.nodes.map((n) => {
                  const p = layout.nodes.get(n.id)!;
                  const lb = label(n.id)!;
                  const idn = n.kind === "identity" ? data.identities.find((x) => x.id === n.id) : undefined;
                  const g = idn && idn.kind === "userAssigned" ? ficGauge(idn.fic.count, idn.fic.limit) : null;
                  const s = sev.get(n.id);
                  return (
                    <div key={n.id} role="button" tabIndex={0} aria-pressed={sel === n.id}
                      aria-label={`${t(`wi.kicker.${lb.kind}`)} ${lb.title}, ${lb.sub}${s ? `, ${t(`wi.sev.${s}`)}` : ""}`}
                      className={styles.wiCard} data-kind={n.kind} data-sev={s} data-unk={n.unk || undefined}
                      data-dim={(chain && !chain.has(n.id)) || undefined}
                      style={{ left: p.x, top: p.y, width: p.w, height: p.h }}
                      onClick={() => pick(n.id)} onKeyDown={(e) => keyAct(e, n.id)} title={`${lb.title}\n${lb.sub}${lb.extra ? `\n${lb.extra}` : ""}`}>
                      <span className={styles.wiCardTitle}>{lb.title}</span>
                      <span className={styles.wiCardSub}>{lb.sub}</span>
                      {g && (
                        <span className={styles.wiGauge} data-tone={g.tone} title={t("wi.gauge.label")}>
                          <span className={styles.wiGaugeBar}><span style={{ width: `${g.ratio * 100}%` }} /></span>
                          <span>{g.text}</span>
                        </span>
                      )}
                      {lb.extra && !g && <span className={styles.wiCardExtra}>{lb.extra}</span>}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
          {model && (
            <aside className={styles.wiDrawer}>
              <Inspector model={model} onClose={() => setSel(null)} />
            </aside>
          )}
        </div>
      )}
      {!narrow && view === "graph" && graph.nodes.length > 0 && (
        <ul className={styles.wiLegend}>
          <li><i data-kind="uses" />{t("wi.legend.uses")}</li>
          <li><i data-kind="federated" />{t("wi.legend.federated")}</li>
          <li><i data-kind="annotatedOnly" />{t("wi.legend.annotatedOnly")}</li>
          <li><i data-kind="imds" />{t("wi.legend.imds")}</li>
          <li><i data-kind="assigned" />{t("wi.legend.assigned")}</li>
          <li><Button size="sm" variant="ghost" onClick={() => setSel(null)} disabled={!sel}>{t("wi.clearSel")}</Button></li>
        </ul>
      )}
      <OtherWorkloads data={data} showSystem={showSystem} />
    </section>
  );
}

/** "사용 1,234회 · 마지막 10/28" / "30일간 사용 없음 (같은 범위 요청 5,210건)" / "확인 불가 — 이유" */
function usageText(u: WiRoleUsage, t: (k: string, v?: Record<string, string | number>) => string, locale: Locale): string {
  if (u.state === "used") return t("wi.usage.used", { n: (u.requests ?? 0).toLocaleString(dateLocale(locale)), days: u.days, last: u.last ? new Date(u.last).toLocaleDateString(dateLocale(locale)) : "—" });
  if (u.state === "unused") return t("wi.usage.unused", { days: u.days, total: (u.logsInScope ?? 0).toLocaleString(dateLocale(locale)) });
  return t(`wi.usage.unknown.${u.reason ?? "failed"}`, { days: u.days });
}
