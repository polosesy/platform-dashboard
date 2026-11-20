"use client";

// 알림·대응 › 사례·런북 — the team's experience (docs/architecture/ops-knowledge.md). Find (default): paste an error or
// come from an alert → the signals in it → the experience helper (runbooks the similar cases used, their first steps)
// → similar cases (why, and what fixed them) → similar runbooks → "record this as a case". Cases and runbooks: lists,
// details and the forms (operators). Experience is shown as experience: the operator decides, commands are copied only.

import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import type { OpsAgentStatus, OpsCase, OpsKnowledgeResponse, OpsRunbook, OpsSimilarResponse } from "@aud/types";
import { apiUrl, fetchJsonWithBearer } from "@/lib/api";
import { dateLocale, useI18n } from "@/lib/i18n";
import { useApiQuery } from "@/lib/useApiQuery";
import { useQueryParam } from "@/lib/useQueryParam";
import { useAksClusters } from "@/lib/useAksClusters";
import {
  Button, Chip, EmptyState, ErrorNotice, LinkButton, LoadingState, Notice, PageHeader, Panel, SearchInput, Segmented, SignInNotice, Tabs, TextInput, Toggle,
} from "@/components/ui";
import {
  caseBody, caseForm, emptyCase, emptyRunbook, excerpt, filterCases, filterRunbooks, followUpStats, runbookForm, toggleFollowUp, type CaseForm, type RunbookForm, isLibraryCase, withLibrary } from "@/lib/opsKnowledge";
import { CaseEditor, RunbookEditor } from "./Editors";
import { RecurrenceView } from "./RecurrenceView";
import { ChangesSection, EvidenceSection, LearnView } from "./Learning";
import { DetailSection, MatchWhy, SevBadge, SignalChips, SignalRows, StatusChip, StepList, errText, useOpsCall } from "./shared";
import s from "./runbooks.module.css";

const TABS = ["find", "recurrence", "cases", "runbooks", "learn"] as const;
type Tab = (typeof TABS)[number];

export default function RunbooksPage() {
  return (
    <Suspense fallback={<LoadingState />}>
      <RunbooksInner />
    </Suspense>
  );
}

type Editing = { kind: "case"; id: string | null; rev: number | null; form: CaseForm } | { kind: "runbook"; id: string | null; rev: number | null; form: RunbookForm } | null;

