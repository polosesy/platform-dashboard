"use client";

// 알림 센터 — the dashboard is the receiver: Azure Monitor (action group webhook, common alert schema) and Grafana
// Alerting / Alertmanager deliver here, so people see alerts without a messenger webhook (Slack · Teams · Google Chat).
// Tabs: received alerts (inbox) · feature mapping (which source feeds which category, which screen it opens) · setup.

import { Suspense, useCallback, useMemo, useState } from "react";
import Link from "next/link";
import type { NotificationsResponse, NotifyAlert, NotifyReceiverInfo } from "@aud/types";
import { ApiError, apiUrl, fetchJsonWithBearer } from "@/lib/api";
import { dateLocale, useI18n } from "@/lib/i18n";
import { useApiQuery } from "@/lib/useApiQuery";
import { useApiToken } from "@/lib/useApiToken";
import { usePolling } from "@/lib/usePolling";
import { useQueryParam } from "@/lib/useQueryParam";
import { Badge, Button, EmptyState, ErrorNotice, LoadingState, Notice, PageHeader, Panel, Segmented, Select, Stat, Tabs, Toggle } from "@/components/ui";
import { CATEGORIES, DEFAULT_FILTER, MAPPING, SEVERITIES, azureSnippet, filterInbox, grafanaSnippet, receiverUrls, targetText, teamsOf, type InboxFilter } from "@/lib/notifyView";
import { DesktopToggle } from "./DesktopToggle";
import s from "./notifications.module.css";

const TABS = ["inbox", "mapping", "setup"] as const;
type Tab = (typeof TABS)[number];
const SEV_TONE = { sev1: "high", sev2: "medium", sev3: "low", sev4: "info" } as const;

export default function NotificationsPage() {
  return (
    <Suspense fallback={<LoadingState />}>
      <NotificationsInner />
    </Suspense>
  );
}

function NotificationsInner() {
  const { t } = useI18n();
  const [tab, setTab] = useQueryParam<Tab>("tab", TABS, "inbox");
  const q = useApiQuery<NotificationsResponse>("notifications", (token) => fetchJsonWithBearer(apiUrl("/api/notifications", { status: "all", limit: 1000 }), token));
  const reload = q.reload;
  usePolling(useCallback(async () => { reload(); }, [reload]), 30_000);

  return (
    <>
      <PageHeader meta={q.data ? <DesktopToggle /> : null} />
      <Tabs label={t("nav.item.notifications")} idPrefix="notify-tab" value={tab} onChange={setTab}
        items={TABS.map((id) => ({ id, label: t(`notify.tab.${id}`), count: id === "inbox" ? q.data?.counts.firingUnacked : undefined }))} />
      {tab === "inbox" && (q.error ? <ErrorNotice error={q.error} /> : !q.data ? <LoadingState /> : <Inbox data={q.data} reload={reload} />)}
      {tab === "mapping" && <Mapping />}
      {tab === "setup" && <Setup data={q.data ?? null} reload={reload} />}
    </>
  );
}

