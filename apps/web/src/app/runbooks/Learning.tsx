"use client";

// 사례·런북 — §10 B·C·D and §11: the changes near a case's time (변경 상관), its read-only evidence snapshots (증거),
// the public case library and the engineering blogs the team watches (외부 학습). Facts with their reasons — no
// probability, no score.

import { useState } from "react";
import type { OpsCase, OpsChangesResponse, OpsFeedItem, OpsFeedsResponse, OpsKnowledgeResponse } from "@aud/types";
import { apiUrl, fetchJsonWithBearer } from "@/lib/api";
import { useApiQuery } from "@/lib/useApiQuery";
import { dateLocale, useI18n } from "@/lib/i18n";
import { changeOffset, feedItemPrefill, type CaseForm } from "@/lib/opsKnowledge";
import { Badge, Button, Chip, ErrorNotice, LinkButton, Notice, Panel, Segmented, TextInput } from "@/components/ui";
import { StatusChip, errText, useOpsCall } from "./shared";
import s from "./runbooks.module.css";

const MATCH_LEVEL = { workload: "danger", namespace: "warn", cluster: "neutral" } as const;

/** 변경 상관: what changed in the case's cluster in the 2 hours before it (and 10 min after) — nearest scope first */
export function ChangesSection({ c }: { c: OpsCase }) {
  const { t, locale } = useI18n();
  const q = useApiQuery(c.scope.clusterId ? `ops-changes:${c.id}:${c.occurredAt}` : null, (token) =>
    fetchJsonWithBearer<OpsChangesResponse>(apiUrl("/api/ops/changes", { clusterId: c.scope.clusterId!, at: c.occurredAt, namespace: c.scope.namespace || undefined, workload: c.scope.workload || undefined }), token));
  if (!c.scope.clusterId) return null;
  const d = q.data;
  const when = (iso: string) => new Date(iso).toLocaleString(dateLocale(locale));
  return (
    <div className={s.section}>
      <h3>{t("ops.chg.title")}</h3>
      {q.error ? <ErrorNotice error={q.error} /> : !d ? <p className={s.muted}>{t("ops.chg.loading")}</p> : (
        <>
          <p className={s.sub}>
            {t("ops.chg.window", { m: d.windowMinutes })} · {(["rollouts", "nodeMaintenance", "warningEvents"] as const).map((k) => `${t(`ops.chg.src.${k}`)} ${d.sources[k] === "ok" ? d.counts[k] : t(`ops.chg.state.${d.sources[k]}`)}`).join(" · ")}
          </p>
          {d.changes.length ? (
            <ul className={s.list}>
              {d.changes.slice(0, 12).map((x, i) => (
                <li key={i} className={s.item}>
                  <div className={s.itemHead}>
                    <Chip level={MATCH_LEVEL[x.match]} glyph={false}>{t(`ops.chg.match.${x.match}`)}</Chip>
                    <span className={s.sub}>{t(`ops.chg.kind.${x.kind}`)} · {t("ops.chg.offset", { m: changeOffset(x) })}</span>
                    <strong>{x.title}</strong>
                  </div>
                  <span className={s.sub}>{when(x.at)}{x.end !== undefined ? ` → ${x.end ? when(x.end) : t("ops.chg.running")}` : ""}{x.detail ? ` · ${x.detail}` : ""}</span>
                </li>
              ))}
            </ul>
          ) : <p className={s.muted}>{t("ops.chg.none")}</p>}
          <p className={s.sub}>{t("ops.chg.note")}</p>
        </>
      )}
    </div>
  );
}