function RunbooksInner() {
  const { t } = useI18n();
  const params = useSearchParams();
  const [tab, setTab] = useQueryParam("tab", TABS, "find");
  const q = useApiQuery("ops-knowledge", (token) => fetchJsonWithBearer<OpsKnowledgeResponse>(apiUrl("/api/ops/knowledge"), token));
  const { clusters } = useAksClusters();
  const [editing, setEditing] = useState<Editing>(null);
  // ?tab=cases&id= / ?tab=runbooks&id= (the alert centre's "past cases" links) open that one
  const [selCase, setSelCase] = useState<string | null>(params.get("tab") === "cases" ? params.get("id") : null);
  const [selRunbook, setSelRunbook] = useState<string | null>(params.get("tab") === "runbooks" ? params.get("id") : null);
  const [saved, setSaved] = useState<string | null>(null);
  const d = q.data;
  const canWrite = !!d?.canWrite;
  const clusterList = useMemo(() => clusters.map((c) => ({ id: c.id, name: c.name })), [clusters]);

  const openCase = (id: string) => { setSelCase(id); setEditing(null); setTab("cases"); };
  const openRunbook = (id: string) => { setSelRunbook(id); setEditing(null); setTab("runbooks"); };
  const newCase = (prefill: Partial<CaseForm> = {}) => { setEditing({ kind: "case", id: null, rev: null, form: emptyCase(new Date(), prefill) }); setTab("cases"); };
  const newRunbook = (prefill: Partial<RunbookForm> = {}) => { setEditing({ kind: "runbook", id: null, rev: null, form: emptyRunbook(prefill) }); setTab("runbooks"); };
  // 재발 › '비슷한 경험 찾기': the find tab starts over with that text
  const [findSeed, setFindSeed] = useState<string | null>(null);
  const call = useOpsCall();
  // a case started from a blog post: that post is marked "recorded as a case" once the case is saved
  const [fromPost, setFromPost] = useState<string | null>(null);
  const onSaved = (kind: "case" | "runbook", id: string, redactions: number) => {
    // 증거 스냅샷 (§10 C): a new case with a cluster gets the read-only evidence of its moment right away
    if (kind === "case" && editing?.kind === "case" && editing.id === null && editing.form.clusterId) {
      void call("POST", "/api/ops/cases/evidence", { id }).then(() => q.reload(), () => undefined);
    }
    if (kind === "case" && fromPost) { void call("PUT", "/api/ops/feeds/item", {}, { id: fromPost, decision: "case", caseId: id }).catch(() => undefined); setFromPost(null); }
    setEditing(null);
    if (kind === "case") setSelCase(id); else setSelRunbook(id);
    setSaved(redactions ? t("ops.kb.savedMasked", { n: redactions }) : t("ops.kb.saved"));
    q.reload();
  };

  return (
    <div className={s.page}>
      <PageHeader actions={canWrite ? (
        <div className={s.actions}>
          <Button onClick={() => newCase()}>{t("ops.kb.case.new")}</Button>
          <Button onClick={() => newRunbook()}>{t("ops.kb.rb.new")}</Button>
        </div>
      ) : undefined} />
      {d && !d.signedIn ? <SignInNotice /> : null}
      {d && d.signedIn && !d.durable ? <Notice tone="warning" title={t("ops.kb.notDurable")}>{t("ops.kb.notDurableHint")}</Notice> : null}
      {saved ? <Notice tone="success" action={<LinkButton onClick={() => setSaved(null)}>{t("ops.kb.dismiss")}</LinkButton>}>{saved}</Notice> : null}
      <ErrorNotice error={q.error} />
      <Tabs label={t("ops.kb.tabs")} value={tab} onChange={setTab} items={[
        { id: "find", label: t("ops.kb.tab.find") },
        { id: "recurrence", label: t("ops.kb.tab.recurrence") },
        { id: "cases", label: t("ops.kb.tab.cases"), ...(d ? { count: d.cases.length } : {}) },
        { id: "runbooks", label: t("ops.kb.tab.runbooks"), ...(d ? { count: d.runbooks.length } : {}) },
        { id: "learn", label: t("ops.kb.tab.learn"), ...(d?.library ? { count: d.library.length } : {}) },
      ]} />
      {!d && q.loading ? <LoadingState /> : null}
      {d && tab === "find" ? (
        <FindView key={findSeed ?? "url"} data={withLibrary(d)} canWrite={canWrite} initialText={findSeed ?? params.get("q") ?? ""}
          initialScope={{ namespace: params.get("ns") ?? "", workload: params.get("wl") ?? "" }}
          onOpenCase={(id) => (isLibraryCase(id) ? setTab("learn") : openCase(id))} onOpenRunbook={openRunbook}
          onRecord={(text) => newCase({
            title: excerpt(text.split("\n")[0], 120), symptoms: text, alertRule: params.get("rule") ?? "", sourceRef: params.get("alert") ?? "",
            namespace: params.get("ns") ?? "", workload: params.get("wl") ?? "", resourceType: params.get("rt") ?? "",
          })} />
      ) : null}
      {d && tab === "recurrence" ? (
        <RecurrenceView data={d} canWrite={canWrite} onOpenCase={openCase} onOpenRunbook={openRunbook}
          onNewCase={(form) => newCase(form)}
          onNewRunbook={(rule, title) => newRunbook({ title, alertRules: rule, when: t("ops.rec.runbookWhen", { rule }) })}
          onFind={(text) => { setFindSeed(text); setTab("find"); }} />
      ) : null}
      {d && tab === "cases" ? (
        editing?.kind === "case"
          ? <div className={s.stack}><CaseEditor key={editing.id ?? "new"} initial={editing.form} id={editing.id} rev={editing.rev} runbooks={d.runbooks} clusters={clusterList}
              onSaved={(c, n) => onSaved("case", c.id, n)} onCancel={() => setEditing(null)} /></div>
          : <CasesView data={d} canWrite={canWrite} selected={selCase} onSelect={setSelCase} onOpenRunbook={openRunbook}
              onEdit={(c) => setEditing({ kind: "case", id: c.id, rev: c.rev, form: caseForm(c) })} onDeleted={() => { setSelCase(null); q.reload(); }} onChanged={() => q.reload()} />
      ) : null}
      {d && tab === "learn" ? (
        <LearnView data={d} canWrite={canWrite} onRecord={(form, itemId) => { setFromPost(itemId); newCase(form); }} />
      ) : null}
      {d && tab === "runbooks" ? (
        editing?.kind === "runbook"
          ? <div className={s.stack}><RunbookEditor key={editing.id ?? "new"} initial={editing.form} id={editing.id} rev={editing.rev}
              onSaved={(r, n) => onSaved("runbook", r.id, n)} onCancel={() => setEditing(null)} /></div>
          : <RunbooksView data={d} canWrite={canWrite} selected={selRunbook} onSelect={setSelRunbook} onOpenCase={openCase}
              onEdit={(r) => setEditing({ kind: "runbook", id: r.id, rev: r.rev, form: runbookForm(r) })} onDeleted={() => { setSelRunbook(null); q.reload(); }} />
      ) : null}
    </div>
  );
}