function when(iso: string | undefined, locale: string) {
  if (!iso) return "";
  return new Date(iso).toLocaleString(dateLocale(locale as "ko" | "en"), { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function Inbox({ data, reload }: { data: NotificationsResponse; reload: () => void }) {
  const { t, locale } = useI18n();
  const [f, setF] = useState<InboxFilter>(DEFAULT_FILTER);
  const [open, setOpen] = useState<string | null>(null);
  const items = useMemo(() => filterInbox(data.items, f), [data.items, f]);
  const teams = useMemo(() => teamsOf(data.items), [data.items]);
  const set = (p: Partial<InboxFilter>) => setF({ ...f, ...p });

  return (
    <div className={s.stack}>
      {!data.receiverEnabled ? <Notice tone="info" title={t("notify.receiverOff.title")}>{t("notify.receiverOff.body")}</Notice> : null}
      {!data.durable ? <Notice tone="warning">{t("notify.memory")}</Notice> : null}
      <div className={s.stats}>
        <Stat label={t("notify.stat.firing")} value={data.counts.firing} hint={t("notify.stat.unacked", { n: data.counts.firingUnacked })} tone={data.counts.firingUnacked ? "high" : undefined} />
        <Stat label={t("notify.stat.urgent")} value={data.counts.bySeverity.sev1 + data.counts.bySeverity.sev2} hint={`SEV1 ${data.counts.bySeverity.sev1} · SEV2 ${data.counts.bySeverity.sev2}`} tone={data.counts.bySeverity.sev1 ? "high" : undefined} />
        {CATEGORIES.map((c) => <Stat key={c} label={t(`notify.cat.${c}`)} value={data.counts.byCategory[c]} hint={t("notify.stat.firingOnly")} />)}
      </div>
      <Panel title={t("notify.inbox.title")} sub={t("notify.inbox.count", { n: items.length, total: data.items.length })} flush
        actions={
          <div className={s.filters}>
            <Segmented label={t("notify.filter.category")} value={f.category} onChange={(v) => set({ category: v })}
              items={[{ id: "all" as const, label: t("notify.all") }, ...CATEGORIES.map((c) => ({ id: c, label: t(`notify.cat.${c}`) }))]} />
            <Select label={t("notify.filter.status")} hideLabel value={f.status} onChange={(v) => set({ status: v as InboxFilter["status"] })}
              options={(["firing", "resolved", "all"] as const).map((v) => ({ value: v, label: t(`notify.status.${v}`) }))} />
            <Select label={t("notify.filter.severity")} hideLabel value={f.severity} onChange={(v) => set({ severity: v as InboxFilter["severity"] })}
              options={[{ value: "all", label: t("notify.filter.allSev") }, ...SEVERITIES.map((v) => ({ value: v, label: t(`notify.sev.${v}`) }))]} />
            {teams.length ? (
              <Select label={t("notify.filter.team")} hideLabel value={f.team} onChange={(v) => set({ team: v })}
                options={[{ value: "all", label: t("notify.filter.allTeams") }, ...teams.map((x) => ({ value: x, label: x })), { value: "none", label: t("notify.filter.noTeam") }]} />
            ) : null}
            <Toggle checked={f.unackedOnly} onChange={(v) => set({ unackedOnly: v })}>{t("notify.filter.unacked")}</Toggle>
            <input className={s.search} value={f.q} onChange={(e) => set({ q: e.target.value })} placeholder={t("notify.filter.search")} aria-label={t("notify.filter.search")} />
          </div>
        }>
        {items.length ? (
          <ul className={s.list}>
            {items.map((a) => (
              <li key={a.id} className={s.item} data-status={a.status} data-sev={a.severity}>
                <button type="button" className={s.row} aria-expanded={open === a.id} onClick={() => setOpen(open === a.id ? null : a.id)}>
                  <span className={s.sevBar} aria-hidden />
                  <Badge tone={SEV_TONE[a.severity]}>{t(`notify.sev.${a.severity}`)}</Badge>
                  <span className={s.main}>
                    <b>{a.title}</b>
                    <span className={s.sub}>
                      {targetText(a) || "—"}{a.summary ? ` · ${a.summary}` : ""}
                    </span>
                  </span>
                  <span className={s.meta}>
                    <span className={s.chip}>{t(`notify.cat.${a.category}`)}</span>
                    {a.team ? <span className={s.chip}>{a.team}</span> : null}
                    <span className={s.chip}>{t(`notify.src.${a.source}`)}</span>
                    {a.received > 1 ? <span className={s.muted}>×{a.received}</span> : null}
                    <span className={s.status} data-status={a.status}>{t(`notify.status.${a.status}`)}</span>
                    {a.ack ? <span className={s.ack}>✓ {a.ack.by}</span> : null}
                    <span className={s.muted}>{when(a.status === "resolved" ? a.endsAt : a.startsAt, locale)}</span>
                  </span>
                </button>
                {open === a.id ? <Detail a={a} canWrite={data.canWrite} reload={reload} /> : null}
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState title={data.items.length ? t("notify.inbox.noneFiltered") : t("notify.inbox.none")}>
            {data.items.length ? null : t("notify.inbox.noneHint")}
          </EmptyState>
        )}
      </Panel>
    </div>
  );
}

function Detail({ a, canWrite, reload }: { a: NotifyAlert; canWrite: boolean; reload: () => void }) {
  const { t, locale } = useI18n();
  const getToken = useApiToken();
  const [note, setNote] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const ack = async (on: boolean) => {
    try {
      const token = await getToken().catch(() => null);
      await fetchJsonWithBearer(apiUrl("/api/notifications/ack", { id: a.id }), token, { method: "PUT", body: JSON.stringify({ ack: on, ...(note.trim() ? { note: note.trim() } : {}) }) });
      setErr(null); setNote(""); reload();
    } catch (e) { setErr(e instanceof ApiError && e.code ? e.code : String(e)); }
  };
  const target = Object.entries(a.target).filter(([k, v]) => v && k !== "subscriptionId" && k !== "resourceId");
  const linkLabel = (l: NotifyAlert["links"][number]) => (l.url.startsWith("/") ? t(l.label) : t(`notify.link.${l.kind}`));
  return (
    <div className={s.detail}>
      <div className={s.detailGrid}>
        <div>
          {a.summary ? <p className={s.summary}>{a.summary}</p> : null}
          {a.description && a.description !== a.summary ? <pre className={s.desc}>{a.description}</pre> : null}
          {a.values ? <div className={s.kv}>{Object.entries(a.values).map(([k, v]) => <span key={k} className={s.chip}>{k} = {v}</span>)}</div> : null}
          <div className={s.links}>
            {a.links.map((l) => l.url.startsWith("/")
              ? <Link key={l.url} href={l.url} className={s.link}>{linkLabel(l)} →</Link>
              : <a key={l.url} href={l.url} target="_blank" rel="noreferrer noopener" className={s.link} title={l.url}>{linkLabel(l)} ↗</a>)}
          </div>
          {a.links.some((l) => l.kind === "portal") ? <p className={s.muted}>{t("notify.portalNote")}</p> : null}
        </div>
        <dl className={s.facts}>
          {target.map(([k, v]) => <div key={k}><dt>{t(`notify.target.${k}`)}</dt><dd className={s.mono}>{String(v)}</dd></div>)}
          <div><dt>{t("notify.fact.rule")}</dt><dd className={s.mono}>{a.rule}</dd></div>
          {a.service ? <div><dt>{t("notify.fact.service")}</dt><dd>{a.service}</dd></div> : null}
          <div><dt>{t("notify.fact.category")}</dt><dd>{t(`notify.cat.${a.category}`)} <span className={s.muted}>({t(`notify.basis.${a.categoryBasis}`)})</span></dd></div>
          <div><dt>{t("notify.fact.since")}</dt><dd>{when(a.startsAt, locale)}{a.endsAt ? ` → ${when(a.endsAt, locale)}` : ""}</dd></div>
          <div><dt>{t("notify.fact.received")}</dt><dd>{t("notify.fact.receivedText", { n: a.received, r: a.refired, at: when(a.lastReceivedAt, locale) })}</dd></div>
          {a.relay ? <div><dt>{t("notify.fact.relay")}</dt><dd>{a.relay.ok ? t("notify.relay.ok") : t("notify.relay.failed", { s: a.relay.status ?? "—" })}</dd></div> : null}
        </dl>
      </div>
      {Object.keys(a.labels).length ? <div className={s.kv}>{Object.entries(a.labels).map(([k, v]) => <span key={k} className={s.label}>{k}={v}</span>)}</div> : null}
      <div className={s.history}>
        {a.history.slice(0, 6).map((h, i) => <span key={i} className={s.muted}>{when(h.at, locale)} · {h.note ?? t(`notify.status.${h.status}`)}{h.by ? ` · ${h.by}` : ""}</span>)}
      </div>
      {canWrite ? (
        <div className={s.ackRow}>
          {a.ack ? (
            <Button size="sm" onClick={() => void ack(false)}>{t("notify.unack")}</Button>
          ) : (
            <>
              <input className={s.search} value={note} maxLength={300} onChange={(e) => setNote(e.target.value)} placeholder={t("notify.ackNote")} aria-label={t("notify.ackNote")} />
              <Button size="sm" variant="primary" onClick={() => void ack(true)}>{t("notify.ack")}</Button>
            </>
          )}
          {err ? <span className={s.err}>{err}</span> : null}
        </div>
      ) : null}
    </div>
  );
}

function Mapping() {
  const { t } = useI18n();
  return (
    <div className={s.stack}>
      <p className={s.lead}>{t("notify.map.lead")}</p>
      <div className={s.mapGrid}>
        {MAPPING.map((m) => (
          <Panel key={m.category} title={t(`notify.cat.${m.category}`)} sub={t(`notify.map.desc.${m.category}`)}>
            <ul className={s.mapList}>
              {m.sources.map((src) => <li key={src}><b>{t(`notify.map.src.${src}`)}</b><span className={s.muted}>{t(`notify.map.how.${src}`)}</span></li>)}
            </ul>
            <div className={s.links}>
              {m.screens.map((x) => <Link key={x.href} href={x.href} className={s.link}>{t(x.labelKey)} →</Link>)}
            </div>
          </Panel>
        ))}
      </div>
      <Panel title={t("notify.map.rules")}>
        <ol className={s.rules}>
          {(["label", "service", "name", "severity", "default"] as const).map((b) => <li key={b}><b>{t(`notify.basis.${b}`)}</b> — {t(`notify.map.rule.${b}`)}</li>)}
        </ol>
        <p className={s.muted}>{t("notify.map.sevRule")}</p>
      </Panel>
    </div>
  );
}

function Setup({ data, reload }: { data: NotificationsResponse | null; reload: () => void }) {
  const { t } = useI18n();
  const getToken = useApiToken();
  const info = useApiQuery<NotifyReceiverInfo>("notify-receiver", (token) => fetchJsonWithBearer(apiUrl("/api/notifications/receiver"), token));
  const origin = typeof window === "undefined" ? "" : window.location.origin;
  const urls = receiverUrls(origin);
  const [msg, setMsg] = useState<string | null>(null);
  const test = async (kind: "azure" | "grafana") => {
    try {
      const token = await getToken().catch(() => null);
      await fetchJsonWithBearer(apiUrl("/api/notifications/test", { kind }), token, { method: "POST" });
      setMsg(t("notify.setup.testSent")); reload();
    } catch (e) { setMsg(e instanceof ApiError && e.code ? e.code : String(e)); }
  };
  const copy = (text: string) => { void navigator.clipboard?.writeText(text); setMsg(t("notify.setup.copied")); };
  const i = info.data;
  return (
    <div className={s.stack}>
      <Panel title={t("notify.setup.status")}>
        {info.error ? <Notice tone="info">{t("notify.setup.adminOnly")}</Notice> : !i ? <LoadingState /> : (
          <dl className={s.facts}>
            <div><dt>{t("notify.setup.receiver")}</dt><dd>{i.enabled ? t("notify.setup.on", { hint: i.tokenHint ?? "" }) : t("notify.setup.off")}</dd></div>
            <div><dt>{t("notify.setup.store")}</dt><dd>{i.durable ? t("notify.setup.durable", { d: i.retentionDays }) : t("notify.memory")}</dd></div>
            <div><dt>{t("notify.setup.relay")}</dt><dd>{i.relay.configured ? t("notify.setup.relayOn", { host: i.relay.host ?? "", sev: t(`notify.sev.${i.relay.minSeverity}`) }) : t("notify.setup.relayOff")}</dd></div>
          </dl>
        )}
        {data?.canWrite ? (
          <div className={s.ackRow}>
            <Button size="sm" onClick={() => void test("azure")}>{t("notify.setup.testAzure")}</Button>
            <Button size="sm" onClick={() => void test("grafana")}>{t("notify.setup.testGrafana")}</Button>
            {msg ? <span className={s.muted}>{msg}</span> : null}
          </div>
        ) : null}
      </Panel>
      <div className={s.mapGrid}>
        <Panel title={t("notify.setup.azure")} sub={t("notify.setup.azureSub")}>
          <ol className={s.rules}>{[1, 2, 3, 4].map((n) => <li key={n}>{t(`notify.setup.azureStep${n}`)}</li>)}</ol>
          <div className={s.urlRow}><code className={s.mono}>{urls.azure}</code><Button size="sm" onClick={() => copy(urls.azure)}>{t("notify.setup.copy")}</Button></div>
          <pre className={s.code}>{azureSnippet(origin)}</pre>
        </Panel>
        <Panel title={t("notify.setup.grafana")} sub={t("notify.setup.grafanaSub")}>
          <ol className={s.rules}>{[1, 2, 3, 4].map((n) => <li key={n}>{t(`notify.setup.grafanaStep${n}`)}</li>)}</ol>
          <div className={s.urlRow}><code className={s.mono}>{urls.grafana}</code><Button size="sm" onClick={() => copy(urls.grafana)}>{t("notify.setup.copy")}</Button></div>
          <pre className={s.code}>{grafanaSnippet(origin)}</pre>
        </Panel>
      </div>
      <Panel title={t("notify.setup.network")}>
        <ul className={s.rules}>{[1, 2, 3, 4].map((n) => <li key={n}>{t(`notify.setup.net${n}`)}</li>)}</ul>
      </Panel>
    </div>
  );
}