/** 증거 스냅샷: what was read when the case started (and on request) — read-only, kept across edits */
export function EvidenceSection({ c, canWrite, onChanged }: { c: OpsCase; canWrite: boolean; onChanged: () => void }) {
  const { t, locale } = useI18n();
  const call = useOpsCall();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const take = async () => {
    setBusy(true); setErr(null);
    try { await call("POST", "/api/ops/cases/evidence", { id: c.id }); onChanged(); } catch (e) { setErr(errText(t, e)); } finally { setBusy(false); }
  };
  if (!c.scope.clusterId && !c.evidence?.length) return null;
  const when = (iso: string) => new Date(iso).toLocaleString(dateLocale(locale));
  return (
    <div className={s.section}>
      <h3>{t("ops.ev.title", { n: c.evidence?.length ?? 0 })}</h3>
      {(c.evidence ?? []).slice().reverse().map((e) => (
        <details key={e.takenAt} className={s.evidence} open={e === c.evidence![c.evidence!.length - 1]}>
          <summary>{t("ops.ev.taken", { at: when(e.takenAt), by: e.takenBy ?? "—", case: when(e.at) })}</summary>
          {e.sections.map((x) => (
            <div key={x.kind} className={s.evidenceSection}>
              <div className={s.itemHead}>
                <strong>{t(`ops.ev.kind.${x.kind}`)}</strong>
                <Chip level={x.state === "ok" ? "ok" : x.state === "failed" ? "danger" : "unknown"}>{t(`ops.ev.state.${x.state}`)}</Chip>
                {x.note ? <span className={s.sub}>{x.note}</span> : null}
              </div>
              {x.lines.length ? <pre className={s.evidenceLines}>{x.lines.join("\n")}</pre> : null}
            </div>
          ))}
        </details>
      ))}
      {canWrite && c.scope.clusterId ? <div className={s.actions}><Button size="sm" onClick={() => void take()} disabled={busy}>{t("ops.ev.take")}</Button><span className={s.sub}>{t("ops.ev.hint")}</span></div> : null}
      {err ? <Notice tone="danger">{err}</Notice> : null}
    </div>
  );
}