// ── find ──

function FindView({ data, canWrite, initialText, initialScope, onOpenCase, onOpenRunbook, onRecord }: {
  data: OpsKnowledgeResponse; canWrite: boolean; initialText: string; initialScope: { namespace: string; workload: string };
  onOpenCase: (id: string) => void; onOpenRunbook: (id: string) => void; onRecord: (text: string) => void;
}) {
  const { t, locale } = useI18n();
  const call = useOpsCall();
  const [text, setText] = useState(initialText);
  const [ns, setNs] = useState(initialScope.namespace);
  const [wl, setWl] = useState(initialScope.workload);
  const [res, setRes] = useState<OpsSimilarResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const find = async () => {
    if (!text.trim()) return;
    setBusy(true);
    try {
      const scope = Object.fromEntries(Object.entries({ namespace: ns.trim(), workload: wl.trim() }).filter(([, v]) => v));
      setRes(await call<OpsSimilarResponse>("POST", "/api/ops/similar", {}, { text, ...(Object.keys(scope).length ? { scope } : {}) }));
      setErr(null);
    } catch (e) { setErr(errText(t, e)); } finally { setBusy(false); }
  };
  // Came from an alert (?q=): look right away, once
  const ran = useRef(false);
  useEffect(() => { if (!ran.current && initialText.trim()) { ran.current = true; void find(); } }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const caseById = new Map(data.cases.map((c) => [c.id, c]));
  const rbById = new Map(data.runbooks.map((r) => [r.id, r]));
  const when = (iso: string) => new Date(iso).toLocaleDateString(dateLocale(locale));
  const nothing = res && !res.cases.length && !res.runbooks.length;
  return (
    <div className={s.stack}>
      <Panel title={t("ops.kb.find.title")} sub={t("ops.kb.find.sub", { c: data.cases.length, r: data.runbooks.length })}>
        <div className={s.stack}>
          <TextInput label={t("ops.kb.find.text")} rows={6} value={text} onChange={setText} maxLength={20_000} placeholder={t("ops.kb.find.textPh")} />
          <div className={s.toolbar}>
            <TextInput label={t("ops.kb.f.namespace")} value={ns} onChange={setNs} width={200} />
            <TextInput label={t("ops.kb.f.workload")} value={wl} onChange={setWl} width={240} />
            <Button variant="primary" onClick={() => void find()} disabled={busy || !text.trim()}>{busy ? t("ops.kb.find.busy") : t("ops.kb.find.go")}</Button>
            {canWrite && text.trim() ? <Button onClick={() => onRecord(text)}>{t("ops.kb.find.record")}</Button> : null}
          </div>
          {err ? <Notice tone="danger">{err}</Notice> : null}
        </div>
      </Panel>

      {res ? (
        <>
          <Panel title={t("ops.kb.find.signals")}>
            <div className={s.tags}>{res.extracted.length ? <SignalChips t={t} signals={res.extracted} /> : <span className={s.muted}>{t("ops.kb.find.noSignals")}</span>}</div>
          </Panel>

          {nothing ? (
            <EmptyState title={t("ops.kb.find.none")}>{t("ops.kb.find.noneHint")}</EmptyState>
          ) : null}

          {res.suggested.length ? (
            <Panel title={t("ops.kb.helper.title")} sub={t("ops.kb.helper.sub")}>
              <div className={s.helper}>
                {res.suggested.map((sg) => {
                  const rb = rbById.get(sg.runbookId);
                  if (!rb) return null;
                  const u = data.usage[rb.id];
                  return (
                    <div key={rb.id} className={s.helperCard}>
                      <div className={s.itemHead}>
                        <LinkButton onClick={() => onOpenRunbook(rb.id)}>{rb.title}</LinkButton>
                        <span className={s.sub}>
                          {sg.fromCases.length ? t("ops.kb.helper.fromCases", { n: sg.fromCases.length }) : null}
                          {sg.fromCases.length && sg.direct ? " · " : null}
                          {sg.direct ? t("ops.kb.helper.direct") : null}
                          {u ? ` · ${t("ops.kb.rb.usage", { n: u.cases, r: u.resolved })}` : ""}
                        </span>
                      </div>
                      <p className={s.muted}>{excerpt(rb.when, 200)}</p>
                      <StepList t={t} steps={rb.steps.slice(0, 3)} brief maxHeight={160} />
                      {rb.steps.length > 3 ? <span className={s.sub}>{t("ops.kb.helper.more", { n: rb.steps.length - 3 })}</span> : null}
                    </div>
                  );
                })}
                <p className={s.muted}>{t("ops.kb.helper.note")}</p>
              </div>
            </Panel>
          ) : null}

          {res.cases.length ? (
            <Panel title={t("ops.kb.find.cases", { n: res.cases.length })} flush>
              <ul className={s.list}>
                {res.cases.map((m) => {
                  const c = caseById.get(m.id);
                  if (!c) return null;
                  return (
                    <li key={m.id} className={s.item}>
                      <div className={s.itemHead}>
                        <LinkButton onClick={() => onOpenCase(c.id)}>{c.title}</LinkButton>
                        <StatusChip t={t} status={c.status} />
                        <span className={s.sub}>{when(c.occurredAt)}{c.scope.workload ? ` · ${c.scope.namespace ? `${c.scope.namespace}/` : ""}${c.scope.workload}` : ""}</span>
                      </div>
                      <div className={`${s.tags} ${s.sub}`}><MatchWhy t={t} m={m} /></div>
                      <p className={s.fix}><b>{t("ops.kb.find.fixedBy")}</b> {c.resolution ? excerpt(c.resolution, 240) : t("ops.kb.find.noFix")}</p>
                    </li>
                  );
                })}
              </ul>
            </Panel>
          ) : null}

          <AgentSlot />

          {res.runbooks.length ? (
            <Panel title={t("ops.kb.find.runbooks", { n: res.runbooks.length })} flush>
              <ul className={s.list}>
                {res.runbooks.map((m) => {
                  const r = rbById.get(m.id);
                  if (!r) return null;
                  return (
                    <li key={m.id} className={s.item}>
                      <div className={s.itemHead}><LinkButton onClick={() => onOpenRunbook(r.id)}>{r.title}</LinkButton></div>
                      <div className={`${s.tags} ${s.sub}`}><MatchWhy t={t} m={m} /></div>
                      <p className={s.muted}>{excerpt(r.when, 200)}</p>
                    </li>
                  );
                })}
              </ul>
            </Panel>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

/**
 * The agent's place (stage 2 — skeleton, docs/architecture/ops-knowledge.md §8): what it will do and how much it may be
 * sent, disabled until a provider is configured. A draft is never saved by itself.
 */
function AgentSlot() {
  const { t } = useI18n();
  const st = useApiQuery("ops-agent", (token) => fetchJsonWithBearer<OpsAgentStatus>(apiUrl("/api/ops/agent"), token));
  const s0 = st.data;
  if (!s0) return null;
  return (
    <Panel title={t("ops.kb.agent.title")} actions={<Chip level={s0.state === "ready" ? "ok" : "neutral"}>{t(`ops.kb.agent.state.${s0.state}`)}</Chip>}>
      <p className={s.muted}>{t("ops.kb.agent.what")}</p>
      <p className={s.muted}>{t("ops.kb.agent.limits", { c: s0.limits.textChars, k: s0.limits.cases, r: s0.limits.runbooks, f: s0.limits.fieldChars })}</p>
      <div className={s.actions}><Button disabled title={t("ops.kb.agent.disabled")}>{t("ops.kb.agent.draft")}</Button></div>
    </Panel>
  );
}

// ── cases ──

function CasesView({ data, canWrite, selected, onSelect, onOpenRunbook, onEdit, onDeleted, onChanged }: {
  data: OpsKnowledgeResponse; canWrite: boolean; selected: string | null; onSelect: (id: string | null) => void;
  onOpenRunbook: (id: string) => void; onEdit: (c: OpsCase) => void; onDeleted: () => void; onChanged: () => void;
}) {
  const { t, locale } = useI18n();
  const [q, setQ] = useState("");
  const [status, setStatus] = useState<"" | OpsCase["status"]>("");
  const list = filterCases(data.cases, q, status);
  const sel = data.cases.find((c) => c.id === selected) ?? null;
  const when = (iso: string) => new Date(iso).toLocaleString(dateLocale(locale));
  const panes = usePanes(selected);
  if (!data.cases.length) return <div className={s.stack}><EmptyState title={t("ops.kb.case.none")}>{t("ops.kb.case.noneHint")}</EmptyState></div>;
  return (
    <div className={`${s.stack} ${s.layout}`}>
      <Panel className={s.pane} scroll bodyRef={panes.listRef} title={t("ops.kb.tab.cases")} sub={(() => { const f = followUpStats(data.cases, new Date().toLocaleDateString("en-CA")); return f.open || f.done ? t("ops.kb.fu.stats", { o: f.open, x: f.overdue, d: f.done }) : undefined; })()} flush actions={
        <div className={s.toolbar}>
          <SearchInput label={t("ops.kb.search")} value={q} onChange={setQ} />
          <Segmented label={t("ops.kb.f.status")} value={status} onChange={setStatus}
            items={[{ id: "" as const, label: t("ops.kb.all") }, ...(["open", "mitigated", "resolved"] as const).map((x) => ({ id: x, label: t(`ops.kb.status.${x}`) }))]} />
        </div>
      }>
        {list.length ? (
          <ul className={s.list}>
            {list.map((c) => (
              <li key={c.id} className={s.item} data-selected={c.id === selected || undefined}>
                <div className={s.itemHead}>
                  <LinkButton onClick={() => onSelect(c.id === selected ? null : c.id)}>{c.title}</LinkButton>
                  <StatusChip t={t} status={c.status} />
                  <SevBadge t={t} sev={c.severity} />
                </div>
                <span className={s.sub}>
                  {when(c.occurredAt)}{c.scope.clusterName ? ` · ${c.scope.clusterName}` : ""}{c.scope.workload ? ` · ${c.scope.namespace ? `${c.scope.namespace}/` : ""}${c.scope.workload}` : ""}
                  {c.runbookIds.length ? ` · ${t("ops.kb.case.runbooksN", { n: c.runbookIds.length })}` : ""}
                  {c.followUps?.some((f) => f.status === "open") ? ` · ${t("ops.kb.fu.openN", { n: c.followUps.filter((f) => f.status === "open").length })}` : ""}
                </span>
                <p className={s.muted}>{excerpt(c.symptoms)}</p>
              </li>
            ))}
          </ul>
        ) : <EmptyState title={t("ops.kb.noMatch")} />}
      </Panel>
      <div ref={panes.detailRef} className={s.detailPane}>
        {sel ? <CaseDetail key={`${sel.id}:${sel.rev}`} c={sel} data={data} canWrite={canWrite} onOpenRunbook={onOpenRunbook} onEdit={onEdit} onDeleted={onDeleted} onChanged={onChanged} /> : (
          <Panel><p className={s.muted}>{t("ops.kb.pick")}</p></Panel>
        )}
      </div>
    </div>
  );
}

/**
 * List | detail panes: the picked row stays in view inside its list (also when it was opened from elsewhere — ?id=,
 * the find tab, the alert centre); on one column (≤1100px) the detail comes into view, since it sits under the list.
 */
function usePanes(selected: string | null) {
  const listRef = useRef<HTMLDivElement>(null);
  const detailRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!selected) return;
    // only the list box moves (scrollIntoView would also move the page and hide the tabs)
    const box = listRef.current, row = box?.querySelector("[data-selected]");
    if (box && row && box.scrollHeight > box.clientHeight) {
      const b = box.getBoundingClientRect(), r = row.getBoundingClientRect();
      if (r.top < b.top || r.bottom > b.bottom) box.scrollTop += r.top - b.top - 8;
    }
    if (window.matchMedia("(max-width: 1100px)").matches) {
      detailRef.current?.scrollIntoView({ block: "start", behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
    }
  }, [selected]);
  return { listRef, detailRef };
}

function Prose({ title, text }: { title: string; text?: string }) {
  if (!text?.trim()) return null;
  return <DetailSection title={title}><p className={s.prose}>{text}</p></DetailSection>;
}

function useDelete(path: string, id: string, rev: number, onDeleted: () => void) {
  const { t } = useI18n();
  const call = useOpsCall();
  const [armed, setArmed] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const run = async () => {
    if (!armed) { setArmed(true); return; }
    try { await call("DELETE", path, { id, baseRev: String(rev) }); onDeleted(); } catch (e) { setErr(errText(t, e)); setArmed(false); }
  };
  return { armed, err, run };
}

function CaseDetail({ c, data, canWrite, onOpenRunbook, onEdit, onDeleted, onChanged }: {
  c: OpsCase; data: OpsKnowledgeResponse; canWrite: boolean; onOpenRunbook: (id: string) => void; onEdit: (c: OpsCase) => void; onDeleted: () => void; onChanged: () => void;
}) {
  const { t, locale } = useI18n();
  const del = useDelete("/api/ops/cases", c.id, c.rev, onDeleted);
  const call = useOpsCall();
  const [fuErr, setFuErr] = useState<string | null>(null);
  const [fuBusy, setFuBusy] = useState(false);
  // A follow-up done / reopened right here — the case's revision guards it (409 when someone else saved meanwhile)
  const flip = async (id: string) => {
    setFuBusy(true);
    try {
      const form = caseForm(c);
      await call("PUT", "/api/ops/cases", { id: c.id }, caseBody({ ...form, followUps: toggleFollowUp(form.followUps, id, new Date()) }, c.rev));
      setFuErr(null);
      onChanged();
    } catch (e) { setFuErr(errText(t, e)); } finally { setFuBusy(false); }
  };
  const when = (iso?: string) => (iso ? new Date(iso).toLocaleString(dateLocale(locale)) : "—");
  const rbs = c.runbookIds.map((id) => data.runbooks.find((r) => r.id === id)).filter((r): r is OpsRunbook => !!r);
  return (
    <Panel className={s.pane} scroll title={c.title} actions={canWrite ? (
        <div className={s.actions}>
          <Button size="sm" onClick={() => onEdit(c)}>{t("ops.kb.edit")}</Button>
          <Button size="sm" variant="ghost" onClick={() => void del.run()}>{del.armed ? t("ops.kb.deleteConfirm") : t("ops.kb.delete")}</Button>
        </div>
      ) : undefined} footer={<span className={s.sub}>{t("ops.kb.byline", { by: c.updatedBy ?? "—", at: when(c.updatedAt), rev: c.rev })}{c.redactions ? ` · ${t("ops.kb.masked", { n: c.redactions })}` : ""}</span>}>
      <div className={s.detail}>
        <div className={s.tags}><StatusChip t={t} status={c.status} /><SevBadge t={t} sev={c.severity} />{c.tags.map((x) => <span key={x} className={s.sub}>#{x}</span>)}</div>
        <dl className={s.facts}>
          <div><dt>{t("ops.kb.f.occurredAt")}</dt><dd>{when(c.occurredAt)}</dd></div>
          {c.resolvedAt ? <div><dt>{t("ops.kb.f.resolvedAt")}</dt><dd>{when(c.resolvedAt)}</dd></div> : null}
          {c.scope.clusterName ? <div><dt>{t("ops.kb.f.cluster")}</dt><dd>{c.scope.clusterName}</dd></div> : null}
          {c.scope.namespace || c.scope.workload ? <div><dt>{t("ops.kb.f.workload")}</dt><dd>{[c.scope.namespace, c.scope.workload].filter(Boolean).join(" / ")}</dd></div> : null}
          {c.scope.resourceType ? <div><dt>{t("ops.kb.f.resourceType")}</dt><dd>{c.scope.resourceType}</dd></div> : null}
          {c.team ? <div><dt>{t("ops.kb.f.team")}</dt><dd>{c.team}</dd></div> : null}
          {c.source?.kind === "alert" ? <div><dt>{t("ops.kb.f.source")}</dt><dd>{t("ops.kb.f.sourceAlert")}</dd></div> : null}
        </dl>
        <Prose title={t("ops.kb.h.symptoms")} text={c.symptoms} />
        <Prose title={t("ops.kb.f.cause")} text={c.cause} />
        <Prose title={t("ops.kb.h.resolution")} text={c.resolution} />
        <Prose title={t("ops.kb.f.lessons")} text={c.lessons} />
        {c.signals.length ? <DetailSection title={t("ops.kb.f.signals")} meta={c.signals.length}><SignalRows t={t} signals={c.signals} /></DetailSection> : null}
        {rbs.length ? (
          <DetailSection title={t("ops.kb.f.runbooks")} meta={rbs.length}><div className={s.tags}>{rbs.map((r) => <LinkButton key={r.id} onClick={() => onOpenRunbook(r.id)}>{r.title}</LinkButton>)}</div></DetailSection>
        ) : null}
        {c.followUps?.length ? (
          <DetailSection title={t("ops.kb.fu.title")} meta={c.followUps.length}>
            <ul className={s.followUps}>
              {c.followUps.map((f) => (
                <li key={f.id}>
                  {canWrite
                    ? <Toggle checked={f.status === "done"} disabled={fuBusy} onChange={() => void flip(f.id)}>{f.title}</Toggle>
                    : <span>{f.status === "done" ? "✓ " : "○ "}{f.title}</span>}
                  <span className={s.sub}>{[f.owner, f.due ? t("ops.kb.fu.dueOn", { d: f.due }) : "", f.doneAt ? t("ops.kb.fu.doneAt", { at: when(f.doneAt) }) : ""].filter(Boolean).join(" · ")}</span>
                </li>
              ))}
            </ul>
            {fuErr ? <Notice tone="danger">{fuErr}</Notice> : null}
          </DetailSection>
        ) : null}
        {c.reference ? <DetailSection title={t("ops.learn.reference")}><a href={c.reference.url} target="_blank" rel="noreferrer noopener">{c.reference.org} ↗</a></DetailSection> : null}
        <ChangesSection c={c} />
        <EvidenceSection c={c} canWrite={canWrite} onChanged={onChanged} />
        {c.timeline?.length ? (
          <DetailSection title={t("ops.kb.tl.title")} meta={c.timeline.length}>
            <ol className={s.timeline}>
              {c.timeline.map((e, i) => (
                <li key={`${e.at}:${i}`}>
                  <span className={s.tlWhen}>{when(e.at)}</span>
                  <span className={s.tlKind}>{t(`ops.kb.tl.kind.${e.kind}`)}</span>
                  <span className={s.tlText}>{e.text}</span>
                </li>
              ))}
            </ol>
          </DetailSection>
        ) : null}
      </div>
      {del.err ? <Notice tone="danger">{del.err}</Notice> : null}
    </Panel>
  );
}

// ── runbooks ──

function RunbooksView({ data, canWrite, selected, onSelect, onOpenCase, onEdit, onDeleted }: {
  data: OpsKnowledgeResponse; canWrite: boolean; selected: string | null; onSelect: (id: string | null) => void;
  onOpenCase: (id: string) => void; onEdit: (r: OpsRunbook) => void; onDeleted: () => void;
}) {
  const { t, locale } = useI18n();
  const [q, setQ] = useState("");
  const list = filterRunbooks(data.runbooks, q);
  const sel = data.runbooks.find((r) => r.id === selected) ?? null;
  const day = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleDateString(dateLocale(locale)) : null);
  const panes = usePanes(selected);
  if (!data.runbooks.length) return <div className={s.stack}><EmptyState title={t("ops.kb.rb.none")}>{t("ops.kb.rb.noneHint")}</EmptyState></div>;
  return (
    <div className={`${s.stack} ${s.layout}`}>
      <Panel className={s.pane} scroll bodyRef={panes.listRef} title={t("ops.kb.tab.runbooks")} flush actions={<SearchInput label={t("ops.kb.search")} value={q} onChange={setQ} />}>
        {list.length ? (
          <ul className={s.list}>
            {list.map((r) => {
              const u = data.usage[r.id];
              return (
                <li key={r.id} className={s.item} data-selected={r.id === selected || undefined}>
                  <div className={s.itemHead}><LinkButton onClick={() => onSelect(r.id === selected ? null : r.id)}>{r.title}</LinkButton></div>
                  <span className={s.sub}>
                    {t("ops.kb.rb.stepsN", { n: r.steps.length })}
                    {u ? ` · ${t("ops.kb.rb.usage", { n: u.cases, r: u.resolved })} · ${t("ops.kb.rb.lastUsed", { at: day(u.lastUsedAt) ?? "—" })}` : ` · ${t("ops.kb.rb.unused")}`}
                    {r.verifiedAt ? ` · ${t("ops.kb.rb.verified", { at: day(r.verifiedAt)! })}` : ""}
                  </span>
                  <p className={s.muted}>{excerpt(r.when)}</p>
                </li>
              );
            })}
          </ul>
        ) : <EmptyState title={t("ops.kb.noMatch")} />}
      </Panel>
      <div ref={panes.detailRef} className={s.detailPane}>
        {/* keyed: another runbook starts at its top, not at the last one's scroll position */}
        {sel ? <RunbookDetail key={`${sel.id}:${sel.rev}`} r={sel} data={data} canWrite={canWrite} onOpenCase={onOpenCase} onEdit={onEdit} onDeleted={onDeleted} /> : (
          <Panel><p className={s.muted}>{t("ops.kb.pick")}</p></Panel>
        )}
      </div>
    </div>
  );
}

function RunbookDetail({ r, data, canWrite, onOpenCase, onEdit, onDeleted }: {
  r: OpsRunbook; data: OpsKnowledgeResponse; canWrite: boolean; onOpenCase: (id: string) => void; onEdit: (r: OpsRunbook) => void; onDeleted: () => void;
}) {
  const { t, locale } = useI18n();
  const del = useDelete("/api/ops/runbooks", r.id, r.rev, onDeleted);
  const when = (iso?: string) => (iso ? new Date(iso).toLocaleString(dateLocale(locale)) : "—");
  const used = data.cases.filter((c) => c.runbookIds.includes(r.id));
  return (
    <Panel className={s.pane} scroll title={r.title} actions={canWrite ? (
        <div className={s.actions}>
          <Button size="sm" onClick={() => onEdit(r)}>{t("ops.kb.edit")}</Button>
          <Button size="sm" variant="ghost" onClick={() => void del.run()}>{del.armed ? t("ops.kb.deleteConfirm") : t("ops.kb.delete")}</Button>
        </div>
      ) : undefined} footer={<span className={s.sub}>{t("ops.kb.byline", { by: r.updatedBy ?? "—", at: when(r.updatedAt), rev: r.rev })}{r.redactions ? ` · ${t("ops.kb.masked", { n: r.redactions })}` : ""}</span>}>
      <div className={s.detail}>
        {/* the decision a reader makes first: is this the runbook for what I see? */}
        {r.when.trim() ? <DetailSection lead title={t("ops.kb.f.when")}><p className={s.prose}>{r.when}</p></DetailSection> : null}
        <dl className={s.facts}>
          {r.team ? <div><dt>{t("ops.kb.f.team")}</dt><dd>{r.team}</dd></div> : null}
          <div><dt>{t("ops.kb.f.verifiedAt")}</dt><dd>{r.verifiedAt ? when(r.verifiedAt) : t("ops.kb.rb.neverVerified")}</dd></div>
        </dl>
        {r.signals.length ? <DetailSection title={t("ops.kb.f.keywords")} meta={r.signals.length}><SignalRows t={t} signals={r.signals} /></DetailSection> : null}
        <DetailSection title={t("ops.kb.f.steps")} meta={r.steps.length}>
          <StepList t={t} steps={r.steps} maxHeight={220} />
          <p className={s.muted}>{t("ops.kb.commandNote")}</p>
        </DetailSection>
        <Prose title={t("ops.kb.f.rollback")} text={r.rollback} />
        <DetailSection title={t("ops.kb.rb.usedTitle")} meta={used.length}>
          {used.length ? <div className={s.tags}>{used.slice(0, 20).map((c) => <LinkButton key={c.id} onClick={() => onOpenCase(c.id)}>{c.title}</LinkButton>)}</div>
            : <p className={s.muted}>{t("ops.kb.rb.usedNone")}</p>}
        </DetailSection>
      </div>
      {del.err ? <Notice tone="danger">{del.err}</Notice> : null}
    </Panel>
  );
}