/** 외부 학습: the bundled public cases and the watched blogs' posts — a post can become a case (reviewed first) */
export function LearnView({ data, canWrite, onRecord }: { data: OpsKnowledgeResponse; canWrite: boolean; onRecord: (form: Partial<CaseForm>, itemId: string) => void }) {
  const { t, locale } = useI18n();
  const call = useOpsCall();
  const q = useApiQuery("ops-feeds", (token) => fetchJsonWithBearer<OpsFeedsResponse>(apiUrl("/api/ops/feeds"), token));
  const [open, setOpen] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [kind, setKind] = useState<"blog" | "status">("blog");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [onlyIncident, setOnlyIncident] = useState(true);
  const f = q.data;
  const when = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString(dateLocale(locale)) : "—");
  const lib = data.library ?? [];
  const save = async (feeds: Array<{ name: string; url: string; kind?: string }>) => {
    if (!f) return;
    setBusy(true); setErr(null);
    try { await call("PUT", "/api/ops/feeds", {}, { feeds, baseRev: f.rev }); setName(""); setUrl(""); await q.reload(); }
    catch (e) { setErr(errText(t, e)); } finally { setBusy(false); }
  };
  const current = () => (f?.feeds ?? []).map((x) => ({ name: x.name, url: x.url, kind: x.kind ?? "blog" }));
  // vendor incidents going on now (a status page's latest update is not resolved) — check them first in an incident
  const openNow = (f?.items ?? []).filter((i) => i.open);
  const decide = async (it: OpsFeedItem, decision: "ignored" | null) => {
    try { await call("PUT", "/api/ops/feeds/item", {}, { id: it.id, decision }); await q.reload(); } catch (e) { setErr(errText(t, e)); }
  };
  const check = async () => {
    setBusy(true); setErr(null);
    try { await call("POST", "/api/ops/feeds/check", {}); await q.reload(); } catch (e) { setErr(errText(t, e)); } finally { setBusy(false); }
  };
  const feedName = (id: string) => f?.feeds.find((x) => x.id === id)?.name ?? "";
  const items = (f?.items ?? []).filter((i) => !onlyIncident || i.candidate);
  return (
    <div className={s.stack}>
      <Panel title={t("ops.learn.lib.title", { n: lib.length })} sub={t("ops.learn.lib.sub")} flush>
        <ul className={s.list}>
          {lib.map((c) => (
            <li key={c.id} className={s.item}>
              <div className={s.itemHead}>
                <LinkButton ariaExpanded={open === c.id} onClick={() => setOpen(open === c.id ? null : c.id)}>{c.title}</LinkButton>
                <StatusChip t={t} status={c.status} />
                <span className={s.sub}>{c.reference?.org} · {when(c.occurredAt)}{c.tags.includes("partially-confirmed") ? ` · ${t("ops.learn.partial")}` : ""}</span>
              </div>
              {open === c.id ? (
                <div className={s.section}>
                  {[["symptoms", c.symptoms], ["cause", c.cause], ["resolution", c.resolution], ["lessons", c.lessons]].filter(([, v]) => v).map(([k, v]) => (
                    <p key={k} className={s.fix}><b>{t(`ops.kb.f.${k}`)}</b> {v}</p>
                  ))}
                  <div className={s.tags}>{c.signals.map((x) => <span key={x.value} className={s.sub}>#{x.value}</span>)}</div>
                  {c.reference ? <a href={c.reference.url} target="_blank" rel="noreferrer noopener">{t("ops.learn.original")} ↗</a> : null}
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      </Panel>

      <Panel title={t("ops.learn.feeds.title")} sub={f ? (f.enabled ? t("ops.learn.feeds.sub", { h: Math.round(f.intervalSec / 360) / 10, at: f.lastCheckAt ? new Date(f.lastCheckAt).toLocaleString(dateLocale(locale)) : "—" }) : t("ops.learn.feeds.off")) : undefined}
        actions={f?.canWrite && f.feeds.length ? <Button size="sm" onClick={() => void check()} disabled={busy}>{t("ops.learn.feeds.check")}</Button> : undefined}>
        {q.error ? <ErrorNotice error={q.error} /> : null}
        {err ? <Notice tone="danger">{err}</Notice> : null}
        {f ? (
          <>
            {f.feeds.length ? (
              <ul className={s.list}>
                {f.feeds.map((x) => (
                  <li key={x.id} className={s.item}>
                    <div className={s.itemHead}>
                      <strong>{x.name}</strong>
                      <Badge tone={x.kind === "rca" ? "high" : x.kind === "status" ? "info" : "neutral"}>{t(`ops.learn.kind.${x.kind ?? "blog"}`)}</Badge>
                      <Chip level={x.state === "ok" ? "ok" : x.state === "failed" ? "danger" : "unknown"}>{t(`ops.learn.feeds.state.${x.state}`)}</Chip>
                      <span className={s.sub}>{x.url} · {t("ops.learn.feeds.items", { n: x.items })}{x.state === "failed" && x.detail ? ` · ${x.detail}` : ""}</span>
                      {f.canWrite ? <LinkButton tone="muted" onClick={() => void save(current().filter((y) => y.url !== x.url))}>{t("ops.learn.feeds.remove")}</LinkButton> : null}
                    </div>
                  </li>
                ))}
              </ul>
            ) : <p className={s.muted}>{t("ops.learn.feeds.empty")}</p>}
            {f.canWrite ? (
              <>
                <div className={s.actions}>
                  <TextInput label={t("ops.learn.feeds.name")} value={name} onChange={setName} maxLength={60} width={200} />
                  <TextInput label={t("ops.learn.feeds.url")} value={url} onChange={setUrl} placeholder="https://…/feed.xml" width={360} />
                  <Segmented label={t("ops.learn.feeds.kind")} value={kind} onChange={setKind} items={[{ id: "blog", label: t("ops.learn.kind.blog") }, { id: "status", label: t("ops.learn.kind.status") }]} />
                  <Button onClick={() => void save([...current(), { name, url, kind }])} disabled={busy || !name.trim() || !url.trim()}>{t("ops.learn.feeds.add")}</Button>
                </div>
                <p className={s.sub}>{t("ops.learn.feeds.presets")}</p>
                {(["rca", "status", "blog"] as const).map((k) => {
                  const left = f.presets.filter((p) => p.kind === k && !f.feeds.some((x) => x.url === p.url));
                  return left.length ? (
                    <div key={k} className={s.tags}>
                      <span className={s.sub}>{t(`ops.learn.kind.${k}`)}:</span>
                      {left.map((p) => <LinkButton key={p.url} title={p.note} onClick={() => void save([...current(), { name: p.name, url: p.url, kind: p.kind }])}>+ {p.name}</LinkButton>)}
                    </div>
                  ) : null;
                })}
                <p className={s.sub}>{t("ops.learn.feeds.guard")}</p>
              </>
            ) : null}
          </>
        ) : null}
      </Panel>

      {openNow.length ? (
        <Panel title={t("ops.learn.open.title", { n: openNow.length })} sub={t("ops.learn.open.sub")} flush level="warn">
          <ul className={s.list}>
            {openNow.map((it) => (
              <li key={it.id} className={s.item}>
                <div className={s.itemHead}>
                  <a href={it.url} target="_blank" rel="noreferrer noopener">{it.title}</a>
                  <span className={s.sub}>{feedName(it.feedId)} · {when(it.publishedAt)}</span>
                </div>
              </li>
            ))}
          </ul>
        </Panel>
      ) : null}

      {f && f.items.length ? (
        <Panel title={t("ops.learn.items.title", { n: items.length })} sub={t("ops.learn.items.sub")} flush
          actions={<LinkButton onClick={() => setOnlyIncident(!onlyIncident)}>{onlyIncident ? t("ops.learn.items.all") : t("ops.learn.items.onlyIncident")}</LinkButton>}>
          <ul className={s.list}>
            {items.slice(0, 80).map((it) => (
              <li key={it.id} className={s.item}>
                <div className={s.itemHead}>
                  <a href={it.url} target="_blank" rel="noreferrer noopener">{it.title}</a>
                  <span className={s.sub}>{feedName(it.feedId)} · {when(it.publishedAt)} · {t("ops.learn.items.seen", { at: when(it.firstSeenAt) })}</span>
                  {it.itemKind && it.itemKind !== "post" ? <Badge tone={it.itemKind === "rca" ? "high" : it.itemKind === "incident" ? (it.open ? "medium" : "info") : "neutral"}>{t(`ops.learn.itemKind.${it.itemKind}`)}{it.open ? ` · ${t("ops.learn.open.now")}` : ""}</Badge> : null}
                  {it.candidate && it.candidateBasis !== "rcaSource" && it.candidateBasis !== "statusIncident" ? <Badge tone="medium">{t(`ops.learn.items.basis.${it.candidateBasis ?? "title"}`)}</Badge> : null}
                  {it.matched.length ? <span className={s.sub}>{t("ops.learn.items.words", { w: it.matched.slice(0, 4).join(", ") })}</span> : null}
                  {it.decision ? <Chip level={it.decision === "case" ? "ok" : "neutral"}>{t(`ops.learn.items.decision.${it.decision}`)}</Chip> : null}
                </div>
                {it.summary ? <p className={s.sub}>{it.summary.slice(0, 240)}</p> : null}
                {f.canWrite && !it.decision ? (
                  <div className={s.actions}>
                    <LinkButton onClick={() => onRecord(feedItemPrefill(it, feedName(it.feedId)), it.id)}>{t("ops.learn.items.record")}</LinkButton>
                    <LinkButton tone="muted" onClick={() => void decide(it, "ignored")}>{t("ops.learn.items.skip")}</LinkButton>
                  </div>
                ) : f.canWrite && it.decision === "ignored" ? <LinkButton tone="muted" onClick={() => void decide(it, null)}>{t("ops.learn.items.undo")}</LinkButton> : null}
              </li>
            ))}
          </ul>
        </Panel>
      ) : null}
    </div>
  );
}
